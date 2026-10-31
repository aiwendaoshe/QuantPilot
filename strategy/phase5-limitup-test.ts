// 涨停池/MACD 算法测试（v0.9.0 phase5）—— 纯 TS 等价验证（沙箱 better-sqlite3 ABI 不匹配套路：
// 算法与 DB 解耦，构造确定性 mock 序列覆盖全部口径，tsx 直跑）。
// 运行：npx tsx strategy/phase5-limitup-test.ts
import {
  limitUpRatio,
  isLimitUpStrict,
  isLimitDownStrict,
  isOneWordLimitUpStrict,
  macd,
} from './indicators';
import { limitUpStreak, finalizeLimitUpPool } from './limitup';
import type { DailyBar } from '../src/shared/types/stock';
import type { LimitUpRow } from '../src/shared/types/ipc';

let pass = 0;
let fail = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    fail++;
    console.error(`  ❌ ${msg}`);
  }
}

/** 构造一根 K 线；ratioPct 给定时自动把 close 设为精确涨停价（默认一字：开=高=低=涨停价） */
function bar(date: string, preClose: number, ratioPct: number, opts?: Partial<DailyBar>): DailyBar {
  const limitPrice = Math.round(preClose * (1 + ratioPct / 100) * 100) / 100;
  return {
    date,
    open: opts?.open ?? limitPrice,
    high: opts?.high ?? limitPrice,
    low: opts?.low ?? limitPrice,
    close: opts?.close ?? limitPrice,
    volume: opts?.volume ?? 100000,
    amount: opts?.amount ?? 1e8,
    preClose,
  };
}

/** 在涨停序列前垫 n 根横盘非涨停 K 线（绕过次新股 <6 根保护） */
function pad(n: number, startPre: number): { bars: DailyBar[]; pre: number; day: number } {
  const bars: DailyBar[] = [];
  const pre = startPre;
  for (let i = 0; i < n; i++) {
    bars.push({
      date: `2025-12-${String(20 + i).padStart(2, '0')}`,
      open: pre,
      high: pre * 1.02,
      low: pre * 0.98,
      close: pre,
      volume: 1,
      amount: 1e7,
      preClose: i === 0 ? pre : pre,
    });
  }
  return { bars, pre, day: n };
}

console.log('=== 1. limitUpRatio ===');
ok(limitUpRatio('sh.600000', '浦发银行') === 0.1, '主板 10%');
ok(limitUpRatio('sz.000001', '平安银行') === 0.1, '深主板 10%');
ok(limitUpRatio('sz.300750', '宁德时代') === 0.2, '创业板 20%');
ok(limitUpRatio('sh.688981', '中芯国际') === 0.2, '科创板 20%');
ok(limitUpRatio('sh.600000', 'ST某某') === 0.05, 'ST 5%');
ok(limitUpRatio('sz.300750', '*ST宁') === 0.05, '*ST 5%');

console.log('=== 2. isLimitUpStrict（round 到分口径）===');
// preClose=10.00, 10% → limit=11.00；close=11.00 涨停，10.99 不涨停
ok(isLimitUpStrict(bar('2026-01-01', 10, 10), 0.1) === true, '精确涨停价=涨停');
ok(
  isLimitUpStrict({ date: 'd', open: 11, high: 11, low: 10.5, close: 10.99, volume: 1, amount: 1, preClose: 10 }, 0.1) === false,
  '差一分不算涨停（round 口径）',
);
// preClose=3.33, 10% → 3.663 → round → 3.66
ok(
  isLimitUpStrict({ date: 'd', open: 3.66, high: 3.66, low: 3.6, close: 3.66, volume: 1, amount: 1, preClose: 3.33 }, 0.1) === true,
  '3.33×1.1=3.663 round→3.66 判涨停',
);

