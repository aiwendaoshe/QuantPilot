import type { DailyBar, StockMeta } from '../src/shared/types/stock';
import type { Signal } from '../src/shared/types/signal';
import type { StrategyMeta } from '../src/shared/types/strategy';
import { StrategyBase } from './StrategyBase';
import { maSeries, sma, lastDefined, slopeUp } from './indicators';
import { computeBreakdown, weightedScore } from './scoring';

/**
 * 策略 E：均线放量突破（MaVolume）
 * 均线多头排列且全部向上 + 成交量突破 5 日均量 1.5 倍 + 收盘价站上 MA20。
 * （策略 A 的简化动量版，去掉 DMI/多周期，强调量能爆发）
 */
export class MaVolume extends StrategyBase {
  readonly id = 'maVolume' as const;
  readonly meta: StrategyMeta = {
    id: 'maVolume',
    name: '均线放量突破',
    type: 'trend',
    description: '均线多头排列且全部向上，成交量突破 5 日均量 1.5 倍，收盘价站上 MA20。',
    defaultParams: {
      maShort: 5,
      maMid: 10,
      maLong: 20,
      maXL: 60,
      volMult: 1.6,
      holdDays: 16,
      // 移动止盈（数据占位，出场逻辑后续实现）：收盘跌破 trailHalfMa 减半仓，跌破 trailClearMa 清仓
      trailHalfMa: 10,
      trailClearMa: 20,
    },
    paramSchema: [
      { key: 'maShort', label: '短期均线', type: 'number', default: 5, min: 3, max: 20, step: 1 },
      { key: 'maMid', label: '中期均线', type: 'number', default: 10, min: 5, max: 30, step: 1 },
      { key: 'maLong', label: '长期均线', type: 'number', default: 20, min: 10, max: 60, step: 1 },
      { key: 'maXL', label: '超长均线', type: 'number', default: 60, min: 30, max: 120, step: 1 },
      { key: 'volMult', label: '量能倍数', type: 'number', default: 1.6, min: 1, max: 3, step: 0.1 },
      { key: 'holdDays', label: '最长持仓(日)', type: 'number', default: 16, min: 1, max: 30, step: 1 },
      { key: 'trailHalfMa', label: '止盈减半仓MA', type: 'number', default: 10, min: 5, max: 60, step: 1 },
      { key: 'trailClearMa', label: '清仓MA', type: 'number', default: 20, min: 10, max: 120, step: 1 },
    ],
  };

  generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null {
    const p = (k: string, f: number) => this.getParam<number>(k, f);
    const n = bars.length;
    if (n < p('maXL', 60) + 1) return null;
    const maS = maSeries(bars, p('maShort', 5));
    const maM = maSeries(bars, p('maMid', 10));
    const maL = maSeries(bars, p('maLong', 20));
    const maX = maSeries(bars, p('maXL', 60));
    const s = lastDefined(maS);
    const m = lastDefined(maM);
    const l = lastDefined(maL);
    const x = lastDefined(maX);
    if (s === null || m === null || l === null || x === null) return null;

    const bull = s > m && m > l && l > x;
    const up =
      Number(slopeUp(maS)) +
      Number(slopeUp(maM)) +
      Number(slopeUp(maL)) +
      Number(slopeUp(maX));
    const volMa5 = lastDefined(sma(bars.map((b) => b.volume), 5)) ?? 0;
    const last = bars[n - 1];
    const volRatio = volMa5 > 0 ? last.volume / volMa5 : 0;
    if (!(bull && volRatio >= p('volMult', 1.5) && last.close > l)) return null;

    const breakdown = computeBreakdown(bars, { patternBonus: 15, sectorChangePct: meta.sectorChangePct });
    return {
      code: meta.code,
      name: meta.name,
      date: last.date,
      strategyId: this.id,
      type: 'trend',
      score: weightedScore(breakdown),
      price: last.close,
      reason: `均线放量突破·MA多头${up}/4·量比${volRatio.toFixed(2)}`,
      extra: { ma20: l, volRatio, up },
      breakdown,
    };
  }

  score(bars: DailyBar[]): number {
    return weightedScore(computeBreakdown(bars, { patternBonus: 15 }));
  }
}
