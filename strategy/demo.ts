/**
 * 阶段一验证脚本：用合成数据跑通「数据 → 策略 → 信号 → 回测」全链路。
 * 运行：npm run strategy:demo  (等价 tsx strategy/demo.ts)
 */
import type { DailyBar, StockMeta, StockSeries } from '../src/shared/types/stock';
import type { BacktestOptions } from '../src/shared/types/backtest';
import { MaBullish } from './MaBullish';

// 确定性伪随机，保证可复现
function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function makeSeries(
  code: string,
  name: string,
  days: number,
  start: number,
  dailyDrift: number,
  vol: number,
  seed: number,
  opts: { clean?: boolean; surge?: boolean } = {},
): StockSeries {
  const r = rng(seed);
  const bars: DailyBar[] = [];
  let price = start;
  const base = new Date(Date.UTC(2023, 0, 1));
  for (let i = 0; i < days; i++) {
    const date = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    const open = price;
    const change = price * (dailyDrift + (r() - 0.5) * vol);
    const close = Math.max(1, open + change);
    const high = Math.max(open, close) * (1 + r() * 0.01);
    const low = Math.min(open, close) * (1 - r() * 0.01);
    // 成交量：低噪声股波动小；surg穿 股票周期性放量（每 9 日一次）以触发量能确认
    let volume = 1_000_000 * (0.9 + 0.2 * Math.sin(i / 7) + (r() - 0.5) * 0.1);
    if (opts.surge && (i % 9 === 0 || i >= days - 3)) volume *= 1.8;
    volume = Math.round(volume);
    bars.push({
      date,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
      amount: volume * close,
      preClose: +open.toFixed(2),
    });
    price = close;
  }
  const meta: StockMeta = { code, name, industry: 'demo', market: code.split('.')[0] };
  return { meta, bars };
}

function main(): void {
  const pool: StockSeries[] = [
    makeSeries('sh.600001', '华芯科技', 260, 10, 0.006, 0.01, 11, { clean: true, surge: true }), // 强趋势+放量
    makeSeries('sh.600002', '鼎晟新材', 260, 20, 0.005, 0.012, 22, { clean: true, surge: true }), // 强趋势+放量
    makeSeries('sz.000003', '中泰智造', 260, 15, 0.0002, 0.03, 33), // 震荡
    makeSeries('sz.000004', '宏远电子', 260, 30, -0.003, 0.025, 44), // 下跌
    makeSeries('sh.600005', '天启能源', 260, 12, 0.001, 0.04, 55),
    makeSeries('sz.000006', '泽润环保', 260, 8, 0.0008, 0.035, 66),
  ];

  const strat = new MaBullish();

  console.log('===== 信号生成 =====');
  let hit = 0;
  for (const s of pool) {
    const sig = strat.generateSignal(s.bars, s.meta);
    if (sig) {
      hit++;
      console.log(
        `[信号] ${sig.name}(${sig.code}) @${sig.date} 评分=${sig.score} 价=${sig.price} | ${sig.reason}`,
      );
    } else {
      console.log(`[无信号] ${s.meta.name}(${s.meta.code})`);
    }
  }
  console.log(`命中 ${hit}/${pool.length} 只`);

  console.log('\n===== 回测 =====');
  const options: BacktestOptions = {
    initialCapital: 100_000,
    commissionRate: 0.0003,
    slippage: 0.001,
    stopLossPct: 0.07,
    takeProfitPct: 0,
    tPlusOne: true,
    holdDays: 5,
  };
  const result = strat.backtest(pool, options);
  console.log(`区间: ${result.startDate} ~ ${result.endDate}`);
  console.log(`初始资金: ${result.initialCapital}  期末: ${result.finalCapital.toFixed(2)}`);
  console.log(`交易次数: ${result.totalTrades}`);
  console.log(`胜率: ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`盈亏比: ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
  console.log(`最大回撤: ${(result.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`夏普: ${result.sharpe.toFixed(2)}`);
  if (result.trades.length) {
    console.log('样例成交:');
    for (const t of result.trades.slice(0, 5)) {
      console.log(
        `  ${t.code} ${t.entryDate}→${t.exitDate} 收益=${(t.pnlPct * 100).toFixed(2)}% 持仓=${t.holdingDays}日 ${t.reason}`,
      );
    }
  }
  console.log('\n✅ 阶段一数据链路验证完成');
}

main();
