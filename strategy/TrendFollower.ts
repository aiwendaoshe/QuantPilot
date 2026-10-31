import type { DailyBar, StockMeta } from '../src/shared/types/stock';
import type { Signal } from '../src/shared/types/signal';
import type { StrategyMeta } from '../src/shared/types/strategy';
import { StrategyBase } from './StrategyBase';
import { maSeries, lastDefined, slopeUp, volumeRatio, dmi, resample } from './indicators';
import { computeBreakdown, weightedScore } from './scoring';

/**
 * 策略 A：趋势选股（TrendFollower）
 * 条件：均线多头排列且方向向上；量能确认；DMI 动量过滤（+DI>-DI 且 ADX>阈值）；
 * 股价站上 MA20 且 MA20 向上；月线/周线/日线多周期共振（数据足够时）。
 * 禁止未来函数：generateSignal 仅收到截至当日的 K 线。
 */
export class TrendFollower extends StrategyBase {
  readonly id = 'trendFollower' as const;
  readonly meta: StrategyMeta = {
    id: 'trendFollower',
    name: '趋势选股',
    type: 'trend',
    description:
      '均线多头排列且方向向上，量能确认，DMI 动量过滤，月/周/日多周期共振。',
    defaultParams: {
      maShort: 5,
      maMid: 10,
      maLong: 20,
      maXL: 60,
      volMult: 1.4,
      adxMin: 30,
      holdDays: 18,
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
      { key: 'adxMin', label: 'ADX 阈值', type: 'number', default: 30, min: 15, max: 50, step: 1 },
      { key: 'holdDays', label: '最长持仓(日)', type: 'number', default: 18, min: 1, max: 60, step: 1 },
      { key: 'trailHalfMa', label: '止盈减半仓MA', type: 'number', default: 10, min: 5, max: 60, step: 1 },
      { key: 'trailClearMa', label: '清仓MA', type: 'number', default: 20, min: 10, max: 120, step: 1 },
    ],
  };

  /** 单周期均线多头判定（深度自适应：样本不足时仅用可计算的均线） */
  private timeFrameAligned(bars: DailyBar[]): { bull: boolean; up: number } {
    const periods = [
      this.getParam<number>('maShort', 5),
      this.getParam<number>('maMid', 10),
      this.getParam<number>('maLong', 20),
      this.getParam<number>('maXL', 60),
    ];
    const mas = periods.map((p) => lastDefined(maSeries(bars, p)));
    const avail = mas.filter((m): m is number => m !== null);
    if (avail.length < 2) return { bull: false, up: 0 };
    let bull = true;
    for (let i = 0; i < avail.length - 1; i++) {
      if (!(avail[i] > avail[i + 1])) {
        bull = false;
        break;
      }
    }
    const maArrays = periods.map((p) => maSeries(bars, p));
    let up = 0;
    for (const a of maArrays) {
      if (lastDefined(a) !== null && slopeUp(a)) up++;
    }
    return { bull, up };
  }

  generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null {
    const n = bars.length;
    if (n < this.getParam<number>('maXL', 60) + 1) return null;
    const daily = this.timeFrameAligned(bars);
    if (!daily.bull) return null;

    const lastBar = bars[n - 1];
    const volRatio = volumeRatio(bars, 5);
    if (volRatio < this.getParam<number>('volMult', 1.2)) return null;

    // 价格位置：站上 MA20 且 MA20 向上
    const maL = maSeries(bars, this.getParam<number>('maLong', 20));
    const ma20 = lastDefined(maL);
    if (ma20 === null || !(lastBar.close > ma20 && slopeUp(maL))) return null;

    // 动量过滤
    const d = dmi(bars, 14);
    const plusDI = lastDefined(d.plusDI);
    const minusDI = lastDefined(d.minusDI);
    const adx = lastDefined(d.adx);
    if (plusDI === null || minusDI === null || adx === null) return null;
    if (!(plusDI > minusDI && adx > this.getParam<number>('adxMin', 25))) return null;

    // 多周期共振：周线（必选）+ 月线（数据足够时）
    const weekly = this.timeFrameAligned(resample(bars, 5));
    if (!weekly.bull) return null;
    let tf = '日+周';
    if (n >= 252) {
      const monthly = this.timeFrameAligned(resample(bars, 21));
      if (!monthly.bull) return null;
      tf = '日+周+月';
    }

    const breakdown = computeBreakdown(bars, { patternBonus: 20, sectorChangePct: meta.sectorChangePct });
    return {
      code: meta.code,
      name: meta.name,
      date: lastBar.date,
      strategyId: this.id,
      type: 'trend',
      score: weightedScore(breakdown),
      price: lastBar.close,
      reason: `多周期共振(${tf})·MA多头${daily.up}向上·量比${volRatio.toFixed(2)}·ADX${adx.toFixed(0)}`,
      extra: { ma20, volRatio, plusDI, minusDI, adx, up: daily.up },
      breakdown,
    };
  }

  score(bars: DailyBar[]): number {
    return weightedScore(computeBreakdown(bars, { patternBonus: 20 }));
  }
}
