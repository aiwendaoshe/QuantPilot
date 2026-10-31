import type { DailyBar, StockMeta } from '../src/shared/types/stock';
import type { Signal } from '../src/shared/types/signal';
import type { StrategyMeta } from '../src/shared/types/strategy';
import { StrategyBase } from './StrategyBase';
import { maSeries, lastDefined, isLimitUp, isOneWordLimitUp } from './indicators';
import { computeBreakdown, weightedScore } from './scoring';

/**
 * 策略 C：N 字反包（NShapeReversal）
 * 前提有涨停激活股性；调整≤3 天、幅度小、重心上移；均线多头排列；
 * 买点一：回踩 MA5 附近低吸；买点二：反包涨停打板确认。
 */
export class NShapeReversal extends StrategyBase {
  readonly id = 'nShapeReversal' as const;
  readonly meta: StrategyMeta = {
    id: 'nShapeReversal',
    name: 'N字反包',
    type: 'reversal',
    description: '涨停激活股性后小步调整，均线多头，回踩 MA5 低吸或反包涨停打板。',
    defaultParams: {
      limitPct: 0.095,
      activationWindow: 12,
      maxAdjustDays: 3,
      adjustMax: 0.07,
      maShort: 5,
      maMid: 10,
      maLong: 20,
      holdDays: 5,
      // 激活质量增强（数据占位：缩量/成交额逻辑后续接）
      activationAmountMin: 1e8,
      shrinkRatio: 0.5,
    },
    paramSchema: [
      { key: 'limitPct', label: '涨停幅度阈值', type: 'number', default: 0.095, min: 0.05, max: 0.21, step: 0.005 },
      { key: 'activationWindow', label: '激活窗口(日)', type: 'number', default: 12, min: 5, max: 30, step: 1 },
      { key: 'maxAdjustDays', label: '最大调整(日)', type: 'number', default: 3, min: 1, max: 8, step: 1 },
      { key: 'adjustMax', label: '最大调整幅度', type: 'number', default: 0.07, min: 0.02, max: 0.12, step: 0.01 },
      { key: 'maShort', label: '短期均线', type: 'number', default: 5, min: 3, max: 20, step: 1 },
      { key: 'maMid', label: '中期均线', type: 'number', default: 10, min: 5, max: 30, step: 1 },
      { key: 'maLong', label: '长期均线', type: 'number', default: 20, min: 10, max: 60, step: 1 },
      { key: 'holdDays', label: '最长持仓(日)', type: 'number', default: 5, min: 1, max: 30, step: 1 },
      { key: 'activationAmountMin', label: '激活最小成交额(元)', type: 'number', default: 1e8, min: 5e7, max: 5e8, step: 1e7 },
      { key: 'shrinkRatio', label: '缩量比例阈值', type: 'number', default: 0.5, min: 0.2, max: 0.9, step: 0.05 },
    ],
  };

  generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null {
    const p = (k: string, f: number) => this.getParam<number>(k, f);
    const limitPct = p('limitPct', 0.095);
    const actWin = p('activationWindow', 12);
    const maxAdj = p('maxAdjustDays', 3);
    const adjustMax = p('adjustMax', 0.05);
    const n = bars.length;
    if (n < 60) return null;
    const last = bars[n - 1];

    // 1) 前提：近 activationWindow 日内有涨停激活股性（非一字）
    let actIdx = -1;
    for (let i = n - 1; i >= Math.max(1, n - actWin); i--) {
      if (isLimitUp(bars[i], limitPct) && !isOneWordLimitUp(bars[i], limitPct)) {
        actIdx = i;
        break;
      }
    }
    if (actIdx < 0) return null;
    const act = bars[actIdx];

    // 2) 调整天数：激活后到今日（含）不超过 maxAdjustDays+1
    const daysSinceAct = n - 1 - actIdx;
    if (daysSinceAct > maxAdj + 1) return null;

    // 3) 调整幅度小、重心上移：今日收盘≥激活收盘*(1-adjustMax)
    if (last.close < act.close * (1 - adjustMax)) return null;

    // 4) 均线多头排列
    const maS = maSeries(bars, p('maShort', 5));
    const maM = maSeries(bars, p('maMid', 10));
    const maL = maSeries(bars, p('maLong', 20));
    const s = lastDefined(maS);
    const m = lastDefined(maM);
    const l = lastDefined(maL);
    if (s === null || m === null || l === null) return null;
    if (!(s > m && m > l)) return null;

    // 5) 买点判定
    let buyPoint = '';
    const ma5 = lastDefined(maSeries(bars, 5));
    const nearMa5 = ma5 !== null && Math.abs(last.close - ma5) / ma5 <= 0.02;
    const isLimit = isLimitUp(last, limitPct);
    if (nearMa5) buyPoint = '回踩MA5低吸';
    else if (isLimit) buyPoint = '反包涨停打板';
    if (!buyPoint) return null;

    const breakdown = computeBreakdown(bars, { patternBonus: 25, sectorChangePct: meta.sectorChangePct });
    return {
      code: meta.code,
      name: meta.name,
      date: last.date,
      strategyId: this.id,
      type: 'reversal',
      score: weightedScore(breakdown),
      price: last.close,
      reason: `N字反包·激活@${act.date}·调整${daysSinceAct}日·${buyPoint}`,
      extra: { actDate: act.date, actClose: act.close, daysSinceAct, buyPoint, ma5: ma5 ?? 0 },
      breakdown,
    };
  }

  score(bars: DailyBar[]): number {
    return weightedScore(computeBreakdown(bars, { patternBonus: 25 }));
  }
}
