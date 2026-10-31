import type { DailyBar, StockMeta } from '../src/shared/types/stock';
import type { Signal } from '../src/shared/types/signal';
import type { StrategyMeta } from '../src/shared/types/strategy';
import { StrategyBase } from './StrategyBase';
import { maSeries, sma, lastDefined, slopeUp } from './indicators';
import { computeBreakdown } from './scoring';

/**
 * 阶段一验证策略：均线多头 + 量能确认（Strategy A 的简化版）。
 * 条件：MA5>MA10>MA20>MA60 且全部向上，量能 ≥ volMult×MA5量，收盘价站上 MA20。
 */
export class MaBullish extends StrategyBase {
  readonly id = 'maBullish' as const;
  readonly meta: StrategyMeta = {
    id: 'maBullish',
    name: '均线多头',
    type: 'trend',
    description: 'MA5>MA10>MA20>MA60 多头排列且均线向上，量能确认，收盘价站上 MA20。',
    defaultParams: {
      maShort: 5,
      maMid: 10,
      maLong: 20,
      maXL: 60,
      volMult: 1.4,
      holdDays: 15,
      // 移动止盈（数据占位，出场逻辑后续实现）：收盘跌破 trailHalfMa 减半仓，跌破 trailClearMa 清仓
      trailHalfMa: 10,
      trailClearMa: 20,
    },
    paramSchema: [
      { key: 'maShort', label: '短期均线', type: 'number', default: 5, min: 3, max: 20, step: 1 },
      { key: 'maMid', label: '中期均线', type: 'number', default: 10, min: 5, max: 30, step: 1 },
      { key: 'maLong', label: '长期均线', type: 'number', default: 20, min: 10, max: 60, step: 1 },
      { key: 'maXL', label: '超长均线', type: 'number', default: 60, min: 30, max: 120, step: 1 },
      { key: 'volMult', label: '量能倍数', type: 'number', default: 1.2, min: 1, max: 3, step: 0.1 },
      { key: 'holdDays', label: '最长持仓(日)', type: 'number', default: 5, min: 1, max: 30, step: 1 },
      { key: 'trailHalfMa', label: '止盈减半仓MA', type: 'number', default: 10, min: 5, max: 60, step: 1 },
      { key: 'trailClearMa', label: '清仓MA', type: 'number', default: 20, min: 10, max: 120, step: 1 },
    ],
  };

  generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null {
    if (bars.length < this.getParam<number>('maXL', 60) + 1) return null;
    const p = (k: string, f: number) => this.getParam<number>(k, f);

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
    const upCount =
      Number(slopeUp(maS)) + Number(slopeUp(maM)) + Number(slopeUp(maL)) + Number(slopeUp(maX));

    const volMa5 = lastDefined(sma(bars.map((b) => b.volume), 5)) ?? 0;
    const last = bars[bars.length - 1];
    const volRatio = volMa5 > 0 ? last.volume / volMa5 : 0;
    const volOk = volRatio >= p('volMult', 1.2);
    const priceOk = last.close > l;

    if (!(bull && volOk && priceOk)) return null;

    return {
      code: meta.code,
      name: meta.name,
      date: last.date,
      strategyId: this.id,
      type: 'trend',
      score: this.score(bars),
      price: last.close,
      reason: `均线多头(${upCount}/4向上)·量比${volRatio.toFixed(2)}·站上MA${p('maLong', 20)}`,
      extra: { ma5: s, ma20: l, ma60: x, volRatio, upCount },
      breakdown: computeBreakdown(bars, { patternBonus: 15, sectorChangePct: meta.sectorChangePct })
    };
  }

  score(bars: DailyBar[]): number {
    const p = (k: string, f: number) => this.getParam<number>(k, f);
    const maS = maSeries(bars, p('maShort', 5));
    const maM = maSeries(bars, p('maMid', 10));
    const maL = maSeries(bars, p('maLong', 20));
    const maX = maSeries(bars, p('maXL', 60));
    const s = lastDefined(maS);
    const m = lastDefined(maM);
    const l = lastDefined(maL);
    const x = lastDefined(maX);
    if (s === null || m === null || l === null || x === null) return 0;

    const bull = s > m && m > l && l > x;
    const upCount = Number(slopeUp(maS)) + Number(slopeUp(maM)) + Number(slopeUp(maL)) + Number(slopeUp(maX));
    const volMa5 = lastDefined(sma(bars.map((b) => b.volume), 5)) ?? 1;
    const volRatio = bars[bars.length - 1].volume / volMa5;

    let score = bull ? 50 : 0;
    score += upCount * 8;
    score += Math.min(18, Math.max(0, volRatio - 1) * 40);
    return Math.max(0, Math.min(100, Math.round(score)));
  }
}
