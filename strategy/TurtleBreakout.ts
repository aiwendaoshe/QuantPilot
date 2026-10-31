import type { DailyBar, StockMeta } from '../src/shared/types/stock';
import type { Signal } from '../src/shared/types/signal';
import type { StrategyMeta } from '../src/shared/types/strategy';
import { StrategyBase } from './StrategyBase';
import { highest, pctChange } from './indicators';
import { computeBreakdown } from './scoring';

/**
 * 策略 D：海龟突破（TurtleBreakout）
 * 20 日新高 + 成交额过亿 + 阳线防诱多；按涨幅排序输出（评分直接映射涨幅）。
 * 参考 Sequoia-X 的突破思路。
 */
export class TurtleBreakout extends StrategyBase {
  readonly id = 'turtleBreakout' as const;
  readonly meta: StrategyMeta = {
    id: 'turtleBreakout',
    name: '海龟突破',
    type: 'breakout',
    description: '20 日新高 + 成交额过亿 + 阳线防诱多，按涨幅降序输出。',
    defaultParams: {
      breakoutDays: 20,
      minAmount: 1e8,
      bodyMin: 0.03,
      holdDays: 12,
      adxFilter: 25,
      // 移动止盈（数据占位）：跌破 trailClearMa 清仓
      trailClearMa: 20,
    },
    paramSchema: [
      { key: 'breakoutDays', label: '突破周期(日)', type: 'number', default: 20, min: 10, max: 60, step: 1 },
      { key: 'minAmount', label: '最小成交额(元)', type: 'number', default: 1e8, min: 5e7, max: 5e8, step: 1e7 },
      { key: 'bodyMin', label: '阳线实体最小', type: 'number', default: 0.03, min: 0.003, max: 0.05, step: 0.001 },
      { key: 'holdDays', label: '最长持仓(日)', type: 'number', default: 12, min: 1, max: 30, step: 1 },
      { key: 'adxFilter', label: 'ADX 过滤阈值', type: 'number', default: 25, min: 15, max: 50, step: 1 },
      { key: 'trailClearMa', label: '清仓MA', type: 'number', default: 20, min: 10, max: 120, step: 1 },
    ],
  };

  generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null {
    const p = (k: string, f: number) => this.getParam<number>(k, f);
    const bd = p('breakoutDays', 20);
    const minAmt = p('minAmount', 1e8);
    const bodyMin = p('bodyMin', 0.01);
    const n = bars.length;
    if (n < bd + 1) return null;
    const last = bars[n - 1];

    // 20 日新高：今日最高 ≥ 前 bd 日最高（不含今日）
    const highs = bars.map((b) => b.high);
    const hh = highest(highs, bd);
    const priorHigh = hh[n - 2];
    if (priorHigh === null || last.high < priorHigh) return null;

    if (last.amount < minAmt) return null;
    const body = (last.close - last.open) / last.open;
    if (!(last.close > last.open && body > bodyMin)) return null; // 阳线防诱多

    const pct = pctChange(last.close, last.preClose);
    // 按涨幅排序：评分直接反映涨幅，便于 screener 排序
    const score = Math.min(100, Math.round(50 + pct * 200));

    const breakdown = computeBreakdown(bars, { patternBonus: 20, sectorChangePct: meta.sectorChangePct });
    return {
      code: meta.code,
      name: meta.name,
      date: last.date,
      strategyId: this.id,
      type: 'breakout',
      score,
      price: last.close,
      reason: `海龟突破·${bd}日新高·成交额${(last.amount / 1e8).toFixed(2)}亿·涨幅${(pct * 100).toFixed(1)}%`,
      extra: { priorHigh, amount: last.amount, pct },
      breakdown,
    };
  }

  score(bars: DailyBar[]): number {
    const last = bars[bars.length - 1];
    const pct = pctChange(last.close, last.preClose);
    return Math.min(100, Math.round(50 + pct * 200));
  }
}
