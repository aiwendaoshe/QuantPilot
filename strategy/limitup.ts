// 涨停池扫描（v0.9.0）—— 纯 TS、零 electron 依赖。
// Worker 主路径与主进程兜底共用同一份实现（对齐 PID-07 约定）。
// 算法口径：
//   涨停判定 = 交易所口径 isLimitUpStrict（close >= round(preClose×(1+ratio), 2)）；
//   连板数 streak = 从目标日往前数连续涨停天数；
//   N天M板 = 以目标日为右界、最多 maxWindow 个交易日的窗口内涨停总数与窗口天数
//           （窗口向左延伸，把断板前更早的涨停也圈进来；10 天以上只标连板数）。
import type { Database } from 'better-sqlite3';
import type { DailyBar } from '../src/shared/types/stock';
import type { LimitUpRow, LimitUpPoolResult } from '../src/shared/types/ipc';
import { streamSeries, SQL, clampPool, POOL_HARD_CAP } from './dbPool';
import {
  isLimitUpStrict,
  isOneWordLimitUpStrict,
  limitUpRatio,
} from './indicators';

/** 每只取尾部 N 根 K 线：覆盖 N天M板 窗口（10 交易日）+ EMA/MACD 余量 */
export const LIMITUP_WINDOW_BARS = 30;
/** N天M板 窗口上限（交易日） */
export const LIMITUP_MAX_WINDOW = 10;

/** 单只：算 asOf 日的连板数 + N天M板。bars 升序；asOf 缺省=末根。非涨停日返回 null。 */
export function limitUpStreak(
  code: string,
  name: string,
  barsAsc: DailyBar[],
  asOf?: string,
  maxWindow = LIMITUP_MAX_WINDOW,
): Omit<LimitUpRow, 'industry' | 'amount'> | null {
  // 次新股上市初期无涨跌幅限制（创业板/科创板前 5 日），样本太短直接跳过防误判
  if (barsAsc.length < 6) return null;
  const ratio = limitUpRatio(code, name);

  // asOf 截断：只用 ≤ asOf 的 K 线（无未来函数铁律）
  let end = barsAsc.length - 1;
  if (asOf) {
    while (end >= 0 && barsAsc[end].date > asOf) end--;
    if (end < 0) return null;
  }

  const bar = barsAsc[end];
  if (!isLimitUpStrict(bar, ratio)) return null;

  // 逐日预计算涨停标记（0..end）
  const isLU: boolean[] = new Array(end + 1).fill(false);
  for (let i = 0; i <= end; i++) isLU[i] = isLimitUpStrict(barsAsc[i], ratio);

  // 连板数：从 end 往回数连续涨停
  let streak = 0;
  let j = end;
  while (j >= 0 && isLU[j]) {
    streak++;
    j--;
  }
  const firstDate = barsAsc[j + 1].date;

  // N天M板：以 end 为右界向左扩窗，把断板前更早的涨停圈进来（窗口 ≤ maxWindow 个交易日）
  let left = end - streak + 1; // 当前连板起点
  while (left > 0) {
    // 在 [max(left - maxWindow + 1, 0), left - 2] 内向左找第一个涨停日
    // （left-1 若是涨停则 streak 应该更大，与连板回数结果矛盾，跳过）
    let k = -1;
    const lo = Math.max(left - maxWindow + 1 + (end - left), 0);
    for (let t = left - 2; t >= lo; t--) {
      if (isLU[t]) {
        k = t;
        break;
      }
    }
    if (k < 0) break;
    const span = end - k + 1;
    if (span > maxWindow) break;
    left = k;
  }
  const windowDays = end - left + 1;
  let windowBoards = 0;
  for (let i = left; i <= end; i++) {
    if (isLU[i]) windowBoards++;
  }

  return {
    code,
    name,
    close: bar.close,
    changePct: bar.preClose > 0 ? +(bar.close / bar.preClose - 1).toFixed(6) : 0,
    streak,
    windowDays,
    windowBoards,
    firstDate,
    isOneWord: isOneWordLimitUpStrict(bar, ratio),
    stSuspect: name.includes('ST'),
  };
}

/** 排序 + 分布统计收尾（Worker 兜底路径与主扫描共用，保证口径一致） */
export function finalizeLimitUpPool(
  rows: LimitUpRow[],
  latestDate: string,
  asOf?: string,
): LimitUpPoolResult {
  // 排序：连板数 desc → 成交额 desc → 代码 asc
  rows.sort(
    (a, b) => b.streak - a.streak || b.amount - a.amount || a.code.localeCompare(b.code),
  );

  const distribution = { first: 0, two: 0, threePlus: 0, maxStreak: 0 };
  let stSuspectCount = 0;
  for (const r of rows) {
    if (r.streak === 1) distribution.first++;
    else if (r.streak === 2) distribution.two++;
    else distribution.threePlus++;
    if (r.streak > distribution.maxStreak) distribution.maxStreak = r.streak;
    if (r.stSuspect) stSuspectCount++;
  }

  // 实际判定交易日：请求 asOf 或池内最新交易日
  const date = asOf && asOf <= latestDate ? asOf : latestDate;
  return { date, rows, distribution, stSuspectCount };
}

/**
 * 全池扫描涨停池：复用既有 SCREENING_DESC_SQL + streamSeries 流式管道（零新 SQL），
 * 每只只驻留尾部 LIMITUP_WINDOW_BARS 根，内存有界。
 */
export function computeLimitUpPool(
  db: Pick<Database, 'prepare'>,
  opts: { limit?: number; asOf?: string },
): LimitUpPoolResult {
  const cap = clampPool(opts.limit ?? 0, POOL_HARD_CAP);
  const asOf = opts.asOf;
  const rows: LimitUpRow[] = [];
  let latestDate = '';

  streamSeries(
    db,
    SQL.SCREENING_DESC_SQL,
    [cap],
    (meta, revBars) => {
      const bars = revBars.slice().reverse(); // 逆序最近 N 根 → 升序
      if (bars.length > 0) {
        // 记录池内实际最新交易日（asOf 缺省时=末根日期；指定 asOf 时=≤asOf 的最新交易日）
        const last = bars[bars.length - 1].date;
        if (last > latestDate) latestDate = last;
      }
      const hit = limitUpStreak(meta.code, meta.name, bars, asOf);
      if (hit) {
        // 成交额取目标日当根
        let endIdx = bars.length - 1;
        if (asOf) {
          while (endIdx >= 0 && bars[endIdx].date > asOf) endIdx--;
        }
        rows.push({
          ...hit,
          industry: meta.industry,
          amount: endIdx >= 0 ? bars[endIdx].amount : 0,
        });
      }
    },
    LIMITUP_WINDOW_BARS,
  );

  // 排序/分布收尾（与 Worker 兜底路径共用同一函数，保证口径一致）
  return finalizeLimitUpPool(rows, latestDate, asOf);
}
