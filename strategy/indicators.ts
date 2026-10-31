import type { DailyBar } from '../src/shared/types/stock';

/** 简单移动平均，返回与输入等长的数组，头部不足周期为 null */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 取某字段的 MA 序列（默认 close） */
export function maSeries(
  bars: DailyBar[],
  period: number,
  field: 'open' | 'high' | 'low' | 'close' | 'volume' = 'close',
): (number | null)[] {
  return sma(
    bars.map((b) => b[field]),
    period,
  );
}

/** 指数移动平均（Wilder/RMA 风格：以首 period 均值作种子） */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      sum += values[i];
      continue;
    }
    if (i === period - 1) {
      sum += values[i];
      prev = sum / period;
      out[i] = prev;
      continue;
    }
    prev = values[i] * k + (prev as number) * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 取序列最后一个非 null 值 */
export function lastDefined<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return arr[i];
  }
  return null;
}

/** 均线是否向上（当前值 > lookback 天前的值） */
export function slopeUp(arr: (number | null)[], lookback = 1): boolean {
  const n = arr.length;
  if (n < lookback + 1) return false;
  const a = arr[n - 1 - lookback];
  const b = arr[n - 1];
  return a !== null && b !== null && b > a;
}

/** 滚动最大值（窗口含当前，头部不足周期为 null） */
export function highest(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) {
        m = -Infinity;
        break;
      }
      if (v > m) m = v;
    }
    out[i] = m === -Infinity ? null : m;
  }
  return out;
}

/** 滚动最小值（窗口含当前，头部不足周期为 null） */
export function lowest(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === null) {
        m = Infinity;
        break;
      }
      if (v < m) m = v;
    }
    out[i] = m === Infinity ? null : m;
  }
  return out;
}

/** DMI 指标：+DI / -DI / ADX（Wilder 平滑），返回与输入等长的数组 */
export interface DmiResult {
  plusDI: (number | null)[];
  minusDI: (number | null)[];
  adx: (number | null)[];
}

export function dmi(bars: DailyBar[], period = 14): DmiResult {
  const n = bars.length;
  const plusDI: (number | null)[] = new Array(n).fill(null);
  const minusDI: (number | null)[] = new Array(n).fill(null);
  const adxArr: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return { plusDI, minusDI, adx: adxArr };

  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const hl = cur.high - cur.low;
    const hc = Math.abs(cur.high - prev.close);
    const lc = Math.abs(cur.low - prev.close);
    tr[i] = Math.max(hl, hc, lc);
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    pdm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    mdm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const w = 1 / period;
  const smooth = (prev: number, cur: number) => prev * (1 - w) + cur * w;
  let atr = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  let pdi = pdm.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  let mdi = mdm.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;

  const setAt = (i: number): number => {
    const pdiPct = atr > 0 ? (pdi / atr) * 100 : 0;
    const mdiPct = atr > 0 ? (mdi / atr) * 100 : 0;
    plusDI[i] = pdiPct;
    minusDI[i] = mdiPct;
    return pdiPct + mdiPct > 0 ? (Math.abs(pdiPct - mdiPct) / (pdiPct + mdiPct)) * 100 : 0;
  };

  adxArr[period] = setAt(period);
  for (let i = period + 1; i < n; i++) {
    atr = smooth(atr, tr[i]);
    pdi = smooth(pdi, pdm[i]);
    mdi = smooth(mdi, mdm[i]);
    adxArr[i] = smooth(adxArr[i - 1] as number, setAt(i));
  }
  return { plusDI, minusDI, adx: adxArr };
}

/** 量比：当日成交量 / 近 maPeriod 日平均成交量 */
export function volumeRatio(bars: DailyBar[], maPeriod = 5): number {
  if (bars.length < 2) return 0;
  const volMa = lastDefined(sma(bars.map((b) => b.volume), maPeriod)) ?? 0;
  const last = bars[bars.length - 1].volume;
  return volMa > 0 ? last / volMa : 0;
}

