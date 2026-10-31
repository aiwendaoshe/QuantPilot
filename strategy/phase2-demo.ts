/**
 * 阶段二验证脚本：用合成场景数据跑通「6 策略信号生成 + 全策略回测 + 报告产出」全链路。
 * 运行：npm run strategy:phase2  (等价 tsx strategy/phase2-demo.ts)
 *
 * 说明：A 股真实涨跌停/反包形态需真实日 K，本脚本用可控合成场景逐一对齐各策略触发条件，
 * 用于验证逻辑正确性与无未来函数；接入真实 baostock 数据后同一套代码即可直接生产选股。
 */
import type { DailyBar, StockMeta, StockSeries } from '../src/shared/types/stock';
import type { BacktestOptions } from '../src/shared/types/backtest';
import { mkdirSync } from 'node:fs';
import { phase2Strategies } from './registry';
import { generateMockPool } from './mockData';
import { writeJsonReport, writeReportHtml, writeComparisonHtml } from './report';
import type { ComparisonRow } from './report';

const OUT_DIR = 'D:/workBuddySpace/quantpilot/data/reports';
mkdirSync(OUT_DIR, { recursive: true });

/** 可控 K 线构造器：limit 模式严格满足涨停/跌停判定 */
class SB {
  bars: DailyBar[] = [];
  private price: number;
  private date: Date;
  constructor(public code: string, public name: string, startPrice: number) {
    this.price = startPrice;
    this.date = new Date(Date.UTC(2022, 0, 3));
  }
  private dateStr(): string {
    return this.date.toISOString().slice(0, 10);
  }
  day(opts: {
    pct?: number;
    range?: number;
    vol?: number;
    limit?: 'up' | 'down';
    openGap?: number;
  }): SB {
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
      date: this.dateStr(),
      open: +open.toFixed(3),
      high: +high.toFixed(3),
      low: +low.toFixed(3),
      close: +close.toFixed(3),
      volume,
      amount: volume * close,
      preClose: +preClose.toFixed(3),
    });
    this.price = close;
    this.date = new Date(this.date.getTime() + 86400000);
    return this;
  }
  fill(days: number, pct: number, vol = 1): SB {
    for (let i = 0; i < days; i++) this.day({ pct, vol });
    return this;
  }
  build(industry = '场景'): StockSeries {
    const meta: StockMeta = {
      code: this.code,
      name: this.name,
      industry,
      market: this.code.split('.')[0],
    };
    return { meta, bars: this.bars };
  }
}

// ---- 合成场景：每个场景对应一个策略的触发形态，并循环多次以产生多次信号/成交 ----
function buildTrend(): StockSeries {
  const sb = new SB('sh.710001', '华芯科技', 12);
  sb.fill(60, 0.003, 1.0);
  for (let c = 0; c < 8; c++) {
    sb.fill(8, 0.005, 1.0);
    sb.day({ pct: 0.004, vol: 1.8 }); // 放量确认
  }
  return sb.build();
}
function buildLimitUp(): StockSeries {
  const sb = new SB('sh.710002', '鼎晟新材', 10);
  sb.fill(80, 0.003, 1.0);
  for (let c = 0; c < 6; c++) {
    sb.fill(12, 0.003, 1.0);
    sb.day({ limit: 'up', openGap: -0.02, range: 0.04, vol: 1.4 }); // 首板
    sb.day({ pct: -0.003, vol: 0.8 }); // 回调（阴线）
    sb.day({ pct: 0.012, openGap: -0.01, vol: 1.0 }); // 反包
  }
  return sb.build();
}
function buildNShape(): StockSeries {
  const sb = new SB('sh.710003', '中泰智造', 10);
  sb.fill(80, 0.003, 1.0);
  for (let c = 0; c < 6; c++) {
    sb.fill(12, 0.003, 1.0);
    sb.day({ limit: 'up', openGap: -0.02, range: 0.03, vol: 1.3 }); // 激活涨停
    sb.day({ pct: -0.004, vol: 0.8 }); // 小幅回调1
    sb.day({ pct: -0.004, vol: 0.8 }); // 小幅回调2
    sb.day({ limit: 'up', openGap: -0.02, range: 0.03, vol: 1.2 }); // 反包涨停（打板买点）
  }
  return sb.build();
}
function buildTurtle(): StockSeries {
  const sb = new SB('sh.710004', '宏远电子', 15);
  sb.fill(60, 0.002, 1.0);
  for (let c = 0; c < 6; c++) {
    sb.fill(14, 0.002, 1.0);
    sb.day({ pct: 0.05, openGap: -0.005, range: 0.02, vol: 8 }); // 20日新高+大成交额+阳线
  }
  return sb.build();
}
function buildUptrendLd(): StockSeries {
  const sb = new SB('sh.710005', '天启能源', 20);
  sb.fill(80, 0.004, 1.0);
  for (let c = 0; c < 5; c++) {
    sb.fill(12, 0.004, 1.0);
    sb.day({ limit: 'down', openGap: 0.0, range: 0.03, vol: 1.2 }); // 跌停
    sb.day({ pct: 0.13, openGap: -0.005, vol: 1.2 }); // 反包
  }
  return sb.build();
}

