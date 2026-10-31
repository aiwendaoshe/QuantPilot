import type { StrategyId } from './signal';

/** 单笔成交记录 */
export interface Trade {
  code: string;
  /** 股票中文名称（与 code 同行展示，如「sh.600519 贵州茅台」） */
  name: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnlPct: number; // 收益率（含手续费，未计滑点外成本）
  holdingDays: number;
  reason: string; // 'stopLoss' | 'holdTimeout' | 'signalExit'
}

/** 回测参数 */
export interface BacktestOptions {
  initialCapital: number;
  commissionRate: number; // 单边手续费率（如 0.0003）
  slippage: number; // 滑点（比例，如 0.001）
  stopLossPct: number; // 止损比例（如 0.07）
  takeProfitPct: number; // 止盈比例（0 表示不启用）
  tPlusOne: boolean; // 是否 T+1（A 股默认 true）
  holdDays: number; // 最长持仓天数
}

/** 回测结果 */
export interface BacktestResult {
  strategyId: StrategyId;
  startDate: string;
  endDate: string;
  initialCapital: number;
  finalCapital: number;
  equityCurve: { date: string; equity: number }[];
  trades: Trade[];
  winRate: number; // 0-1
  profitFactor: number; // 盈亏比
  maxDrawdown: number; // 0-1
  sharpe: number;
  totalTrades: number;
}

/** 多策略横向对比一行（M5）：同一区间/参数下各跑一次回测的并列结果 */
export interface StrategyCompareRow {
  strategyId: StrategyId;
  name: string;
  /** 命中信号数（该策略在整个区间触发次数） */
  signals: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpe: number;
  finalCapital: number;
  initialCapital: number;
  /** 总收益率 0-1 */
  totalReturn: number;
}

/** 多策略横向对比整页返回（M5） */
export interface StrategyCompareResult {
  startDate: string;
  endDate: string;
  rows: StrategyCompareRow[];
}

/** 参数敏感度扫描一档（M5）：某个参数取某值时的回测表现 */
export interface SensitivityPoint {
  /** 该档的参数值 */
  value: number;
  totalReturn: number; // 0-1
  winRate: number;
  maxDrawdown: number; // 0-1
  sharpe: number;
  totalTrades: number;
}

/** 参数敏感度扫描结果（M5） */
export interface SensitivityResult {
  strategyId: StrategyId;
  paramKey: string;
  paramLabel: string;
  /** 用户当前该参数的取值（结果里标出来，便于对照基准） */
  currentValue: number | null;
  points: SensitivityPoint[];
}