/** 涨跌幅（基于昨收） */
export function pctChange(close: number, preClose: number): number {
  return preClose > 0 ? close / preClose - 1 : 0;
}

/** 是否真涨停：收盘价≈最高价 且 涨幅≥阈值（默认 9.5%，覆盖主板 10% 与创业板 20% 的近似判定） */
export function isLimitUp(bar: DailyBar, pct = 0.095): boolean {
  const up = pctChange(bar.close, bar.preClose) >= pct - 1e-6;
  const atHigh = bar.close >= bar.high - 1e-6;
  return up && atHigh;
}

/** 是否跌停 */
export function isLimitDown(bar: DailyBar, pct = 0.095): boolean {
  const down = pctChange(bar.close, bar.preClose) <= -pct + 1e-6;
  const atLow = bar.close <= bar.low + 1e-6;
  return down && atLow;
}

/** 是否一字涨停（开盘即封板、全天无波动）—— 反包战法需排除 */
export function isOneWordLimitUp(bar: DailyBar, pct = 0.095): boolean {
  return (
    isLimitUp(bar, pct) &&
    Math.abs(bar.open - bar.high) < 1e-6 &&
    Math.abs(bar.open - bar.low) < 1e-6
  );
}

/** 统计 [start, end] 闭区间内涨停次数 */
export function countLimitUp(bars: DailyBar[], start: number, end: number, pct = 0.095): number {
  let c = 0;
  for (let i = Math.max(0, start); i <= Math.min(bars.length - 1, end); i++) {
    if (isLimitUp(bars[i], pct)) c++;
  }
  return c;
}

/** 滚动标准差（用于波动率/布林），返回与输入等长数组 */
export function rollingStd(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

/** 年化波动率（基于日收益标准差，252 交易日） */
export function annualizedVolatility(bars: DailyBar[], period = 20): number {
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    rets.push(bars[i].close / bars[i - 1].close - 1);
  }
  if (rets.length < period) return 0;
  const std = lastDefined(rollingStd(rets, period)) ?? 0;
  return std * Math.sqrt(252);
}

// ---------------------------------------------------------------------------
// 涨停池（v0.9.0）：交易所口径的严格涨停判定 + MACD 指标
// ---------------------------------------------------------------------------

/** 涨停幅度上限：sh.60/sz.00 主板 10%、sz.30 创业板 20%、sh.688 科创板 20%、名称含 ST 一律 5% */
export function limitUpRatio(code: string, name: string): number {
  if (name.includes('ST')) return 0.05;
  if (code.startsWith('sz.3') || code.startsWith('sh.68')) return 0.2;
  return 0.1;
}

/** 跌停幅度上限（与涨停对称；主板非 ST 10%，ST 5%，创业/科创 20%） */
export function limitDownRatio(code: string, name: string): number {
  return limitUpRatio(code, name);
}

/**
 * 交易所口径涨停判定（稳健版，涨停池用）：
 * 规则 A（精确）：close >= round(preClose × (1+ratio), 2) —— 不复权/前复权基准日（f=1）时与交易所完全一致；
 * 规则 B（兜底）：涨幅 ≥ ratio - 0.0018 且 收盘=最高 —— 覆盖历史前复权价整体缩放导致的
 *   round 漂移（±0.005 元经复权因子放缩后可达 ±0.0015 比率），代价是「光脚收盘恰好差一分」
 *   的极端形态可能误判（罕见），页面口径说明中已披露。
 */
export function isLimitUpStrict(bar: DailyBar, ratio: number): boolean {
  if (bar.preClose <= 0) return false;
  const limitPrice = Math.round(bar.preClose * (1 + ratio) * 100) / 100;
  // 上界护栏（v0.9.1）：收盘价不可能高于涨停价（前复权漂移最多差 round 的半分钱）。
  // 缺这条时，ST 名称时点错位会把 +6%/+10% 的普通上涨误标成 5% 涨停（2026-09-30 实证 7 只假阳性）
  if (bar.close > limitPrice + 0.005 + 1e-9) return false;
  if (bar.close >= limitPrice - 1e-9) return true;
  // 规则 B：比率兜底（复权漂移 ≤ 0.005/pre ≈ 0.0015，取 0.0018 留裕量）
  const chg = bar.close / bar.preClose - 1;
  return chg >= ratio - 0.0018 && bar.close >= bar.high - 1e-6;
}