function main(): void {
  const pool: StockSeries[] = [
    buildTrend(),
    buildLimitUp(),
    buildNShape(),
    buildTurtle(),
    buildUptrendLd(),
    ...generateMockPool({ perType: 2 }),
  ];

  const strats = phase2Strategies();

  console.log('===== 信号生成（逐场景末根验证各策略命中）=====');
  for (const s of pool) {
    for (const st of strats) {
      const sig = st.generateSignal(s.bars, s.meta);
      if (sig) {
        console.log(`  [${st.id}] → ${s.meta.name}: 评分${sig.score} | ${sig.reason}`);
      }
    }
  }

  const options: BacktestOptions = {
    initialCapital: 100_000,
    commissionRate: 0.0003,
    slippage: 0.001,
    stopLossPct: 0.07,
    takeProfitPct: 0,
    tPlusOne: true,
    holdDays: 5,
  };

  console.log('\n===== 全策略回测 + 报告产出 =====');
  const rows: ComparisonRow[] = [];
  for (const st of strats) {
    const opts: BacktestOptions = { ...options, holdDays: st.getParam<number>('holdDays', 5) };
    const res = st.backtest(pool, opts);
    const signals = pool.reduce(
      (acc, s) => acc + (st.generateSignal(s.bars, s.meta) ? 1 : 0),
      0,
    );
    writeJsonReport(res, `${OUT_DIR}/${st.id}.json`);
    writeReportHtml(
      res,
      {
        strategyName: st.meta.name,
        signals,
        notes:
          '回测严格使用截至当日的 K 线生成信号（无未来函数），T+1 次日开盘成交并计入手续费与滑点。' +
          '合成场景仅用于验证策略逻辑与链路；接入 baostock 真实日 K 后同一套引擎直接生产。',
      },
      `${OUT_DIR}/${st.id}.html`,
    );
    rows.push({
      strategyId: st.id,
      name: st.meta.name,
      signals,
      winRate: res.winRate,
      profitFactor: res.profitFactor,
      maxDrawdown: res.maxDrawdown,
      sharpe: res.sharpe,
      finalCapital: res.finalCapital,
      initialCapital: res.initialCapital,
      totalTrades: res.totalTrades,
    });
    console.log(
      `  [${st.id}] 信号${signals} 交易${res.totalTrades} 胜率${(res.winRate * 100).toFixed(1)}% ` +
        `盈亏比${res.profitFactor === Infinity ? '∞' : res.profitFactor.toFixed(2)} ` +
        `回撤${(res.maxDrawdown * 100).toFixed(2)}% 夏普${res.sharpe.toFixed(2)} 期末${res.finalCapital.toFixed(0)}`,
    );
  }

  writeComparisonHtml(rows, `${OUT_DIR}/comparison.html`);
  console.log(`\n✅ 阶段二验证完成。报告已写入：${OUT_DIR}`);
  console.log('   - comparison.html（多策略对比）');
  console.log('   - <strategyId>.json / .html（各策略明细）');
}

main();
