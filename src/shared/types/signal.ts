import type { StockMeta } from './stock';

/** 信号大类（用于 Dashboard 标签配色） */
export type SignalType = 'trend' | 'reversal' | 'breakout' | 'limitdown';

/** 策略唯一标识（与 constants/strategies.ts 保持一致） */
export type StrategyId =
  | 'maBullish'
  | 'trendFollower'
  | 'limitUpReversal'
  | 'nShapeReversal'
  | 'turtleBreakout'
  | 'maVolume'
  | 'uptrendLimitDown';

/** 选股信号 */
export interface Signal {
  code: string;
  name: string;
  date: string; // 触发日期
  strategyId: StrategyId;
  type: SignalType;
  score: number; // 0-100 综合评分
  price: number; // 触发价
  reason: string; // 触发理由（人类可读）
  extra: Record<string, number | string>;
  breakdown?: ScoreBreakdown; // 7 因子雷达评分（供前端雷达图）
  /**
   * 「板块」评分轴是否用了真实板块数据（M2）。
   * true = 该股所属板块有当日涨幅真值（M2 板块已刷新）；false/undefined = 回退价格派生代理值
   * （板块未刷新 / 该股无板块 / 回测场景）。UI 据此如实标注，不让用户误以为板块轴总是真的。
   */
  sectorReal?: boolean;
}

/** 选股结果附带评分雷达维度（供前端雷达图） */
export interface ScoreBreakdown {
  trend: number; // 趋势强度
  volume: number; // 量能配合
  fund: number; // 资金流向
  sector: number; // 板块热度
  pattern: number; // 技术形态
  volatility: number; // 波动率
  strength: number; // 相对强度
}

/** 个股 K 线图上叠加的信号标记点 */
export interface SignalMark {
  date: string; // 信号触发日
  strategyId: StrategyId;
  type: SignalType;
  score: number; // 0-100
}

export type { StockMeta };
