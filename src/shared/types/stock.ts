// 股票基础数据模型 —— 全工程唯一数据源定义，禁止 any

import type { SignalMark } from './signal';

// 供前端从 stock 模块统一取用（KLineChart / chartOptions 均从此导入）
export type { SignalMark };

/** 单根日 K 线（后复权） */
export interface DailyBar {
  date: string; // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 成交量（手）
  amount: number; // 成交额（元）
  preClose: number; // 昨收
}

/** 股票元信息 */
export interface StockMeta {
  code: string; // 'sh.600000' / 'sz.000001'
  name: string;
  industry: string;
  market: string; // 'sh' | 'sz' | 'bj'
  /**
   * 该股所属板块的当日涨跌幅 %（M2 真实板块数据；由 Worker 从 sectors/sector_members 查得后注入）。
   * null/undefined = 无板块数据（板块未刷新、或该股不在任何板块）→ 评分「板块」轴回退价格派生代理值。
   * ⚠️ 只用于**实时选股**；回测的 score() 不注入此字段（用当日板块涨幅评历史=未来函数）。
   */
  sectorChangePct?: number | null;
}

/** 单只股票完整序列（元信息 + 升序 K 线） */
export interface StockSeries {
  meta: StockMeta;
  bars: DailyBar[];
}

/** 个股详情（前端详情页数据：K 线 + 历史上叠加的信号标记） */
export interface StockDetail {
  meta: StockMeta;
  bars: DailyBar[]; // 近 N 根（升序）
  marks: SignalMark[]; // 各策略在该区间内的信号点
}
