import type { SignalType, StrategyId } from '../types/signal';

/** 全部策略注册表（与 StrategyBase 子类一一对应） */
export const STRATEGY_IDS: StrategyId[] = [
  'maBullish',
  'trendFollower',
  'limitUpReversal',
  'nShapeReversal',
  'turtleBreakout',
  'maVolume',
  'uptrendLimitDown',
];

/**
 * 策略中文名映射：前端展示用。
 * 注意：股票名称（StockMeta.name）必须来自真实行情/拟真公司名，
 * 禁止用策略名或场景标签（如"海龟突破标的"）当作股票名，否则卡片会出现
 * 「代码 + 名称」与标题重复的观感。
 */
export const STRATEGY_LABELS: Record<StrategyId, string> = {
  maBullish: '均线多头',
  trendFollower: '趋势选股',
  limitUpReversal: '断板反包',
  nShapeReversal: 'N字反包',
  turtleBreakout: '海龟突破',
  maVolume: '均线放量突破',
  uptrendLimitDown: '上升跌停反包',
};

/**
 * 策略中文短名（2 字符）：K 线图上信号标签专用。
 * 全名在 K 线上会互相压字，缩短后再配合错位高度即可读清。
 */
export const STRATEGY_SHORT: Record<StrategyId, string> = {
  maBullish: '均线',
  trendFollower: '趋势',
  limitUpReversal: '断板',
  nShapeReversal: 'N字',
  turtleBreakout: '海龟',
  maVolume: '放量',
  uptrendLimitDown: '跌停',
};

/** 信号大类中文名（与 SignalTag 配色口径一致） */
export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  trend: '趋势',
  reversal: '反包',
  breakout: '突破',
  limitdown: '跌停反包',
};

/** 兜底：未知策略 id 的展示名 */
export function strategyLabel(id: string): string {
  return STRATEGY_LABELS[id as StrategyId] ?? id;
}

/** 兜底：未知策略 id 的短名 */
export function strategyShort(id: string): string {
  return STRATEGY_SHORT[id as StrategyId] ?? strategyLabel(id).slice(0, 2);
}

/** 评分雷达 7 因子维度键 */
export const SCORE_FACTORS = [
  'trend',
  'volume',
  'fund',
  'sector',
  'pattern',
  'volatility',
  'strength',
] as const;

export type ScoreFactor = (typeof SCORE_FACTORS)[number];