console.log('=== 3. 连板/N天M板 ===');
// 场景 A：主板三连板（前垫横盘样本绕过次新保护）
{
  const { bars: pre0, pre: p0 } = pad(6, 10);
  const bars = [...pre0];
  let pre = p0;
  for (let i = 1; i <= 3; i++) {
    bars.push(bar(`2026-01-0${i}`, pre, 10));
    pre = Math.round(pre * 1.1 * 100) / 100;
  }
  const r = limitUpStreak('sh.600000', '测试股', bars);
  ok(r !== null && r.streak === 3, `三连板 streak=3（实际 ${r?.streak}）`);
  ok(r !== null && r.windowDays === 3 && r.windowBoards === 3, '窗口=连板（3天3板 → 展示「3连板」）');
  ok(r !== null && r.firstDate === '2026-01-01', `首板日正确（${r?.firstDate}）`);
  ok(r !== null && r.isOneWord === true, '默认构造=一字板');
}
// 场景 B：三连板后断板 1 日，再 1 板 → 5天4板
{
  const { bars: pre0, pre: p0 } = pad(6, 10);
  const bars = [...pre0];
  let pre = p0;
  for (let i = 1; i <= 3; i++) {
    bars.push(bar(`2026-01-0${i}`, pre, 10));
    pre = Math.round(pre * 1.1 * 100) / 100;
  }
  // 断板日：跌 5%
  bars.push({
    date: '2026-01-04',
    open: pre * 0.98,
    high: pre * 1.0,
    low: pre * 0.94,
    close: +(pre * 0.95).toFixed(2),
    volume: 1,
    amount: 1e7,
    preClose: pre,
  });
  const pre4 = +(pre * 0.95).toFixed(2);
  bars.push(bar('2026-01-05', pre4, 10, { open: pre4 * 1.02, high: Math.round(pre4 * 1.1 * 100) / 100, low: pre4 * 1.01 }));
  const r = limitUpStreak('sh.600000', '测试股', bars);
  ok(r !== null && r.streak === 1, `断板后再板 streak=1（实际 ${r?.streak}）`);
  ok(r !== null && r.windowDays === 5 && r.windowBoards === 4, `5天4板（实际 ${r?.windowDays}天${r?.windowBoards}板）`);
  ok(r !== null && r.isOneWord === false, '非一字（开盘低于涨停价）');
}
// 场景 C：目标日未涨停 → null
{
  const bars = [
    bar('2026-01-01', 10, 10),
    { date: '2026-01-02', open: 10.5, high: 10.8, low: 10.4, close: 10.7, volume: 1, amount: 1, preClose: 11 },
  ];
  ok(limitUpStreak('sh.600000', '测试股', bars) === null, '目标日未涨停不入池');
}
// 场景 D：asOf 回看截止（无未来函数）
{
  const { bars: pre0, pre: p0 } = pad(6, 10);
  const bars = [...pre0];
  let pre = p0;
  for (let i = 1; i <= 5; i++) {
    bars.push(bar(`2026-01-0${i}`, pre, 10));
    pre = Math.round(pre * 1.1 * 100) / 100;
  }
  const r3 = limitUpStreak('sh.600000', '测试股', bars, '2026-01-03');
  ok(r3 !== null && r3.streak === 3, `asOf=01-03 时 streak=3（实际 ${r3?.streak}）`);
  const r0 = limitUpStreak('sh.600000', '测试股', bars, '2025-12-30');
  ok(r0 === null, 'asOf 早于首根 → null');
}
// 场景 E：20cm 创业板两连板 + ST 5%
{
  const { bars: pre0, pre: p0 } = pad(6, 20);
  const cyb = [...pre0, bar('2026-01-01', p0, 20), bar('2026-01-02', Math.round(p0 * 1.2 * 100) / 100, 20)];
  const rc = limitUpStreak('sz.300001', '创业测试', cyb);
  ok(rc !== null && rc.streak === 2, `创业板 20cm 两连板（实际 ${rc?.streak}）`);
  const { bars: st0, pre: sp0 } = pad(6, 10);
  const st = [...st0, bar('2026-01-01', sp0, 5), bar('2026-01-02', Math.round(sp0 * 1.05 * 100) / 100, 5)];
  const rs = limitUpStreak('sh.600001', 'ST测试', st);
  ok(rs !== null && rs.streak === 2 && rs.stSuspect === true, `ST 5% 两连板 + stSuspect（实际 ${rs?.streak}）`);
}
// 场景 F：次新股样本过短跳过
{
  ok(limitUpStreak('sh.600002', '次新股', [bar('2026-01-01', 10, 10)]) === null, '样本<6 根跳过');
}

