// ECharts option 构造纯函数（不依赖运行时，仅返回 option 结构）
// 组件层负责 echarts.init / setOption / dispose
import type { EChartsOption } from 'echarts';
import type { DailyBar, SignalMark } from '@shared/types/stock';
import type { ScoreBreakdown, SignalType } from '@shared/types/signal';
import { SIGNAL_TYPE_LABELS, strategyShort } from '@shared/constants/strategies';
import { macd as calcMacd, isLimitUpStrict, limitUpRatio } from '@strategy/indicators';

export const C = {
  up: '#ef4444', // 涨 = 红
  down: '#22c55e', // 跌 = 绿
  grid: '#2a3342',
  text: '#94a3b8',
  ma5: '#f59e0b',
  ma10: '#38bdf8',
  ma20: '#a78bfa',
  ma60: '#f472b6',
};

const TYPE_COLOR: Record<SignalType, string> = {
  trend: '#ef4444',
  reversal: '#a78bfa',
  breakout: '#38bdf8',
  limitdown: '#22c55e',
};

function sma(closes: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    out.push(i >= n - 1 ? +(sum / n).toFixed(2) : null);
  }
  return out;
}

/** 同一交易日可能命中多个策略：聚合出一个中文短标签，避免叠在一起看不清 */
function markLabel(marks: SignalMark[]): string {
  const shorts = [...new Set(marks.map((m) => strategyShort(m.strategyId)))];
  if (shorts.length === 1) return shorts[0];
  if (shorts.length === 2) return shorts.join('/');
  return `信号×${marks.length}`;
}

/**
 * 按交易日聚合信号点：原来每个策略各打一个 pin，同日多策略会完全重叠成一坨。
 * 聚合后每天最多一个 pin，标签用中文短名，并错位高度防压字。
 */
function buildMarkPoints(bars: DailyBar[], marks: SignalMark[]) {
  const barMap = new Map(bars.map((b) => [b.date, b]));
  const grouped = new Map<string, SignalMark[]>();
  for (const m of marks) {
    if (!barMap.has(m.date)) continue;
    const arr = grouped.get(m.date);
    if (arr) arr.push(m);
    else grouped.set(m.date, [m]);
  }

  const dates = [...grouped.keys()].sort();
  return dates.map((date, i) => {
    const group = grouped.get(date)!;
    const bar = barMap.get(date)!;
    const best = group.reduce((a, b) => (b.score > a.score ? b : a));
    const label = markLabel(group);
    const detail = group
      .map((m) => `${strategyShort(m.strategyId)}(${SIGNAL_TYPE_LABELS[m.type]} ${m.score})`)
      .join('  ');
    return {
      name: label,
      coord: [date, bar.high],
      value: `${detail} · ${date}`,
      itemStyle: { color: TYPE_COLOR[best.type] },
      label: {
        show: true,
        formatter: label,
        position: 'top' as const,
        // 三档错位高度：相邻信号的标签不会互相压字
        distance: 4 + (i % 3) * 12,
        color: TYPE_COLOR[best.type],
        fontSize: 10,
        fontWeight: 'bold' as const,
        backgroundColor: 'rgba(17,22,31,0.88)',
        borderColor: TYPE_COLOR[best.type],
        borderWidth: 0,
        borderRadius: 3,
        padding: [1, 3] as [number, number],
      },
    };
  });
}

/**
 * 涨停日标注（v0.9.0）：交易所口径严格判定逐日算涨停，
 * 连板 ≥2 时在三角标下方标注「板n」。与信号 pin（上方）错位防压字。
 */
export function buildLimitUpMarks(bars: DailyBar[], code: string, name = '') {
  interface LimitUpMark {
    name: string;
    coord: [string, number];
    symbol: string;
    symbolSize: number;
    itemStyle: { color: string };
    label?: {
      show: boolean;
      formatter: string;
      position: 'bottom';
      distance: number;
      color: string;
      fontSize: number;
      fontWeight: 'bold';
    };
  }
  const out: LimitUpMark[] = [];
  if (bars.length === 0) return out;
  const ratio = limitUpRatio(code, name);
  let streak = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (isLimitUpStrict(b, ratio)) {
      streak++;
    } else {
      streak = 0;
    }
    const mark: LimitUpMark = {
      name: '涨停',
      coord: [b.date, b.low],
      symbol: 'triangle',
      symbolSize: 7,
      itemStyle: { color: C.up },
    };
    if (streak >= 2) {
      mark.label = {
        show: true,
        formatter: `板${streak}`,
        position: 'bottom',
        distance: 3,
        color: C.up,
        fontSize: 9,
        fontWeight: 'bold',
      };
    }
    out.push(mark);
  }
  return out;
}

