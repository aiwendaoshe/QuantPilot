import type { DailyBar } from '../src/shared/types/stock';
import type { ScoreBreakdown } from '../src/shared/types/signal';
import {
  maSeries,
  lastDefined,
  slopeUp,
  volumeRatio,
  annualizedVolatility,
  pctChange,
} from './indicators';

/**
 * 7 因子评分分解：趋势强度 / 量能配合 / 资金流向 / 板块热度 / 技术形态 / 波动率 / 相对强度。
 * 资金流向为代理值（无真实主力净流入数据源）。
 * 板块热度（M2）：**实时选股**传 `sectorChangePct`（该股所属板块当日真实涨幅，来自 sectors 表）
 * → 用真值；没传（板块未刷新 / 回测 / 该股无板块）→ 回退价格派生代理值（当日涨幅×200）。
 * 回测**绝不注入** sectorChangePct：用「当日板块涨幅」去评历史 bar 是未来函数。
 */
export function computeBreakdown(
  bars: DailyBar[],
  opts?: { patternBonus?: number; sectorChangePct?: number | null },
): ScoreBreakdown {
  const last = bars[bars.length - 1];

  // 趋势强度：均线多头 + 方向
  const maS = maSeries(bars, 5);
  const maM = maSeries(bars, 10);
  const maL = maSeries(bars, 20);
  const maX = maSeries(bars, 60);
  const s = lastDefined(maS);
  const m = lastDefined(maM);
  const l = lastDefined(maL);
  const x = lastDefined(maX);
  let trend = 0;
  if (s && m && l && x) {
    const bull = s > m && m > l && l > x;
    const up = Number(slopeUp(maS)) + Number(slopeUp(maM)) + Number(slopeUp(maL)) + Number(slopeUp(maX));
    trend = (bull ? 40 : 0) + up * 15;
  }

  // 量能配合：量比归一
  const vr = volumeRatio(bars, 5);
  const volume = Math.min(100, Math.round(Math.max(0, vr - 1) * 60 + (vr >= 1 ? 20 : 0)));

  // 资金流向（代理）：近 5 日 (close-open)/open 之和
  let fundSum = 0;
  for (let i = Math.max(1, bars.length - 5); i < bars.length; i++) {
    fundSum += pctChange(bars[i].close, bars[i].open);
  }
  const fund = Math.min(100, Math.max(0, Math.round(50 + fundSum * 300)));

  // 板块热度（M2）：
  //  - 有真实板块涨幅：用**板块刻度** ×16 映射（板块日涨跌幅常态 ±0.5~3%，×16 让 ±3% 铺满 0~100，
  //    分数有区分度）。刻意不用原代理的 ×200——那是给「个股当日涨幅(±1%)」调的，
  //    套到板块(+2%)上会瞬间打满/打穿 0/100，轴退化成 0/100 二值、失去意义。
  //  - 无真实板块（未刷新/无归属/回测）：回退原价格派生代理（个股当日涨幅 ×200，保持旧行为）。
  const realSector = opts?.sectorChangePct;
  const sector =
    typeof realSector === 'number'
      ? Math.min(100, Math.max(0, Math.round(50 + realSector * 16)))
      : Math.min(100, Math.max(0, Math.round(50 + pctChange(last.close, last.preClose) * 200)));

  // 技术形态：由策略命中时给出 patternBonus
  const pattern = Math.min(100, Math.max(0, 50 + (opts?.patternBonus ?? 0)));

  // 波动率：越低越好
  const vol = annualizedVolatility(bars, 20);
  const volatility = Math.min(100, Math.max(0, Math.round(100 - vol * 400)));

  // 相对强度：近 20 日收益
  const ret20 = bars.length > 20 ? pctChange(last.close, bars[bars.length - 21].close) : 0;
  const strength = Math.min(100, Math.max(0, Math.round(50 + ret20 * 200)));

  return { trend, volume, fund, sector, pattern, volatility, strength };
}

/** 7 因子加权综合评分（0-100），权重之和 = 1 */
export function weightedScore(b: ScoreBreakdown): number {
  const w = {
    trend: 0.25,
    volume: 0.15,
    fund: 0.1,
    sector: 0.1,
    pattern: 0.15,
    volatility: 0.1,
    strength: 0.15,
  };
  const s =
    b.trend * w.trend +
    b.volume * w.volume +
    b.fund * w.fund +
    b.sector * w.sector +
    b.pattern * w.pattern +
    b.volatility * w.volatility +
    b.strength * w.strength;
  return Math.max(0, Math.min(100, Math.round(s)));
}
