// Worker 线程通信协议 —— 纯类型定义（编译期擦除，Worker 与主进程共用）。
// 注意：本文件用相对路径导入 shared 类型，避免依赖构建系统的别名配置。
import type { StockSeries } from '../../shared/types/stock';
import type { Signal, StrategyId } from '../../shared/types/signal';
import type { StrategyConfig } from '../../shared/types/strategy';
import type { BacktestOptions, BacktestResult } from '../../shared/types/backtest';
import type { LimitUpPoolResult, SentimentResult } from '../../shared/types/ipc';

/**
 * 选股载荷：Worker 直连 SQLite 自己读池（见 dbPool.ts），主进程只传轻量参数，
 * 不再结构化克隆整池（审计 PID-02）。pool 仅在 Worker 不可用/兜底测试时由主进程预取传入。
 */
export interface ScreenerPayload {
  kind: 'screener';
  /** 数据库文件路径（主进程用 app.getPath 算好传入，Worker 无 app 模块）。
   *  仅当未提供 pool 时必需（Worker 直连 SQLite 路径）。 */
  dbPath?: string;
  /** 选股池上限（0 = 用硬顶 5400）；来自 dataService.poolLimit() */
  limit?: number;
  /** 每只取最近 N 根；缺省 SCREEN_BARS */
  recentBars?: number;
  /** 用户保存的策略配置；空数组 = 全部用默认配置 */
  configs: StrategyConfig[];
  /** 截止日期（含当日），缺省 = 序列末根 */
  asOf?: string;
  topN: number;
  /** 兜底/测试用：主进程已读好的池 */
  pool?: StockSeries[];
}

/** 回测载荷：同 ScreenerPayload，Worker 直连 SQLite 读全量历史 */
export interface BacktestPayload {
  kind: 'backtest';
  dbPath?: string;
  /** 回测池上限（0 = 用硬顶 500） */
  limit?: number;
  strategyId: StrategyId;
  /**
   * 策略参数配置（用户「策略配置」页保存的）。
   * ⚠️ v0.9.20 修复：此前本载荷**没有** configs，Worker 用 `allStrategies()` 的**默认参数**跑回测，
   * 完全忽略用户调过的策略参数；而主进程兜底路径 `buildStrategies()` **会**应用配置 →
   * 两条路径结果不一致（Worker 正常=默认参数，Worker 挂了=用户参数）。
   * 传 configs 后与 ScreenerPayload 口径统一，参数敏感度扫描也依赖它。
   */
  configs?: StrategyConfig[];
  options: BacktestOptions;
  range?: { startDate: string; endDate: string };
  /** 兜底/测试用：主进程已读好的池 */
  pool?: StockSeries[];
}

/** 涨停池载荷：Worker 直连 SQLite 流式扫尾部 30 根（strategy/limitup.ts） */
export interface LimitUpPayload {
  kind: 'limitup';
  dbPath?: string;
  /** 池上限（0 = 硬顶 5400） */
  limit?: number;
  /** 指定交易日（缺省 = 末根） */
  asOf?: string;
  /** 兜底/测试用：主进程已读好的池 */
  pool?: StockSeries[];
}

/** 情绪看板载荷（M3）：Worker 直连 SQLite 流式扫（strategy/sentiment.ts），零新数据源 */
export interface SentimentPayload {
  kind: 'sentiment';
  dbPath?: string;
  /** 池上限（0 = 硬顶 5400） */
  limit?: number;
  /** 指定交易日（缺省 = 末根，即最新交易日） */
  asOf?: string;
  /** 情绪曲线回看交易日数（缺省 30） */
  historyDays?: number;
}

export type WorkerPayload = ScreenerPayload | BacktestPayload | LimitUpPayload | SentimentPayload;

export type WorkerRequest = WorkerPayload & { id: number };

export type WorkerResponse =
  | { kind: 'screener'; id: number; ok: true; signals: Signal[] }
  | { kind: 'backtest'; id: number; ok: true; result: BacktestResult }
  | { kind: 'limitup'; id: number; ok: true; result: LimitUpPoolResult }
  | { kind: 'sentiment'; id: number; ok: true; result: SentimentResult }
  | { id: number; ok: false; error: string };
