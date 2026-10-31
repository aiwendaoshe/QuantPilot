import type { DailyBar, StockMeta } from '../src/shared/types/stock';
import type { Signal } from '../src/shared/types/signal';
import type { StrategyMeta } from '../src/shared/types/strategy';
import { StrategyBase } from './StrategyBase';
import {
  maSeries,
  lastDefined,
  slopeUp,
  isLimitUp,
  isOneWordLimitUp,
  countLimitUp,
} from './indicators';
import { computeBreakdown, weightedScore } from './scoring';

/**
 * 策略 B：断板反包（LimitUpReversal）
 * 首板质量过滤（真涨停非一字、5 日内仅此一板、量能>前日 1.2 倍、振幅>3%）；
 * 回调守住关键位（最低价≥首板开盘价 95%、最大回撤≤5%）；趋势保护（站上 MA20 且向上）；
 * 时间窗口：首板后 2-5 个交易日；信号：反包日收盘>前一日阴线开盘价 且 >首板收盘价。
 */
export class LimitUpReversal extends StrategyBase {
  readonly id = 'limitUpReversal' as const;
  readonly meta: StrategyMeta = {
    id: 'limitUpReversal',
    name: '断板反包',
    type: 'reversal',
    description:
      '首板质量过滤 + 回调守住关键位 + 趋势保护，首板后 2-5 日反包时触发。',
    defaultParams: {
      limitPct: 0.095,
      lookback: 5,
      maxPullback: 0.07,
      minOpenGuard: 0.94,
      volMult: 1.3,
      holdDays: 5,
      // 首板质量增强（数据占位：封板时间/换手率当前日级 K 线数据缺失，逻辑后续接）
      firstBoardAmountMin: 2e8,
      firstBoardSealMinutesMax: 60,
      firstBoardTurnoverMin: 0.05,
      firstBoardTurnoverMax: 0.15,
    },
    paramSchema: [
      { key: 'limitPct', label: '涨停幅度阈值', type: 'number', default: 0.095, min: 0.05, max: 0.21, step: 0.005 },
      { key: 'lookback', label: '首板观察窗口(日)', type: 'number', default: 5, min: 3, max: 10, step: 1 },
      { key: 'maxPullback', label: '最大回撤', type: 'number', default: 0.07, min: 0.02, max: 0.1, step: 0.01 },
      { key: 'minOpenGuard', label: '开盘价守护', type: 'number', default: 0.94, min: 0.9, max: 0.99, step: 0.01 },
      { key: 'volMult', label: '首板量能倍数', type: 'number', default: 1.3, min: 1, max: 3, step: 0.1 },
      { key: 'holdDays', label: '最长持仓(日)', type: 'number', default: 5, min: 1, max: 30, step: 1 },
      { key: 'firstBoardAmountMin', label: '首板最小成交额(元)', type: 'number', default: 2e8, min: 5e7, max: 1e9, step: 1e7 },
      { key: 'firstBoardSealMinutesMax', label: '首板封板最晚(分钟·相对9:30)', type: 'number', default: 60, min: 0, max: 120, step: 5 },
      { key: 'firstBoardTurnoverMin', label: '首板最小换手率', type: 'number', default: 0.05, min: 0.01, max: 0.2, step: 0.01 },
      { key: 'firstBoardTurnoverMax', label: '首板最大换手率', type: 'number', default: 0.15, min: 0.05, max: 0.3, step: 0.01 },
    ],
  };

  generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null {
    const p = (k: string, f: number) => this.getParam<number>(k, f);
    const limitPct = p('limitPct', 0.095);
    const lookback = p('lookback', 5);
    const maxPullback = p('maxPullback', 0.05);
    const minOpenGuard = p('minOpenGuard', 0.95);
    const volMult = p('volMult', 1.2);
    const n = bars.length;
    if (n < 60) return null;
    const last = bars[n - 1];

    // 1) 找最近首板（非一字、5 日仅此一板、振幅>3%、量能>前日 1.2 倍）
    let boardIdx = -1;
    for (let i = n - 1; i >= 1; i--) {
      const b = bars[i];
      if (!isLimitUp(b, limitPct)) continue;
      if (isOneWordLimitUp(b, limitPct)) continue;
      if (countLimitUp(bars, i - (lookback - 1), i, limitPct) !== 1) continue;
      const amp = (b.high - b.low) / b.low;
      if (amp <= 0.03) continue;
      if (b.volume < bars[i - 1].volume * volMult) continue;
      boardIdx = i;
      break;
    }
    if (boardIdx < 0) return null;

    // 2) 时间窗口：首板后 2-5 个交易日
    const gap = n - 1 - boardIdx;
    if (gap < 2 || gap > 5) return null;
    const board = bars[boardIdx];

    // 3) 回调守住关键位：区间最低价≥首板开盘价*95%，最大回撤≤5%
    let minLow = Infinity;
    let minCloseAfter = Infinity;
    for (let i = boardIdx + 1; i < n; i++) {
      minLow = Math.min(minLow, bars[i].low);
      minCloseAfter = Math.min(minCloseAfter, bars[i].close);
    }
    if (minLow < board.open * minOpenGuard) return null;
    const drawdown = (board.close - minCloseAfter) / board.close;
    if (drawdown > maxPullback) return null;

    // 4) 趋势保护：站上 MA20 且 MA20 向上
    const ma20Arr = maSeries(bars, 20);
    const ma20 = lastDefined(ma20Arr);
    if (ma20 === null) return null;
    if (!(last.close > ma20 && slopeUp(ma20Arr))) return null;

    // 5) 反包：当日收盘>前一日阴线开盘价 且 >首板收盘价
    const prev = bars[n - 2];
    const prevYin = prev.close < prev.open;
    if (!prevYin) return null;
    if (!(last.close > prev.open && last.close > board.close)) return null;

    const breakdown = computeBreakdown(bars, { patternBonus: 25, sectorChangePct: meta.sectorChangePct });
    return {
      code: meta.code,
      name: meta.name,
      date: last.date,
      strategyId: this.id,
      type: 'reversal',
      score: weightedScore(breakdown),
      price: last.close,
      reason: `断板反包·首板@${board.date}·回撤${(drawdown * 100).toFixed(1)}%·站MA20`,
      extra: {
        boardDate: board.date,
        boardClose: board.close,
        boardOpen: board.open,
        gap,
        drawdown,
        ma20,
      },
      breakdown,
    };
  }

  score(bars: DailyBar[]): number {
    return weightedScore(computeBreakdown(bars, { patternBonus: 25 }));
  }
}
