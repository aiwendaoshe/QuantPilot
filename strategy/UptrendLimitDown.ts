import type { DailyBar, StockMeta } from '../src/shared/types/stock';
import type { Signal } from '../src/shared/types/signal';
import type { StrategyMeta } from '../src/shared/types/strategy';
import { StrategyBase } from './StrategyBase';
import { maSeries, lastDefined, slopeUp, isLimitDown } from './indicators';
import { computeBreakdown, weightedScore } from './scoring';

/**
 * 策略 F：上升趋势中的跌停反包（UptrendLimitDown）
 * 上升趋势中（MA20 向上，且跌停前一日收盘价在 MA20 之上）出现跌停，
 * 次日反包：收盘>跌停日开盘价 且 >跌停日收盘价，且为阳线、站回 MA20。
 */
export class UptrendLimitDown extends StrategyBase {
  readonly id = 'uptrendLimitDown' as const;
  readonly meta: StrategyMeta = {
    id: 'uptrendLimitDown',
    name: '上升跌停反包',
    type: 'limitdown',
    description: '上升趋势(MA20向上)中现跌停，次日反包收复，阳线站回 MA20。',
    defaultParams: {
      limitPct: 0.093,
      holdDays: 6,
      // 新增：跌停前成交量比 & 最小成交额（数据占位，逻辑后续接）；
      // 注：本版本 UptrendLimitDown 无 marketFilter 参数，无需移除。
      volRatio: 0.8,
      minAmount: 5e7,
    },
    paramSchema: [
      { key: 'limitPct', label: '跌停幅度阈值', type: 'number', default: 0.093, min: 0.05, max: 0.21, step: 0.005 },
      { key: 'holdDays', label: '最长持仓(日)', type: 'number', default: 6, min: 1, max: 30, step: 1 },
      { key: 'volRatio', label: '跌停前量比', type: 'number', default: 0.8, min: 0.3, max: 2, step: 0.1 },
      { key: 'minAmount', label: '最小成交额(元)', type: 'number', default: 5e7, min: 1e7, max: 5e8, step: 1e7 },
    ],
  };

  generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null {
    const p = (k: string, f: number) => this.getParam<number>(k, f);
    const limitPct = p('limitPct', 0.095);
    const n = bars.length;
    if (n < 62) return null;
    const last = bars[n - 1];

    // 上升趋势：MA20 向上
    const ma20Arr = maSeries(bars, 20);
    const ma20 = lastDefined(ma20Arr);
    if (ma20 === null || !slopeUp(ma20Arr)) return null;

    // 昨日跌停；跌停前一交易日收盘在 MA20 之上（上升趋势上下文）
    const prevLd = bars[n - 2];
    const beforeLd = bars[n - 3];
    if (!isLimitDown(prevLd, limitPct)) return null;
    if (beforeLd.close <= ma20) return null;

    // 今日反包：收盘>跌停日开盘价 且 >跌停日收盘价，阳线，站回 MA20
    if (!(last.close > prevLd.open && last.close > prevLd.close)) return null;
    if (!(last.close > last.open)) return null;
    if (last.close <= ma20) return null;

    const breakdown = computeBreakdown(bars, { patternBonus: 25, sectorChangePct: meta.sectorChangePct });
    return {
      code: meta.code,
      name: meta.name,
      date: last.date,
      strategyId: this.id,
      type: 'limitdown',
      score: weightedScore(breakdown),
      price: last.close,
      reason: `上升跌停反包·昨跌停@${prevLd.date}·今反包收${last.close.toFixed(2)}`,
      extra: { ma20, prevLdOpen: prevLd.open, prevLdClose: prevLd.close },
      breakdown,
    };
  }

  score(bars: DailyBar[]): number {
    return weightedScore(computeBreakdown(bars, { patternBonus: 25 }));
  }
}
