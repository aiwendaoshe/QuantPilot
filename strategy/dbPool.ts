import { createRequire } from 'node:module';
import type { Database, Statement } from 'better-sqlite3';
import type { DailyBar, StockMeta, StockSeries } from '../src/shared/types/stock';

// 选股/回测取池的「数据库直读」层：Worker 线程直接连同一份 quantpilot.db，
// 主进程只传 {dbPath, limit, recentBars}，彻底免去「主进程读全池 → 结构化克隆整池」
// 传给 Worker 的 1.73M 对象序列化开销（审计 PID-02）。本文件是纯 TS、零 electron 依赖，
// 主进程兜底路径与 Worker 计算路径共用同一套批量取池逻辑（PID-07）。

/** 选股池上限硬顶：对齐沪深 A 股全市场（约 5400 只）。 */
export const POOL_HARD_CAP = 5400;
/** 回测池上限（回测要读全量历史，比选股池更重） */
export const BACKTEST_POOL_CAP = 500;
/** 选股时每只股票取最近 N 根 K 线（策略最长需约 250 交易日样本） */
export const SCREEN_BARS = 320;

/** 把上限收敛成实际可用值：0 表示不限制，但仍受硬顶保护 */
export function clampPool(limit: number, cap: number): number {
  if (limit === 0) return cap;
  return Math.min(limit, cap);
}

/** 批量取「选股池」的 SQL：按 (code,date) 主键索引逆序取，无需窗口函数/排序，
 *  内存由调用方按 perCodeLimit 截断到最近 N 根。 */
const SCREENING_DESC_SQL = `
SELECT s.code AS code, s.name AS name, s.industry AS industry, s.market AS market,
       d.date AS date, d.open AS open, d.high AS high, d.low AS low, d.close AS close,
       d.volume AS volume, d.amount AS amount, d.preClose AS preClose
FROM daily d
JOIN (SELECT code, name, industry, market
        FROM stocks WHERE code IN (SELECT DISTINCT code FROM daily)
        ORDER BY code LIMIT ?) s ON s.code = d.code
ORDER BY d.code, d.date DESC`;

/** 批量取「回测池」的 SQL：按 (code,date) 升序全量历史 */
const BACKTEST_ASC_SQL = `
SELECT s.code AS code, s.name AS name, s.industry AS industry, s.market AS market,
       d.date AS date, d.open AS open, d.high AS high, d.low AS low, d.close AS close,
       d.volume AS volume, d.amount AS amount, d.preClose AS preClose
FROM daily d
JOIN (SELECT code, name, industry, market
        FROM stocks WHERE code IN (SELECT DISTINCT code FROM daily)
        ORDER BY code LIMIT ?) s ON s.code = d.code
ORDER BY d.code, d.date ASC`;

type Row = StockMeta & DailyBar;

/**
 * 流式取池：按 code 分组，逐组回调 onSeries，内存仅驻留「当前一只」的 K 线
 * （配合 Worker 逐组算信号，整体内存有界，不再一次性吃进 1.73M 行）。
 * @param perCodeLimit 每只最多保留的 K 线数（按 SQL 的排序方向取前 N）；省略=全量
 */
export function streamSeries(
  db: Pick<Database, 'prepare'>,
  sql: string,
  params: unknown[],
  onSeries: (meta: StockMeta, bars: DailyBar[]) => void,
  perCodeLimit?: number,
): void {
  const stmt = db.prepare(sql) as Statement<unknown[]>;
  const iter = stmt.iterate(...params) as Iterable<Row>;
  let cur: { meta: StockMeta; bars: DailyBar[]; count: number } | null = null;
  for (const r of iter) {
    if (!cur || cur.meta.code !== r.code) {
      if (cur) onSeries(cur.meta, cur.bars);
      cur = {
        meta: { code: r.code, name: r.name, industry: r.industry, market: r.market },
        bars: [],
        count: 0,
      };
    }
    if (perCodeLimit === undefined || cur.count < perCodeLimit) {
      cur.bars.push({
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        amount: r.amount,
        preClose: r.preClose,
      });
      cur.count++;
    }
  }
  if (cur) onSeries(cur.meta, cur.bars);
}

/** 主进程兜底用的「选股池」：批量取最近 recentBars 根（升序返回） */
export function loadScreeningPool(
  db: Pick<Database, 'prepare'>,
  limit: number,
  recentBars: number,
): StockSeries[] {
  const cap = clampPool(limit, POOL_HARD_CAP);
  const out: StockSeries[] = [];
  streamSeries(
    db,
    SCREENING_DESC_SQL,
    [cap],
    (meta, bars) => out.push({ meta, bars: bars.slice().reverse() }),
    recentBars,
  );
  return out;
}

/** 主进程兜底用的「回测池」：批量取全量历史（升序返回） */
export function loadBacktestPool(db: Pick<Database, 'prepare'>, limit: number): StockSeries[] {
  const cap = clampPool(limit, BACKTEST_POOL_CAP);
  const out: StockSeries[] = [];
  streamSeries(db, BACKTEST_ASC_SQL, [cap], (meta, bars) => out.push({ meta, bars }));
  return out;
}

const dbCache = new Map<string, Database>();

/**
 * 供 Worker 直连 SQLite：打开与主进程同一份 quantpilot.db。
 * 优先只读打开（避免与 Python 抓取写锁竞争）；文件尚不存在（极端首跑）时退回普通打开。
 * 连接按 dbPath 缓存复用（同一 Worker 进程内 screener/backtest 共享一次打开）。
 */
export function openPoolDb(dbPath: string): Database {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const nodeRequire = createRequire(__filename);
  const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3');
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    // 首跑且库未建好（理论不会发生，main 启动时 dataService.init 已建库）
    db = new Database(dbPath);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');
  dbCache.set(dbPath, db);
  return db;
}

/** 导出 SQL 常量，供 Worker 直接流式计算（避免二次依赖） */
export const SQL = { SCREENING_DESC_SQL, BACKTEST_ASC_SQL };
