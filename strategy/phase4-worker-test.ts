// 阶段四 Worker 集成测试：真实 spawn worker_threads 线程，验证「选股 + 回测」双链路。
// 前置：npm run build:worker（产出 dist-electron/src/main/workers/strategyWorker.js）
// 运行：npm run verify:worker （工作目录必须为项目根，测试按 cwd 定位编译产物）
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { DailyBar, StockMeta, StockSeries } from '../src/shared/types/stock';
import type { BacktestOptions } from '../src/shared/types/backtest';
import type { WorkerPayload, WorkerResponse } from '../src/main/workers/protocol';
import type { Signal } from '../src/shared/types/signal';
import { generateMockPool, mockName } from './mockData';

const WORKER_PATH = path.join(
  process.cwd(),
  'dist-electron',
  'src',
  'main',
  'workers',
  'strategyWorker.js',
);

// 确定性伪随机
function rng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** 强趋势+周期放量序列（复刻 demo.ts 验证过的形态，保证末根可命中信号） */
function makeStrong(code: string, idx: number, days = 300): StockSeries {
  const r = rng(idx * 131 + 7);
  const bars: DailyBar[] = [];
  let price = 10 + idx * 5;
  const base = new Date(Date.UTC(2023, 0, 1));
  for (let i = 0; i < days; i++) {
    const date = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    const open = price;
    const close = Math.max(1, open + open * (0.005 + (r() - 0.5) * 0.01));
    const high = Math.max(open, close) * (1 + r() * 0.01);
    const low = Math.min(open, close) * (1 - r() * 0.01);
    let volume = 1_000_000 * (0.9 + 0.2 * Math.sin(i / 7) + (r() - 0.5) * 0.1);
    if (i % 9 === 0 || i >= days - 3) volume *= 1.8;
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
  const meta: StockMeta = { code, name: mockName(idx), industry: '测试', market: code.split('.')[0] };
  return { meta, bars };
}

function post(worker: Worker, req: WorkerPayload, id: number, timeoutMs = 60_000): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker 响应超时(${timeoutMs}ms)`)), timeoutMs);
    const onMsg = (res: WorkerResponse): void => {
      if (res.id !== id) return;
      clearTimeout(timer);
      worker.off('message', onMsg);
      resolve(res);
    };
    worker.on('message', onMsg);
    worker.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    worker.postMessage({ ...req, id });
  });
}

async function main(): Promise<void> {
  // 强趋势 3 只（保证信号命中）+ 常规池 8 只（覆盖回测交易日多样性）
  const pool: StockSeries[] = [
    makeStrong('sh.710101', 0),
    makeStrong('sh.710102', 1),
    makeStrong('sz.710103', 2),
    ...generateMockPool({ perType: 2 }),
  ];
  console.log(`[test] 标的池 ${pool.length} 只（强趋势3 + 常规8）`);
  const worker = new Worker(WORKER_PATH);

  // ---- 1) 选股链路：11 只 × 7 策略，按评分降序 ----
  const t0 = Date.now();
  const r1 = await post(worker, { kind: 'screener', pool, configs: [], topN: 20 }, 1);
  if (!r1.ok || r1.kind !== 'screener') {
    throw new Error(`选股失败: ${!r1.ok ? r1.error : '响应 kind 不符'}`);
  }
  const signals: Signal[] = r1.signals;
  console.log(`[Worker 选股] 命中 ${signals.length} 只，耗时 ${Date.now() - t0}ms`);
  for (const s of signals.slice(0, 5)) {
    console.log(`  ${s.code} ${s.name} [${s.strategyId}] 评分${s.score}`);
  }
  if (signals.length === 0) throw new Error('选股 0 命中，链路异常');
  if (signals.some((a, i) => i > 0 && signals[i - 1].score < a.score)) {
    throw new Error('选股结果未按评分降序排序');
  }

  // ---- 2) 回测链路：maBullish 全池回测，须产生成交且资金结算正确 ----
  const options: BacktestOptions = {
    initialCapital: 100_000,
    commissionRate: 0.0003,
    slippage: 0.001,
    stopLossPct: 0.07,
    takeProfitPct: 0,
    tPlusOne: true,
    holdDays: 5,
  };
  const t1 = Date.now();
  const r2 = await post(worker, { kind: 'backtest', pool, strategyId: 'maBullish', options }, 2);
  if (!r2.ok || r2.kind !== 'backtest') {
    throw new Error(`回测失败: ${!r2.ok ? r2.error : '响应 kind 不符'}`);
  }
  const bt = r2.result;
  console.log(
    `[Worker 回测] 交易${bt.totalTrades} 胜率${(bt.winRate * 100).toFixed(1)}% ` +
      `期末${bt.finalCapital.toFixed(0)} 耗时${Date.now() - t1}ms`,
  );
  if (bt.totalTrades === 0) throw new Error('回测 0 成交，链路异常');
  if (!Number.isFinite(bt.finalCapital) || bt.finalCapital <= 0) {
    throw new Error('期末资金异常，结算逻辑可能有 bug');
  }

  await worker.terminate();
  console.log('✅ 阶段四 Worker 集成测试通过（选股 + 回测 双链路）');
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error('❌', e);
    process.exit(1);
  });
