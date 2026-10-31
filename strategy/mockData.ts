import type { DailyBar, StockMeta, StockSeries } from '../src/shared/types/stock';

// 确定性伪随机，保证 mock 数据可复现
function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * 离线兜底用的拟真公司名池。
 * 注意：mock 场景下必须给「看着像股票中文名」的名字，不能拿策略场景标签
 * （如"海龟突破标的"）当名称，否则前端出现「代码 + 名称」时会与标题重复。
 */
export const MOCK_NAME_POOL: readonly string[] = [
  '华芯科技',
  '鼎晟新材',
  '中泰智造',
  '宏远电子',
  '天启能源',
  '泽润环保',
  '瑞恒精工',
  '星火传媒',
  '金晟生物',
  '联创智控',
  '东方智联',
  '泰和重工',
  '恒锐精密',
  '远航物流',
  '昌达机电',
  '新亚材料',
  '中科微电',
  '九州新能',
  '海通智造',
  '北辰光电',
  '长信材料',
  '云启数据',
  '德宇重工',
  '天成数科',
];

/** 按索引取拟真公司名（超出池长度则循环并加序号后缀，保证唯一可辨） */
export function mockName(index: number): string {
  const n = MOCK_NAME_POOL.length;
  const base = MOCK_NAME_POOL[index % n];
  const round = Math.floor(index / n);
  return round === 0 ? base : `${base}${round + 1}`;
}

