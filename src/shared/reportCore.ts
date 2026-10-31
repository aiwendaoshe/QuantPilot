/**
 * 回测报告分析维度（M5）—— **纯函数、零依赖**（仅依赖 Trade 类型）。
 * 放在 src/shared 而非 strategy/，因为渲染层(Backtest.vue)也要用它渲染报告面板，
 * 而 strategy/ 只被 node+worker 编译、且 report.ts 依赖 node:fs 不能进渲染包。
 *
 * 全部是已有数据的**二次聚合**，不引入任何新数据/新假设。口径：
 *  · 分年/月收益 = 权益曲线期初/期末净值比（复利口径），非「年化再平均」。
 *  · 持仓期分布按**交易日**（trades[].holdingDays 已是交易日序号差）。
 *  · 最大回撤区间 = 峰值日→谷底日→(若收复)回到峰值，用于标注「跌在哪一段」。
 */
import type { Trade } from './types/backtest';

// ===========================================================================
// M5：回测报告分析维度（纯聚合，不引入新数据/新假设）
// ===========================================================================

/** 分年收益一行 */
export interface YearlyReturn {
  year: string;
  startEquity: number;
  endEquity: number;
  returnPct: number; // 区间收益率 %（复利口径，非年化再平均）
  trades: number;
}
/** 分月收益一行 */
export interface MonthlyReturn {
  month: string; // YYYY-MM
  returnPct: number;
  startEquity: number;
  endEquity: number;
  trades: number;
}
/** 持仓期分布一档 */
export interface HoldingBucket {
  label: string;
  count: number;
  avgPnlPct: number;
}
/** 最大回撤区间（回撤发生在哪一段） */
export interface DrawdownPeriod {
  peakDate: string;
  troughDate: string;
  recoveredDate: string | null; // null = 至今未收复
  depth: number; // 0-1
  lengthDays: number; // 峰值→谷底交易日数
}
/** 离场原因构成 */
export interface ExitReasonStat {
  reason: string;
  label: string;
  count: number;
  avgPnlPct: number;
}

/** 完整报告维度 */
export interface BacktestReport {
  yearly: YearlyReturn[];
  monthly: MonthlyReturn[];
  holdingDist: HoldingBucket[];
  maxDrawdownPeriod: DrawdownPeriod | null;
  exitReasons: ExitReasonStat[];
  avgHoldingDays: number;
  maxHoldingDays: number;
  bestTradePct: number;
  worstTradePct: number;
}

const EXIT_LABELS: Record<string, string> = {
  stopLoss: '止损',
  holdTimeout: '持仓到期',
  signalExit: '信号离场',
  endOfData: '回测结束强平',
};

/** 分年/月收益：按自然年/月切权益曲线，用「上期末」做基期（复利连续） */
function periodReturns(
  curve: { date: string; equity: number }[],
  trades: Trade[],
  key: (d: string) => string,
): { period: string; startEquity: number; endEquity: number; returnPct: number; trades: number }[] {
  if (curve.length === 0) return [];
  const m = new Map<string, { startIdx: number; endIdx: number }>();
  for (let i = 0; i < curve.length; i++) {
    const k = key((curve[i] as { date: string }).date);
    const rec = m.get(k);
    if (!rec) m.set(k, { startIdx: i, endIdx: i });
    else rec.endIdx = i;
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([period, { startIdx, endIdx }]) => {
    const prev = startIdx > 0 ? (curve[startIdx - 1] as { equity: number }) : (curve[startIdx] as { equity: number });
    const end = curve[endIdx] as { equity: number };
    const ret = prev.equity > 0 ? +(((end.equity - prev.equity) / prev.equity) * 100).toFixed(2) : 0;
    return {
      period,
      startEquity: prev.equity,
      endEquity: end.equity,
      returnPct: ret,
      trades: trades.filter((t) => key(t.entryDate) === period).length,
    };
  });
}