/** 交易所口径跌停判定：close <= round(preClose × (1-ratio), 2) */
export function isLimitDownStrict(bar: DailyBar, ratio: number): boolean {
  if (bar.preClose <= 0) return false;
  const limitPrice = Math.round(bar.preClose * (1 - ratio) * 100) / 100;
  // 下界护栏（v0.9.1）：与涨停对称——跌幅超过上限半个分钱以上不可能是跌停价
  if (bar.close < limitPrice - 0.005 - 1e-9) return false;
  return bar.close <= limitPrice + 1e-9;
}

/** 交易所口径一字涨停：收盘涨停 且 开盘=最高=最低（全天无波动） */
export function isOneWordLimitUpStrict(bar: DailyBar, ratio: number): boolean {
  return (
    isLimitUpStrict(bar, ratio) &&
    Math.abs(bar.open - bar.high) < 1e-6 &&
    Math.abs(bar.open - bar.low) < 1e-6
  );
}

/** MACD 结果（与输入等长数组，头部不足周期为 null） */
export interface MacdResult {
  dif: (number | null)[];
  dea: (number | null)[];
  macd: (number | null)[];
}

/**
 * MACD（国内行情软件口径）：EMA 用 SMA 种子（与 ema() 一致），
 * DIF = EMA(close, fast) - EMA(close, slow)；
 * DEA = EMA(DIF, signal)；MACD 柱 = (DIF - DEA) × 2。
 */
export function macd(bars: DailyBar[], fast = 12, slow = 26, signal = 9): MacdResult {
  const n = bars.length;
  const dif: (number | null)[] = new Array(n).fill(null);
  const dea: (number | null)[] = new Array(n).fill(null);
  const macdArr: (number | null)[] = new Array(n).fill(null);
  if (n < slow) return { dif, dea, macd: macdArr };

  const closes = bars.map((b) => b.close);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  // DIF：两条 EMA 均有效的区间（从 slow-1 起）
  const difValid: number[] = [];
  const difIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f !== null && s !== null) {
      dif[i] = f - s;
      difValid.push(f - s);
      difIdx.push(i);
    }
  }
  // DEA：对 DIF 的有效段做 EMA(signal)（SMA 种子），再映射回原下标
  const deaSeg = ema(difValid, signal);
  for (let k = 0; k < difIdx.length; k++) {
    const d = deaSeg[k];
    if (d !== null) {
      const i = difIdx[k];
      dea[i] = d;
      const dv = dif[i];
      if (dv !== null) macdArr[i] = (dv - d) * 2;
    }
  }
  return { dif, dea, macd: macdArr };
}

/**
 * K 线重采样：每 step 根合并为一根（周线 step≈5，月线 step≈21）。
 * open=首根开盘，close=末根收盘，high/low 取区间极值，量/额累加。用于多周期共振。
 */
export function resample(bars: DailyBar[], step: number): DailyBar[] {
  const out: DailyBar[] = [];
  if (step <= 0) return out;
  for (let i = 0; i < bars.length; i += step) {
    const chunk = bars.slice(i, i + step);
    if (chunk.length === 0) continue;
    const open = chunk[0].open;
    const close = chunk[chunk.length - 1].close;
    const high = Math.max(...chunk.map((b) => b.high));
    const low = Math.min(...chunk.map((b) => b.low));
    const volume = chunk.reduce((s, b) => s + b.volume, 0);
    const amount = chunk.reduce((s, b) => s + b.amount, 0);
    const preClose = chunk[0].preClose;
    out.push({
      date: chunk[chunk.length - 1].date,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
      amount,
      preClose: +preClose.toFixed(2),
    });
  }
  return out;
}
