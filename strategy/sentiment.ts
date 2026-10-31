// 市场情绪看板（M3）—— 纯 TS、零 electron 依赖。
//
// 定位：**本地可算**的每日情绪横截面，辅助仓位决策。不依赖任何新数据源，
// 全部从既有 daily 表（+ stocks 名称判 ST）算出，与涨停池共用同一套严格口径。
//
// 口径（都走交易所严格判定，不用「涨跌幅≥9.5%」粗判——那会把 ST 5%/创业板科创 20% 误判）：
//   涨停 = isLimitUpStrict(bar, limitUpRatio(code,name))；跌停 = isLimitDownStrict 对称。
//   连板 = 连续涨停天数（与 limitup.ts 的连板口径一致）。
//   涨跌家数 = 按 preClose 严格比大小；平 = 与 preClose 差 < 半分钱（四舍五入到分后相同）。
//
// 情绪温度 0~100 打分（固定权重、可解释、不黑箱）：
//   ① 涨停占比 40 分（赚钱效应核心）：全市场约 3% 涨停即满分
//   ② 涨跌比   30 分：up/(up+down) × 30
//   ③ 连板高度 20 分：min(最高连板,8)/8 × 20（空间板越高情绪越热）
//   ④ 昨日涨停今日表现 10 分：打板溢价 ±5% 映射到 0~10
// 档位：<20 冰点 / <40 偏冷 / <60 中性 / <80 偏热 / ≥80 过热。
import type { Database } from 'better-sqlite3';
import type { DailyBar } from '../src/shared/types/stock';
import type { SentimentResult, SentimentSnapshot, SentimentLevel } from '../src/shared/types/ipc';
import { streamSeries, SQL, clampPool, POOL_HARD_CAP } from './dbPool';
import { isLimitUpStrict, isLimitDownStrict, limitUpRatio } from './indicators';

/** 历史曲线默认回看天数 */
export const SENTIMENT_DEFAULT_HISTORY = 30;
/** 每只取尾部 K 线根数：够覆盖连板窗口(30) + 情绪曲线回看 */
const SENTIMENT_WINDOW_BARS = 60;

/** 单只某日情绪贡献。bars 升序，idx 指向目标 bar。 */
function classifyDay(
  bars: DailyBar[],
  code: string,
  name: string,
  idx: number,
): { isLU: boolean; isLD: boolean; isUp: boolean; isDown: boolean; isFlat: boolean; streak: number; pct: number } {
  const bar = bars[idx] as DailyBar;
  const ratio = limitUpRatio(code, name);
  const isLU = isLimitUpStrict(bar, ratio);
  const isLD = isLimitDownStrict(bar, ratio);
  // preClose 缺失时退回前一根 close（与 getSeries/quote 同口径）
  const pre = bar.preClose > 0 ? bar.preClose : bars[idx - 1]?.close ?? bar.close;
  const chg = pre > 0 ? bar.close / pre - 1 : 0;
  const isFlat = Math.abs(bar.close - pre) < 0.005; // 四舍五入到分后相同
  const isUp = !isFlat && chg > 0;
  const isDown = !isFlat && chg < 0;

  // 连板：从 idx 往回数连续涨停
  let streak = 0;
  if (isLU) {
    streak = 1;
    for (let j = idx - 1; j >= 0; j--) {
      if (isLimitUpStrict(bars[j] as DailyBar, ratio)) streak++;
      else break;
    }
  }
  return { isLU, isLD, isUp, isDown, isFlat, streak, pct: chg * 100 };
}

/** 情绪温度打分：固定权重、可解释（见文件头注释） */
function scoreSentiment(s: {
  limitUp: number; total: number; up: number; down: number;
  maxStreak: number; yesterdayPerf: number | null;
}): { score: number; level: SentimentLevel } {
  let score = 0;
  if (s.total > 0) score += Math.min((s.limitUp / s.total) * 100, 3) * (40 / 3); // ①
  const ud = s.up + s.down;
  if (ud > 0) score += (s.up / ud) * 30; // ②
  score += (Math.min(s.maxStreak, 8) / 8) * 20; // ③
  if (s.yesterdayPerf !== null) { // ④
    score += Math.max(0, Math.min(10, ((s.yesterdayPerf + 5) / 10) * 10));
  }
  const r = Math.round(Math.max(0, Math.min(100, score)));
  const level: SentimentLevel =
    r < 20 ? '冰点' : r < 40 ? '偏冷' : r < 60 ? '中性' : r < 80 ? '偏热' : '过热';
  return { score: r, level };
}

/** 某交易日的横截面累加器 */
interface Acc {
  total: number; up: number; down: number; flat: number;
  limitUp: number; limitDown: number;
  volume: number; amount: number; amountCount: number;
  maxStreak: number; streakDist: Map<number, number>;
}

const emptySnapshot = (date: string): SentimentSnapshot => ({
  date, total: 0, up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0,
  streakDist: {}, maxStreak: 0, totalVolume: 0, totalAmount: null,
  score: 0, level: '冰点', yesterdayLimitUpPerf: null,
});