/** 持仓期分布：按交易日分档（holdingDays 已是交易日序号差） */
function buildHoldingDist(trades: Trade[]): HoldingBucket[] {
  const defs: { label: string; lo: number; hi: number; items: Trade[] }[] = [
    { label: '1-2日', lo: 1, hi: 2, items: [] },
    { label: '3-5日', lo: 3, hi: 5, items: [] },
    { label: '6-10日', lo: 6, hi: 10, items: [] },
    { label: '11-20日', lo: 11, hi: 20, items: [] },
    { label: '>20日', lo: 21, hi: Infinity, items: [] },
  ];
  for (const t of trades) {
    const b = defs.find((x) => t.holdingDays >= x.lo && t.holdingDays <= x.hi) ?? (defs[defs.length - 1] as (typeof defs)[number]);
    b.items.push(t);
  }
  return defs.map((b) => ({
    label: b.label,
    count: b.items.length,
    avgPnlPct: b.items.length ? +(b.items.reduce((s, t) => s + t.pnlPct, 0) / b.items.length).toFixed(2) : 0,
  }));
}

/** 最大回撤区间：峰值→谷底→（若收复）回到峰值 */
function buildDrawdownPeriod(curve: { date: string; equity: number }[]): DrawdownPeriod | null {
  if (curve.length < 2) return null;
  let peak = curve[0] as { date: string; equity: number };
  let peakIdx = 0;
  let best = { depth: 0, peakIdx: 0, troughIdx: 0 };
  for (let i = 1; i < curve.length; i++) {
    const p = curve[i] as { date: string; equity: number };
    if (p.equity > peak.equity) {
      peak = p;
      peakIdx = i;
    } else if (peak.equity > 0) {
      const depth = (peak.equity - p.equity) / peak.equity;
      if (depth > best.depth) best = { depth, peakIdx, troughIdx: i };
    }
  }
  if (best.depth <= 0) return null;
  const peakEquity = (curve[best.peakIdx] as { equity: number }).equity;
  let rec = -1;
  for (let i = best.troughIdx; i < curve.length; i++) {
    if ((curve[i] as { equity: number }).equity >= peakEquity) {
      rec = i;
      break;
    }
  }
  return {
    peakDate: (curve[best.peakIdx] as { date: string }).date,
    troughDate: (curve[best.troughIdx] as { date: string }).date,
    recoveredDate: rec >= 0 ? (curve[rec] as { date: string }).date : null,
    depth: +best.depth.toFixed(4),
    lengthDays: best.troughIdx - best.peakIdx,
  };
}

/** 离场原因构成 */
function buildExitReasons(trades: Trade[]): ExitReasonStat[] {
  const m = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = m.get(t.reason) ?? [];
    arr.push(t);
    m.set(t.reason, arr);
  }
  return [...m.entries()]
    .map(([reason, items]) => ({
      reason,
      label: EXIT_LABELS[reason] ?? reason,
      count: items.length,
      avgPnlPct: +(items.reduce((s, t) => s + t.pnlPct, 0) / items.length).toFixed(2),
    }))
    .sort((a, b) => b.count - a.count);
}

/** 主入口：权益曲线 + 成交明细 → 报告维度 */
export function buildReport(
  equityCurve: { date: string; equity: number }[],
  trades: Trade[],
): BacktestReport {
  const holding = trades.map((t) => t.holdingDays);
  const pnl = trades.map((t) => t.pnlPct);
  const yr = periodReturns(equityCurve, trades, (d) => d.slice(0, 4));
  const mo = periodReturns(equityCurve, trades, (d) => d.slice(0, 7));
  return {
    yearly: yr.map((r) => ({ year: r.period, startEquity: r.startEquity, endEquity: r.endEquity, returnPct: r.returnPct, trades: r.trades })),
    monthly: mo.map((r) => ({ month: r.period, returnPct: r.returnPct, startEquity: r.startEquity, endEquity: r.endEquity, trades: r.trades })),
    holdingDist: buildHoldingDist(trades),
    maxDrawdownPeriod: buildDrawdownPeriod(equityCurve),
    exitReasons: buildExitReasons(trades),
    avgHoldingDays: holding.length ? +(holding.reduce((s, d) => s + d, 0) / holding.length).toFixed(1) : 0,
    maxHoldingDays: holding.length ? Math.max(...holding) : 0,
    bestTradePct: pnl.length ? Math.max(...pnl) : 0,
    worstTradePct: pnl.length ? Math.min(...pnl) : 0,
  };
}