/** K 线 + 均线 + 成交量 + MACD 副图 + 信号标记 + 涨停标注（v0.9.0） */
export function buildKLineOption(
  bars: DailyBar[],
  marks: SignalMark[],
  limitUp?: { code: string; name?: string },
): EChartsOption {
  const dates = bars.map((b) => b.date);
  const ohlc = bars.map((b) => [b.open, b.close, b.low, b.high]);
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => ({
    value: b.volume,
    itemStyle: { color: b.close >= b.open ? C.up : C.down },
  }));
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);

  // MACD（国内口径：柱 = (DIF-DEA)×2，柱色 红=今值≥昨值）
  const { dif, dea, macd: macdArr } = calcMacd(bars);
  const macdBars = macdArr.map((v, i) => {
    const prev = i > 0 ? macdArr[i - 1] : null;
    return {
      value: v,
      itemStyle: { color: v !== null && (prev === null || v >= prev) ? C.up : C.down },
    };
  });

  // 涨停日标注（三角标在最低价下方；与上方信号 pin 错位）
  const limitUpMarks = limitUp ? buildLimitUpMarks(bars, limitUp.code, limitUp.name ?? '') : [];

  return {
    backgroundColor: 'transparent',
    animation: false,
    legend: {
      data: ['MA5', 'MA10', 'MA20', 'DIF', 'DEA', 'MACD'],
      textStyle: { color: C.text, fontSize: 11 },
      itemWidth: 12,
      itemHeight: 8,
      top: 2,
    },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    // 三副图：价格 46% / 成交量 12% / MACD 12%
    grid: [
      { left: 56, right: 16, top: 34, height: '46%' },
      { left: 56, right: 16, top: '62%', height: '12%' },
      { left: 56, right: 16, top: '78%', height: '12%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.text },
        splitLine: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { show: false },
      },
      {
        type: 'category',
        gridIndex: 2,
        data: dates,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.text },
      },
    ],
    yAxis: [
      {
        scale: true,
        // 顶部留白：pin 与中文标签画在最高价之上，不留余量会被裁掉
        max: (v: { max: number }) => +(v.max * 1.07).toFixed(2),
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.text },
        splitLine: { lineStyle: { color: C.grid, opacity: 0.4 } },
      },
      {
        gridIndex: 1,
        scale: true,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.text },
        splitLine: { show: false },
      },
      {
        gridIndex: 2,
        scale: true,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.text },
        splitLine: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], start: 60, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 0, height: 14, start: 60, end: 100 },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: ohlc,
        itemStyle: {
          color: C.up,
          color0: C.down,
          borderColor: C.up,
          borderColor0: C.down,
        },
        markPoint: {
          // 信号 pin（上方）+ 涨停三角（下方）混排：symbol/symbolSize 逐项覆盖
          data: [...buildMarkPoints(bars, marks), ...limitUpMarks],
          symbol: 'pin',
          symbolSize: 26,
        },
      },
      { name: 'MA5', type: 'line', data: ma5, smooth: true, showSymbol: false, lineStyle: { color: C.ma5, width: 1 } },
      { name: 'MA10', type: 'line', data: ma10, smooth: true, showSymbol: false, lineStyle: { color: C.ma10, width: 1 } },
      { name: 'MA20', type: 'line', data: ma20, smooth: true, showSymbol: false, lineStyle: { color: C.ma20, width: 1 } },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
      },
      {
        name: 'MACD',
        type: 'bar',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: macdBars,
      },
      { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: dif, showSymbol: false, lineStyle: { color: C.ma10, width: 1 } },
      { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: dea, showSymbol: false, lineStyle: { color: C.ma5, width: 1 } },
    ],
  } as EChartsOption;
}

/** 7 因子评分雷达 */
export function buildRadarOption(breakdown: ScoreBreakdown): EChartsOption {
  return {
    backgroundColor: 'transparent',
    tooltip: {},
    radar: {
      radius: '62%',
      indicator: [
        { name: '趋势', max: 100 },
        { name: '量能', max: 100 },
        { name: '资金', max: 100 },
        { name: '板块', max: 100 },
        { name: '形态', max: 100 },
        { name: '波动', max: 100 },
        { name: '强度', max: 100 },
      ],
      axisName: { color: C.text, fontSize: 10 },
      splitLine: { lineStyle: { color: C.grid } },
      splitArea: { areaStyle: { color: ['transparent', 'transparent'] } },
      axisLine: { lineStyle: { color: C.grid } },
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: [
              breakdown.trend,
              breakdown.volume,
              breakdown.fund,
              breakdown.sector,
              breakdown.pattern,
              breakdown.volatility,
              breakdown.strength,
            ],
            areaStyle: { color: 'rgba(245,158,11,0.3)' },
            lineStyle: { color: C.ma5 },
            itemStyle: { color: C.ma5 },
          },
        ],
      },
    ],
  } as EChartsOption;
}

/** 净值曲线 + 回撤水下图 */
export function buildEquityOption(
  equityCurve: { date: string; equity: number }[],
): EChartsOption {
  const dates = equityCurve.map((e) => e.date);
  const equity = equityCurve.map((e) => e.equity);
  let peak = -Infinity;
  const drawdown = equityCurve.map((e) => {
    peak = Math.max(peak, e.equity);
    return peak > 0 ? +(((e.equity - peak) / peak) * 100).toFixed(2) : 0;
  });

  return {
    backgroundColor: 'transparent',
    legend: { data: ['净值', '回撤%'], textStyle: { color: C.text }, top: 4 },
    tooltip: { trigger: 'axis' },
    grid: [
      { left: 64, right: 16, top: 32, height: '64%' },
      { left: 64, right: 16, top: '76%', height: '16%' },
    ],
    xAxis: [
      { type: 'category', data: dates, axisLine: { lineStyle: { color: C.grid } }, axisLabel: { color: C.text } },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { show: false },
      },
    ],
    yAxis: [
      {
        scale: true,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.text },
        splitLine: { lineStyle: { color: C.grid, opacity: 0.4 } },
      },
      {
        gridIndex: 1,
        axisLine: { lineStyle: { color: C.grid } },
        axisLabel: { color: C.text, formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1] }],
    series: [
      {
        name: '净值',
        type: 'line',
        data: equity,
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.ma5, width: 2 },
        areaStyle: { color: 'rgba(245,158,11,0.12)' },
      },
      {
        name: '回撤%',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: drawdown,
        smooth: true,
        showSymbol: false,
        lineStyle: { color: C.down, width: 1 },
        areaStyle: { color: 'rgba(34,197,94,0.18)' },
      },
    ],
  } as EChartsOption;
}