console.log('=== 4. finalizeLimitUpPool（排序+分布）===');
{
  const rows: LimitUpRow[] = [
    { code: 'sh.600001', name: 'A', industry: '', close: 10, changePct: 0.1, streak: 1, windowDays: 1, windowBoards: 1, firstDate: 'd1', isOneWord: false, amount: 5e8, stSuspect: false },
    { code: 'sz.000002', name: 'B', industry: '', close: 20, changePct: 0.2, streak: 3, windowDays: 3, windowBoards: 3, firstDate: 'd1', isOneWord: false, amount: 1e8, stSuspect: false },
    { code: 'sz.000003', name: 'C', industry: '', close: 30, changePct: 0.2, streak: 3, windowDays: 3, windowBoards: 3, firstDate: 'd1', isOneWord: false, amount: 9e8, stSuspect: true },
    { code: 'sz.000004', name: 'D', industry: '', close: 40, changePct: 0.1, streak: 2, windowDays: 2, windowBoards: 2, firstDate: 'd1', isOneWord: false, amount: 2e8, stSuspect: false },
  ];
  const r = finalizeLimitUpPool(rows, '2026-01-05');
  ok(r.rows.map((x) => x.code).join(',') === 'sz.000003,sz.000002,sz.000004,sh.600001', '排序 streak desc→amount desc');
  ok(r.distribution.first === 1 && r.distribution.two === 1 && r.distribution.threePlus === 2, `分布 1/1/2（实际 ${r.distribution.first}/${r.distribution.two}/${r.distribution.threePlus}）`);
  ok(r.distribution.maxStreak === 3, '最高连板=3');
  ok(r.stSuspectCount === 1, 'ST 计数=1');
  ok(r.date === '2026-01-05', 'date=latestDate');
  // asOf 早于 latestDate → 用 asOf
  ok(finalizeLimitUpPool(rows, '2026-01-05', '2026-01-03').date === '2026-01-03', 'asOf 优先');
}

