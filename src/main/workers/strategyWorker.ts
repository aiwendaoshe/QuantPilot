// 策略计算 Worker：与 Electron 完全解耦（只用 strategy/ 纯 TS + node:worker_threads），
// 由 tsconfig.worker.json 单独编译为 dist-electron/src/main/workers/strategyWorker.js。
// 禁止在此文件 import 任何 electron 模块。
//
// 性能关键：选股/回测不再依赖主进程把整池结构化克隆传进来（全市场 5400×320≈173 万根，
// 克隆峰值 0.5~1.5GB）。改为 Worker 自己直连同一份 quantpilot.db 流式读、流式算，
// 只把 ~20 条信号回传（审计 PID-02）。
import { parentPort } from 'node:worker_threads';
import { allStrategies } from '../../../strategy/registry';
import { runBacktest } from '../../../strategy/backtest';
import { aggregateSignals } from '../../../strategy/aggregate';
import { computeLimitUpPool, finalizeLimitUpPool, limitUpStreak } from '../../../strategy/limitup';
import { computeSentiment } from '../../../strategy/sentiment';
import {
  openPoolDb,
  streamSeries,
  loadBacktestPool,
  clampPool,
  SQL,
  POOL_HARD_CAP,
  SCREEN_BARS,
} from '../../../strategy/dbPool';
import type { Signal } from '../../../src/shared/types/signal';
import type { StockMeta, StockSeries } from '../../../src/shared/types/stock';
import type { LimitUpPoolResult, LimitUpRow, SentimentResult } from '../../../src/shared/types/ipc';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * M2：板块当日涨幅热力图（code → 所属板块涨跌幅 %）。
 * Worker 直连 SQLite 查 sectors/sector_members，一次性载入小 Map（几千条），
 * 给实时选股的「板块」评分轴提供真值。表不存在/无数据 → 空 Map → 评分回退代理值。
 */
function sectorHeatMap(db: ReturnType<typeof openPoolDb>): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        `SELECT m.code AS code, s.change_pct AS pct
           FROM sector_members m JOIN sectors s ON s.id = m.sector_id`,
      )
      .all() as { code: string; pct: number }[];
    for (const r of rows) {
      // 一票多板块时取第一个（行业板块通常唯一）
      if (!map.has(r.code)) map.set(r.code, Number(r.pct));
    }
  } catch {
    // 表尚未建（首次运行未刷新板块）→ 空 Map，走代理值，不让选股崩
  }
  return map;
}

/** 选股：优先在 Worker 线程计算（不阻塞主进程/渲染进程），
 * Worker 不可用或失败时回退主进程同步计算。
 */
function handleScreener(req: Extract<WorkerRequest, { kind: 'screener' }>): Signal[] {
  const strategies = allStrategies();
  for (const s of strategies) {
    const cfg = req.configs.find((c) => c.id === s.id);
    if (cfg) s.setConfig(cfg);
  }
  // M2：板块当日涨幅热力图（实时选股专用；回测不注入，避免未来函数）
  const heat = req.dbPath ? sectorHeatMap(openPoolDb(req.dbPath)) : new Map<string, number>();
  const withSector = (m: StockMeta): StockMeta =>
    heat.size > 0 ? { ...m, sectorChangePct: heat.get(m.code) ?? null } : m;
  /** 标注该信号的板块轴是否用了真值（供 UI 如实说明） */
  const markSectorReal = (sig: Signal, code: string): void => {
    if (sig.breakdown) sig.sectorReal = heat.has(code);
  };

  // 兜底/测试：主进程已传 pool，则直接就地算（不碰库）
  if (req.pool) {
    const signals: Signal[] = [];
    for (const strat of strategies) {
      if (!strat.getConfig().enabled) continue;
      for (const series of req.pool) {
        const asOf = req.asOf;
        const bars = asOf ? series.bars.filter((b) => b.date <= asOf) : series.bars;
        if (bars.length === 0) continue;
        const sig = strat.generateSignal(bars, withSector(series.meta));
        if (sig) {
          markSectorReal(sig, series.meta.code);
          signals.push(sig);
        }
      }
    }
    return aggregateSignals(signals).slice(0, req.topN);
  }

  // 主路径：Worker 直连 SQLite 流式取池 + 流式算信号（内存仅驻留「当前一只」K 线）
  if (!req.dbPath) throw new Error('[worker] 选股请求既未提供 pool 也未提供 dbPath');
  const db = openPoolDb(req.dbPath);
  const cap = clampPool(req.limit ?? 0, POOL_HARD_CAP);
  const recent = req.recentBars ?? SCREEN_BARS;
  const asOf = req.asOf;
  const signals: Signal[] = [];
  streamSeries(
    db,
    SQL.SCREENING_DESC_SQL,
    [cap],
    (meta, revBars) => {
      const bars = revBars.slice().reverse(); // 逆序取最近 N → 反转为升序
      const slice = asOf ? bars.filter((b) => b.date <= asOf) : bars;
      if (slice.length === 0) return;
      for (const strat of strategies) {
        if (!strat.getConfig().enabled) continue;
        const sig = strat.generateSignal(slice, withSector(meta));
        if (sig) {
          markSectorReal(sig, meta.code);
          signals.push(sig);
        }
      }
    },
    recent,
  );
  return aggregateSignals(signals).slice(0, req.topN);
}