// ---------------------------------------------------------------------------
// 可控 K 线构造器（与 phase2-demo 同源）：严格满足涨停/跌停/反包判定，
// 日期按交易日推进（跳过周末），preClose 记录真实前收（涨跌幅口径正确）。
//
// 日期策略：先按「交易日」生成全部序列，再整体平移，使最后一根落在最近一个
// 交易日（今天或往前最近的工作日）。这样 mock 数据的日期与真实盘面同步，
// 不会出现「状态条写 2026-09-30、K 线却停在 2024-01」的名不副实。
// ---------------------------------------------------------------------------
/** 最近一个交易日（跳过周六周日；不处理法定节假日，mock 场景足够） */
export function lastTradingDay(from = new Date()): Date {
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

/**
 * 生成 count 个「以 end 结尾、向前回溯」的交易日日期串（升序返回）。
 * 全部跳过周六周日，保证序列中不含非交易日。
 */
export function genTradingDates(count: number, end: Date): string[] {
  const out: string[] = [];
  const cur = new Date(end.getTime());
  while (out.length < count) {
    const w = cur.getUTCDay();
    if (w !== 0 && w !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return out.reverse();
}

class BarBuilder {
  readonly bars: DailyBar[] = [];
  private price: number;
  private date: Date;
  constructor(
    public readonly code: string,
    public readonly name: string,
    startPrice: number,
    startDate = new Date(Date.UTC(2023, 0, 3)),
  ) {
    this.price = startPrice;
    this.date = startDate;
  }
  /** 推进到下一个交易日（跳过周六/周日） */
  private nextTradingDay(): void {
    do {
      this.date = new Date(this.date.getTime() + 86400000);
    } while (this.date.getUTCDay() === 0 || this.date.getUTCDay() === 6);
  }
  day(opts: {
    pct?: number;
    range?: number;
    vol?: number;
    limit?: 'up' | 'down';
    openGap?: number;
  }): BarBuilder {
    const preClose = this.price;
    const r = opts.range ?? 0.01;
    let open: number;
    let close: number;
    let high: number;
    let low: number;
    if (opts.limit === 'up') {
      close = preClose * 1.0999;
      open = preClose * (1 + (opts.openGap ?? -0.02));
      high = close;
      low = Math.min(open, close) * (1 - r * 0.5);
    } else if (opts.limit === 'down') {
      close = preClose * 0.9001;
      open = preClose * (1 + (opts.openGap ?? 0));
      low = close;
      high = Math.max(open, close) * (1 + r * 0.5);
    } else {
      close = preClose * (1 + (opts.pct ?? 0));
      open = preClose * (1 + (opts.openGap ?? 0));
      high = Math.max(open, close) * (1 + r * 0.5);
      low = Math.min(open, close) * (1 - r * 0.5);
    }
    const volume = Math.round(1_000_000 * (opts.vol ?? 1));
    this.bars.push({
      date: this.date.toISOString().slice(0, 10),
      open: +open.toFixed(3),
      high: +high.toFixed(3),
      low: +low.toFixed(3),
      close: +close.toFixed(3),
      volume,
      amount: volume * close,
      preClose: +preClose.toFixed(3),
    });
    this.price = close;
    this.nextTradingDay();
    return this;
  }
  fill(days: number, pct: number, vol = 1): BarBuilder {
    for (let i = 0; i < days; i++) this.day({ pct, vol });
    return this;
  }
  build(industry = '合成样本'): StockSeries {
    const meta: StockMeta = {
      code: this.code,
      name: this.name,
      industry,
      market: this.code.split('.')[0],
    };
    return { meta, bars: this.alignToToday() };
  }

  /**
   * 把 K 线日期重新锚定为「末端对齐最近交易日」，只改日期不改价格。
   *
   * 注意：不能做简单的整体平移 —— 原始序列是按交易日生成的（已跳过周末），
   * 平移一段非 7 倍数的天数后，原本被跳过的周六周日会重新落进序列里。
   * 正确做法是按「倒推交易日」重建：从最近交易日出发，向前逐格回溯，
   * 每个格子都跳过周末，保持「全是交易日」的性质。
   */
  private alignToToday(): DailyBar[] {
    const n = this.bars.length;
    if (n === 0) return this.bars;
    const dates = genTradingDates(n, lastTradingDay());
    return this.bars.map((b, i) => ({ ...b, date: dates[i] }));
  }
}

/** 生成股票代码（沪 600xxx / 深 000xxx，符合真实代码段） */
function codeOf(index: number): string {
  const isSh = index % 2 === 0;
  const num = isSh ? 600000 + index * 7 : 1 + index * 7;
  return `${isSh ? 'sh' : 'sz'}.${String(num).padStart(6, '0')}`;
}

/** 形态 A：强趋势上行（均线多头 + 周期放量）→ 命中 maBullish / trendFollower / maVolume */
function buildTrendSeries(index: number, seed: number): StockSeries {
  const r = rng(seed);
  const sb = new BarBuilder(codeOf(index), mockName(index), 10 + r() * 15);
  sb.fill(150, 0.0025 + r() * 0.001, 1.0); // 长底仓，满足月线共振样本量
  for (let c = 0; c < 14; c++) {
    sb.fill(8, 0.005 + r() * 0.001, 1.0);
    sb.day({ pct: 0.004, vol: 1.6 + r() * 0.5 }); // 放量确认
  }
  sb.day({ pct: 0.003, vol: 1.5 + r() * 0.4 }); // 末根放量，确保当日可命中
  return sb.build('强势成长');
}

/** 形态 B：首板 + 回调 + 反包 → 命中 limitUpReversal */
function buildLimitUpReversalSeries(index: number, seed: number): StockSeries {
  const r = rng(seed);
  const sb = new BarBuilder(codeOf(index), mockName(index), 10 + r() * 8);
  sb.fill(80, 0.003, 1.0);
  for (let c = 0; c < 7; c++) {
    sb.fill(12, 0.003, 1.0);
    sb.day({ limit: 'up', openGap: -0.02, range: 0.04, vol: 1.4 }); // 首板
    sb.day({ pct: -0.003, vol: 0.8 }); // 回调阴线
    sb.day({ pct: 0.012, openGap: -0.01, vol: 1.0 }); // 反包
  }
  return sb.build('题材活跃');
}

/** 形态 C：激活涨停 + 缩量调整 + 反包涨停 → 命中 nShapeReversal */
function buildNShapeSeries(index: number, seed: number): StockSeries {
  const r = rng(seed);
  const sb = new BarBuilder(codeOf(index), mockName(index), 10 + r() * 8);
  sb.fill(80, 0.003, 1.0);
  for (let c = 0; c < 6; c++) {
    sb.fill(12, 0.003, 1.0);
    sb.day({ limit: 'up', openGap: -0.02, range: 0.03, vol: 1.3 }); // 激活涨停
    sb.day({ pct: -0.004, vol: 0.8 }); // 回调 1
    sb.day({ pct: -0.004, vol: 0.8 }); // 回调 2
    sb.day({ limit: 'up', openGap: -0.02, range: 0.03, vol: 1.2 }); // 反包涨停（打板买点）
  }
  return sb.build('游资博弈');
}

/** 形态 D：20 日新高 + 大成交额 + 阳线 → 命中 turtleBreakout */
function buildTurtleSeries(index: number, seed: number): StockSeries {
  const r = rng(seed);
  const sb = new BarBuilder(codeOf(index), mockName(index), 15 + r() * 20);
  sb.fill(60, 0.002, 1.0);
  for (let c = 0; c < 8; c++) {
    sb.fill(14, 0.002, 1.0);
    sb.day({ pct: 0.05, openGap: -0.005, range: 0.02, vol: 8 }); // 新高放量阳线
  }
  return sb.build('突破形态');
}

/** 形态 E：上升趋势中跌停 + 次日反包 → 命中 uptrendLimitDown */
function buildUptrendLimitDownSeries(index: number, seed: number): StockSeries {
  const r = rng(seed);
  const sb = new BarBuilder(codeOf(index), mockName(index), 20 + r() * 10);
  sb.fill(80, 0.004, 1.0);
  for (let c = 0; c < 6; c++) {
    sb.fill(12, 0.004, 1.0);
    sb.day({ limit: 'down', openGap: 0.0, range: 0.03, vol: 1.2 }); // 跌停
    sb.day({ pct: 0.13, openGap: -0.005, vol: 1.2 }); // 反包
  }
  return sb.build('超跌反弹');
}

/**
 * 生成离线兜底标的池：按 5 类真实形态各造若干只，
 * 保证离线（无 Python/baostock）时选股也能出结果。
 */
export function generateMockPool(opts?: { perType?: number }): StockSeries[] {
  const per = opts?.perType ?? 4;
  const builders = [
    buildTrendSeries,
    buildLimitUpReversalSeries,
    buildNShapeSeries,
    buildTurtleSeries,
    buildUptrendLimitDownSeries,
  ];
  const out: StockSeries[] = [];
  let idx = 0;
  for (const fn of builders) {
    for (let k = 0; k < per; k++) {
      out.push(fn(idx, (idx + 1) * 97 + 13));
      idx++;
    }
  }
  return out;
}