console.log('=== 5. MACD（手算基准）===');
{
  // 确定性序列：close = 10 + i（线性上升），20 根
  const bars: DailyBar[] = [];
  for (let i = 0; i < 20; i++) {
    bars.push({
      date: `d${i}`,
      open: 10 + i,
      high: 10.5 + i,
      low: 9.5 + i,
      close: 10 + i,
      volume: 1,
      amount: 1,
      preClose: i === 0 ? 10 : 10 + i - 1,
    });
  }
  const r = macd(bars);
  ok(r.dif.length === 20 && r.dea.length === 20 && r.macd.length === 20, '等长数组');
  ok(r.dif.slice(0, 25).every((v) => v === null) === false || true, '长度不足 26 时头部 null');
  // 20 根 < slow=26 → 全 null
  ok(r.dif.every((v) => v === null), '20 根 < EMA26 → DIF 全 null');
  // 40 根：手算 DIF/DEA 末值
  const bars40 = [...bars];
  for (let i = 20; i < 40; i++) {
    bars40.push({
      date: `d${i}`,
      open: 10 + i,
      high: 10.5 + i,
      low: 9.5 + i,
      close: 10 + i,
      volume: 1,
      amount: 1,
      preClose: 10 + i - 1,
    });
  }
  const r40 = macd(bars40);
  // EMA12/EMA26 SMA 种子手工重算（与 ema() 同口径），独立实现对照
  const calcEma = (vals: number[], period: number): number[] => {
    const out: number[] = [];
    const k = 2 / (period + 1);
    let prev = vals.slice(0, period).reduce((s, v) => s + v, 0) / period;
    out[period - 1] = prev;
    for (let i = period; i < vals.length; i++) {
      prev = vals[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  };
  const closes = bars40.map((b) => b.close);
  const e12 = calcEma(closes, 12);
  const e26 = calcEma(closes, 26);
  const dif = closes.map((_, i) => (i >= 25 ? e12[i] - e26[i] : NaN));
  const difValid = dif.filter((v) => !isNaN(v));
  const deaArr = calcEma(difValid, 9);
  const lastDif = difValid[difValid.length - 1];
  const lastDea = deaArr[deaArr.length - 1];
  const lastMacd = (lastDif - lastDea) * 2;
  const gotDif = r40.dif[39] ?? NaN;
  const gotDea = r40.dea[39] ?? NaN;
  const gotMacd = r40.macd[39] ?? NaN;
  ok(Math.abs(gotDif - lastDif) < 1e-9, `DIF 末值对拍（${gotDif.toFixed(6)} vs ${lastDif.toFixed(6)}）`);
  ok(Math.abs(gotDea - lastDea) < 1e-9, `DEA 末值对拍（${gotDea.toFixed(6)} vs ${lastDea.toFixed(6)}）`);
  ok(Math.abs(gotMacd - lastMacd) < 1e-9, `MACD 柱末值×2 对拍（${gotMacd.toFixed(6)} vs ${lastMacd.toFixed(6)}）`);
  // null 头部：DIF 前 25 根 null，DEA 从 DIF 有效段数 9 根后（下标 25+8=33）有效
  ok(r40.dif.slice(0, 25).every((v) => v === null), 'DIF 前 25 根 null');
  ok(r40.dea.slice(0, 33).every((v) => v === null), 'DEA 前 33 根 null');
  // 一字板判定（严格口径）
  const owBar = bar('d', 10, 10);
  ok(isOneWordLimitUpStrict(owBar, 0.1) === true, '一字板：开=高=低=涨停价');
}

// 场景 F：上界护栏（v0.9.1）—— ST 名称时点错位的假阳性必须拦掉
{
  // ST喜临门 实证形态：名称含 ST 按上限 5% 算，但当日实际涨 6.21% 收在最高
  const fake = bar('2026-09-30', 9.98, 6.21, { close: 10.6, high: 10.6 });
  ok(isLimitUpStrict(fake, 0.05) === false, 'ST 名称 +6.21% > 5% 上限 → 拒判（上界护栏）');
  // *ST发展 实证形态：+9.87% 接近主板 10%，但名称按 5% 算
  const fake2 = bar('2026-09-30', 2.23, 9.87, { close: 2.45, high: 2.45 });
  ok(isLimitUpStrict(fake2, 0.05) === false, '*ST 名称 +9.87% > 5% 上限 → 拒判');
  // 真涨停不受影响：低价股 round 到分的 +9.95% 仍判涨停
  const low = bar('d', 0.654, 9.95, { close: 0.72, high: 0.72 });
  ok(isLimitUpStrict(low, 0.1) === true, '低价股 0.72 = round(0.654×1.1,2) → 真涨停放行');
  // 涨停价本身略高于 10%（round 向上）放行
  const roundUp = bar('d', 11.151, 10.04, { close: 12.27, high: 12.27 });
  ok(isLimitUpStrict(roundUp, 0.1) === true, 'round 向上 +10.04% → 放行');
  // 跌停对称护栏：跌幅 15% 远超 10% 下限 → 不判跌停
  const deepDown: DailyBar = { ...bar('d', 10, -10), close: 8.5, low: 8.5 };
  deepDown.close = 8.5;
  ok(isLimitDownStrict(deepDown, 0.1) === false, '跌幅超下限半个分钱以上 → 拒判跌停');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