/** 涨停池：Worker 直连 SQLite 流式扫（兜底 pool 由主进程预取传入） */
function handleLimitup(
  req: Extract<WorkerRequest, { kind: 'limitup' }>,
): LimitUpPoolResult {
  if (req.pool) {
    // 兜底/测试路径：主进程已读好的池逐只算（computeLimitUpPool 面向 db，这里内联等价逻辑）
    const rows: LimitUpRow[] = [];
    let latestDate = '';
    for (const series of req.pool) {
      const bars = series.bars;
      if (bars.length > 0 && bars[bars.length - 1].date > latestDate) {
        latestDate = bars[bars.length - 1].date;
      }
      const hit = limitUpStreak(series.meta.code, series.meta.name, bars, req.asOf);
      if (hit) {
        let endIdx = bars.length - 1;
        if (req.asOf) {
          while (endIdx >= 0 && bars[endIdx].date > req.asOf) endIdx--;
        }
        rows.push({
          ...hit,
          industry: series.meta.industry,
          amount: endIdx >= 0 ? bars[endIdx].amount : 0,
        });
      }
    }
    return finalizeLimitUpPool(rows, latestDate, req.asOf);
  }
  if (!req.dbPath) throw new Error('[worker] 涨停池请求既未提供 pool 也未提供 dbPath');
  return computeLimitUpPool(openPoolDb(req.dbPath), {
    limit: req.limit,
    asOf: req.asOf,
  });
}

/** 情绪看板（M3）：Worker 直连 SQLite 流式扫（纯本地算，零新数据源） */
function handleSentiment(
  req: Extract<WorkerRequest, { kind: 'sentiment' }>,
): SentimentResult {
  if (!req.dbPath) throw new Error('[worker] 情绪请求未提供 dbPath');
  return computeSentiment(openPoolDb(req.dbPath), {
    limit: req.limit,
    asOf: req.asOf,
    historyDays: req.historyDays,
  });
}

function handle(req: WorkerRequest): WorkerResponse {
  try {
    if (req.kind === 'screener') {
      return { kind: 'screener', id: req.id, ok: true, signals: handleScreener(req) };
    }
    if (req.kind === 'limitup') {
      return { kind: 'limitup', id: req.id, ok: true, result: handleLimitup(req) };
    }
    if (req.kind === 'sentiment') {
      return { kind: 'sentiment', id: req.id, ok: true, result: handleSentiment(req) };
    }
    const strat = allStrategies().find((s) => s.id === req.strategyId);
    if (!strat) throw new Error(`未知策略: ${req.strategyId}`);
    // 应用用户「策略配置」页保存的参数（v0.9.20 修复：此前回测用默认参数，忽略用户调参；
    // 且与主进程兜底 buildStrategies() 口径不一致）。敏感度扫描也靠它把参数覆盖值传进来。
    if (req.configs) {
      const cfg = req.configs.find((c) => c.id === req.strategyId);
      if (cfg) strat.setConfig(cfg);
    }
    // 兜底/测试：主进程已传 pool 则用之；否则 Worker 直连 SQLite 读全量历史
    let pool: StockSeries[];
    if (req.pool) {
      pool = req.pool;
    } else {
      if (!req.dbPath) throw new Error('[worker] 回测请求既未提供 pool 也未提供 dbPath');
      pool = loadBacktestPool(openPoolDb(req.dbPath), req.limit ?? 0);
    }
    const result = runBacktest(strat, pool, req.options, req.range);
    return { kind: 'backtest', id: req.id, ok: true, result };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

parentPort?.on('message', (req: WorkerRequest) => {
  parentPort?.postMessage(handle(req));
});