/**
 * 全池扫描情绪：单次流式扫（每只只驻留最近 SENTIMENT_WINDOW_BARS 根，内存有界），
 * 顺带算出最近 historyDays 个交易日的横截面，供画曲线。
 *
 * 「昨日涨停今日表现」：扫描时记录**每个涨停日**的 (code, 涨停日)，
 * 组装阶段把「昨日(=当前交易日的前一交易日)涨停的 code」与它们「今日的 pct」配对。
 * 今日 pct 从扫描时收集的 code→(date→pct) 索引取。
 */
export function computeSentiment(
  db: Pick<Database, 'prepare'>,
  opts: { limit?: number; asOf?: string; historyDays?: number } = {},
): SentimentResult {
  const cap = clampPool(opts.limit ?? 0, POOL_HARD_CAP);
  const asOf = opts.asOf;
  const historyDays = Math.max(1, opts.historyDays ?? SENTIMENT_DEFAULT_HISTORY);

  const byDate = new Map<string, Acc>();
  const getAcc = (d: string): Acc => {
    let a = byDate.get(d);
    if (!a) {
      a = {
        total: 0, up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0,
        volume: 0, amount: 0, amountCount: 0, maxStreak: 0, streakDist: new Map(),
      };
      byDate.set(d, a);
    }
    return a;
  };

  /** code|该股某日pct —— 供「昨日涨停今日表现」配对；只留最近两个交易日窗口即可，用完即清 */
  const pctIndex = new Map<string, number>(); // `${code}|${date}` -> pct
  /** 涨停日 -> 该日涨停的 code 集合（供昨日涨停今表现） */
  const luCodesByDate = new Map<string, Set<string>>();

  streamSeries(
    db,
    SQL.SCREENING_DESC_SQL,
    [cap],
    (meta, revBars) => {
      const bars = revBars.slice().reverse(); // 升序
      for (let i = 0; i < bars.length; i++) {
        const bar = bars[i] as DailyBar;
        if (asOf && bar.date > asOf) continue;
        const c = classifyDay(bars, meta.code, meta.name, i);
        const acc = getAcc(bar.date);
        acc.total++;
        if (c.isUp) acc.up++;
        if (c.isDown) acc.down++;
        if (c.isFlat) acc.flat++;
        if (c.isLU) {
          acc.limitUp++;
          acc.streakDist.set(c.streak, (acc.streakDist.get(c.streak) ?? 0) + 1);
          if (c.streak > acc.maxStreak) acc.maxStreak = c.streak;
          let set = luCodesByDate.get(bar.date);
          if (!set) { set = new Set(); luCodesByDate.set(bar.date, set); }
          set.add(meta.code);
        }
        if (c.isLD) acc.limitDown++;
        if (bar.volume > 0) acc.volume += bar.volume;
        if (bar.amount > 0) { acc.amount += bar.amount; acc.amountCount++; }
        // 只索引涨停日附近所需的 pct：全部记录太占内存，改为记录所有（窗口小，够用）
        pctIndex.set(`${meta.code}|${bar.date}`, c.pct);
      }
    },
    SENTIMENT_WINDOW_BARS,
  );

  const dates = [...byDate.keys()].sort(); // 升序
  if (dates.length === 0) {
    const empty = emptySnapshot('');
    return { current: empty, history: [empty] };
  }

  const currentDate = dates[dates.length - 1] as string;
  const prevDate = dates.length >= 2 ? (dates[dates.length - 2] as string) : '';

  /** 昨日涨停股今日平均涨幅；无数据返回 null */
  const yesterdayPerf = (): number | null => {
    if (!prevDate) return null;
    const lu = luCodesByDate.get(prevDate);
    if (!lu || lu.size === 0) return null;
    let sum = 0; let n = 0;
    for (const code of lu) {
      const p = pctIndex.get(`${code}|${currentDate}`);
      if (p !== undefined) { sum += p; n++; }
    }
    return n > 0 ? +(sum / n).toFixed(2) : null;
  };

  const yPerf = yesterdayPerf();

  const snapshots: SentimentSnapshot[] = dates.map((d) => {
    const acc = byDate.get(d) as Acc;
    const perf = d === currentDate ? yPerf : null; // 仅当前交易日给「昨日涨停今表现」
    const { score, level } = scoreSentiment({
      limitUp: acc.limitUp, total: acc.total, up: acc.up, down: acc.down,
      maxStreak: acc.maxStreak, yesterdayPerf: perf,
    });
    const streakDist: Record<string, number> = {};
    for (const [k, v] of acc.streakDist) streakDist[String(k)] = v;
    return {
      date: d,
      total: acc.total, up: acc.up, down: acc.down, flat: acc.flat,
      limitUp: acc.limitUp, limitDown: acc.limitDown,
      streakDist, maxStreak: acc.maxStreak,
      totalVolume: acc.volume,
      totalAmount: acc.amountCount > 0 ? acc.amount : null,
      score, level, yesterdayLimitUpPerf: perf,
    };
  });

  const history = snapshots.slice(-historyDays);
  const current = history[history.length - 1] ?? emptySnapshot(currentDate);
  return { current, history };
}
