import type { StockSeries, DailyBar } from '../src/shared/types/stock';
import type {
  Trade,
  BacktestResult,
  BacktestOptions,
} from '../src/shared/types/backtest';
import type { StrategyId } from '../src/shared/types/signal';
import type { StrategyBase } from './StrategyBase';

export interface BacktestRange {
  startDate: string;
  endDate: string;
}

// 注意：持仓天数一律按「交易日」计，不按自然日。
// 自然日口径会让 holdDays=5 在跨越周末时只hold住 3 个交易日，
// 把短线结论系统性扭歪（且从表面看不出来）。
// allDates 是本池出现过的全部交易日，按升序排列，因此「索引差」＝真实持仓交易日数。

/**
 * 通用回测器：多标的、多头、买入首只信号标的。
 * 严格杜绝未来函数：generateSignal 只收到 date<=当日 的 K 线；
 * T+1 时信号在次日开盘成交，否则当日收盘成交。
 */
export function runBacktest(
  strategy: StrategyBase,
  pool: StockSeries[],
  options: BacktestOptions,
  range?: BacktestRange,
): BacktestResult {
  const allDates = Array.from(
    new Set(pool.flatMap((s) => s.bars.map((b) => b.date))),
  ).sort();
  const dateIdx = new Map<string, number>(allDates.map((d, i) => [d, i]));
  // 日期 -> 交易日序号。持仓退出判断与 holdingDays 都以「序号差」计，即真实交易日。
  const idxOf = (d: string): number => dateIdx.get(d) ?? -1;
  const barByDate = new Map<string, Map<string, DailyBar>>();
  const lastBarDate = new Map<string, string>();
  const nameByCode = new Map<string, string>();
  for (const s of pool) {
    const m = new Map<string, DailyBar>();
    for (const b of s.bars) m.set(b.date, b);
    barByDate.set(s.meta.code, m);
    nameByCode.set(s.meta.code, s.meta.name);
    if (s.bars.length) lastBarDate.set(s.meta.code, s.bars[s.bars.length - 1].date);
  }

  // 回测持仓周期由回测选项权威控制（与策略筛选参数解耦）
  const holdDays = Math.max(1, Math.floor(options.holdDays || 5));
  const tradingDates = range
    ? allDates.filter((d) => d >= range.startDate && d <= range.endDate)
    : allDates;

  let cash = options.initialCapital;
  const positions = new Map<string, { entryDate: string; entryPrice: number; qty: number }>();
  const pending: { code: string; date: string }[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const trades: Trade[] = [];

  for (const date of allDates) {
    const inRange = !range || (date >= range.startDate && date <= range.endDate);

    // 1) 执行 T+1 挂单（次日开盘成交）
    if (pending.length) {
      for (const pb of pending) {
        const bm = barByDate.get(pb.code)?.get(date);
        if (bm && !positions.has(pb.code) && cash > 0) {
          const price = bm.open * (1 + options.slippage);
          const qty = Math.floor((cash * 0.95) / (price * 100)) * 100;
          if (qty > 0) {
            cash -= qty * price * (1 + options.commissionRate);
            positions.set(pb.code, { entryDate: date, entryPrice: price, qty });
          }
        }
      }
      pending.length = 0;
    }

    // 2) 持仓退出（止损 / 止盈 / 超时 / 个股数据末根强制平仓）
    for (const [code, pos] of [...positions]) {
      const bm = barByDate.get(code)?.get(date);
      if (!bm) continue;
      const stopPrice = pos.entryPrice * (1 - options.stopLossPct);
      const tpPrice =
        options.takeProfitPct > 0 ? pos.entryPrice * (1 + options.takeProfitPct) : Infinity;
      let exitPrice: number | null = null;
      let reason = '';
      if (date === lastBarDate.get(code)) {
        // 个股数据结束，必须结算，避免持仓在后续无数据日期被权益曲线静默丢弃
        exitPrice = bm.close * (1 - options.slippage);
        reason = 'endOfData';
      } else if (bm.low <= stopPrice) {
        exitPrice = Math.min(bm.open, stopPrice) * (1 - options.slippage);
        reason = 'stopLoss';
      } else if (bm.high >= tpPrice) {
        exitPrice = Math.max(bm.open, tpPrice) * (1 + options.slippage);
        reason = 'takeProfit';
      } else if (idxOf(date) - idxOf(pos.entryDate) >= holdDays) {
        exitPrice = bm.close * (1 - options.slippage);
        reason = 'holdTimeout';
      }
      if (exitPrice !== null) {
        cash += pos.qty * exitPrice * (1 - options.commissionRate);
        // ⚠️ 滑点口径：pos.entryPrice 与 exitPrice 本身已经含了滑点
        // （买入 open*(1+s)、卖出 *(1-s)），所以这里的 (exit-entry)/entry 天然
        // 就是「双边滑点 + 双边佣金」后的净收益率，与上面的资金结算一致。
        // 不要再额外减 2*slippage —— 那是重复扣，实测会把明细与期末资金对不上（偏差约 0.4%/笔）。
        const pnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice - 2 * options.commissionRate;
        trades.push({
          code,
          name: nameByCode.get(code) ?? code,
          entryDate: pos.entryDate,
          entryPrice: pos.entryPrice,
          exitDate: date,
          exitPrice,
          pnlPct,
          holdingDays: idxOf(date) - idxOf(pos.entryDate),
          reason,
        });
        positions.delete(code);
      }
    }

    // 3) 生成信号（仅区间内的交易日才允许买入）
    if (inRange && cash > 0) {
      for (const s of pool) {
        if (positions.has(s.meta.code)) continue;
        const barsUpTo = s.bars.filter((b) => b.date <= date);
        if (barsUpTo.length === 0) continue;
        const sig = strategy.generateSignal(barsUpTo, s.meta);
        if (!sig) continue;
        if (options.tPlusOne) {
          pending.push({ code: s.meta.code, date });
        } else {
          const bm = barByDate.get(s.meta.code)?.get(date);
          if (bm) {
            const price = bm.close * (1 + options.slippage);
            const qty = Math.floor((cash * 0.95) / (price * 100)) * 100;
            if (qty > 0) {
              cash -= qty * price * (1 + options.commissionRate);
              positions.set(s.meta.code, { entryDate: date, entryPrice: price, qty });
            }
          }
        }
      }
    }

    // 4) 记录权益（仅区间日）
    if (inRange) {
      let equity = cash;
      for (const [code, pos] of positions) {
        const bm = barByDate.get(code)?.get(date);
        if (bm) equity += pos.qty * bm.close;
      }
      equityCurve.push({ date, equity });
    }
  }

  const startDate = tradingDates[0] ?? '';
  const endDate = tradingDates[tradingDates.length - 1] ?? '';
  return buildResult(strategy.id, startDate, endDate, options, equityCurve, trades);
}

function buildResult(
  strategyId: StrategyId,
  startDate: string,
  endDate: string,
  options: BacktestOptions,
  equityCurve: { date: string; equity: number }[],
  trades: Trade[],
): BacktestResult {
  const finalCapital = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : options.initialCapital;
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const winRate = trades.length ? wins.length / trades.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
  }

  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) rets.push(equityCurve[i].equity / prev - 1);
  }
  const mean = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const variance = rets.length ? rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return {
    strategyId,
    startDate,
    endDate,
    initialCapital: options.initialCapital,
    finalCapital,
    equityCurve,
    trades,
    winRate,
    profitFactor,
    maxDrawdown,
    sharpe,
    totalTrades: trades.length,
  };
}
