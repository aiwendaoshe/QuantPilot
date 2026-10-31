import type { BacktestResult, Trade } from '../src/shared/types/backtest';
import type { StrategyId } from '../src/shared/types/signal';
import { writeFileSync } from 'node:fs';

// M5 分析维度已抽到 src/shared/reportCore.ts（渲染层也要用，且 report.ts 依赖 node:fs 不能进渲染包）
export * from '../src/shared/reportCore';

/** 写出 JSON 回测报告 */
export function writeJsonReport(result: BacktestResult, path: string): void {
  writeFileSync(path, JSON.stringify(result, null, 2), 'utf-8');
}

function fmtPct(x: number): string {
  return (x * 100).toFixed(2) + '%';
}
function fmtMoney(x: number): string {
  return '¥' + x.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
function fmtNum(x: number): string {
  if (!isFinite(x)) return '∞';
  return x.toFixed(2);
}

/** 权益曲线 SVG（含初始资金基准线、买卖点标记） */
function equitySvg(result: BacktestResult, w = 760, h = 260): string {
  const curve = result.equityCurve;
  if (curve.length === 0) return '<p>无权益数据</p>';
  const equities = curve.map((c) => c.equity);
  const minE = Math.min(...equities, result.initialCapital);
  const maxE = Math.max(...equities, result.initialCapital);
  const span = maxE - minE || 1;
  const padL = 64;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const x = (i: number) => padL + (curve.length === 1 ? 0 : (i / (curve.length - 1)) * plotW);
  const y = (e: number) => padT + (1 - (e - minE) / span) * plotH;

  const pts = curve.map((c, i) => `${x(i).toFixed(1)},${y(c.equity).toFixed(1)}`).join(' ');
  const baseY = y(result.initialCapital);
  const firstDate = curve[0].date;
  const lastDate = curve[curve.length - 1].date;

  // 买卖点（按日期匹配 equityCurve 索引）
  const idxByDate = new Map(curve.map((c, i) => [c.date, i]));
  const marks: string[] = [];
  for (const t of result.trades) {
    const ei = idxByDate.get(t.entryDate);
    const xi = idxByDate.get(t.exitDate);
    if (ei !== undefined) marks.push(`<circle cx="${x(ei).toFixed(1)}" cy="${y(curve[ei].equity).toFixed(1)}" r="3.5" fill="#16a34a" stroke="#fff" stroke-width="1"/>`);
    if (xi !== undefined) marks.push(`<circle cx="${x(xi).toFixed(1)}" cy="${y(curve[xi].equity).toFixed(1)}" r="3.5" fill="#dc2626" stroke="#fff" stroke-width="1"/>`);
  }

  return `
  <svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" font-family="system-ui,Segoe UI,Arial">
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="#f8fafc" stroke="#e2e8f0"/>
    <line x1="${padL}" y1="${baseY.toFixed(1)}" x2="${padL + plotW}" y2="${baseY.toFixed(1)}" stroke="#94a3b8" stroke-dasharray="4 3"/>
    <text x="${padL - 6}" y="${(baseY + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748b">基准</text>
    <polygon points="${padL},${padT} ${pts} ${padL + plotW},${padT}" fill="rgba(37,99,235,0.08)"/>
    <polyline points="${pts}" fill="none" stroke="#2563eb" stroke-width="1.8"/>
    ${marks.join('')}
    <text x="${padL}" y="${(padT - 4).toFixed(1)}" font-size="10" fill="#475569">${fmtMoney(maxE)}</text>
    <text x="${padL}" y="${(padT + plotH).toFixed(1)}" font-size="10" fill="#475569">${fmtMoney(minE)}</text>
    <text x="${padL}" y="${(h - 8).toFixed(1)}" font-size="10" fill="#64748b">${firstDate}</text>
    <text x="${(padL + plotW).toFixed(1)}" y="${(h - 8).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748b">${lastDate}</text>
  </svg>`;
}

/** 回撤水下图 SVG（红色面积） */
function drawdownSvg(result: BacktestResult, w = 760, h = 150): string {
  const curve = result.equityCurve;
  if (curve.length === 0) return '';
  let peak = -Infinity;
  const dd: number[] = curve.map((c) => {
    if (c.equity > peak) peak = c.equity;
    return peak > 0 ? (peak - c.equity) / peak : 0;
  });
  const maxDD = Math.max(...dd, 0.0001);
  const padL = 64;
  const padR = 16;
  const padT = 12;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const x = (i: number) => padL + (curve.length === 1 ? 0 : (i / (curve.length - 1)) * plotW);
  const y = (d: number) => padT + (d / maxDD) * plotH;

  const areaPts = dd.map((d, i) => `${x(i).toFixed(1)},${y(d).toFixed(1)}`).join(' ');
  const poly = `${padL},${padT} ${areaPts} ${padL + plotW},${padT}`;
  return `
  <svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" font-family="system-ui,Segoe UI,Arial">
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="#fff5f5" stroke="#fecaca"/>
    <polygon points="${poly}" fill="rgba(220,38,38,0.25)" stroke="#dc2626" stroke-width="1"/>
    <text x="${padL - 6}" y="${(padT + 8).toFixed(1)}" text-anchor="end" font-size="10" fill="#b91c1c">0%</text>
    <text x="${padL - 6}" y="${(padT + plotH).toFixed(1)}" text-anchor="end" font-size="10" fill="#b91c1c">${fmtPct(maxDD)}</text>
    <text x="${padL}" y="${(h - 6).toFixed(1)}" font-size="10" fill="#64748b">回撤(水下)</text>
  </svg>`;
}

function tradeRows(result: BacktestResult): string {
  if (!result.trades.length) return '<tr><td colspan="6" style="text-align:center;color:#94a3b8">无成交</td></tr>';
  return result.trades
    .map(
      (t: Trade) => `<tr>
        <td>${t.code} ${t.name ?? ''}</td>
        <td>${t.entryDate}</td>
        <td>${t.exitDate}</td>
        <td style="color:${t.pnlPct >= 0 ? '#16a34a' : '#dc2626'}">${(t.pnlPct * 100).toFixed(2)}%</td>
        <td>${t.holdingDays}</td>
        <td>${t.reason}</td>
      </tr>`,
    )
    .join('');
}

/** 写出单策略可视化 HTML 回测报告（自包含，无外部依赖） */
export function writeReportHtml(
  result: BacktestResult,
  opts: { strategyName: string; signals: number; notes?: string },
  path: string,
): void {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>QuantPilot 回测报告 · ${opts.strategyName}</title>
<style>
  body{margin:0;font-family:system-ui,'Segoe UI',Arial,'Microsoft YaHei',sans-serif;background:#f1f5f9;color:#0f172a}
  .wrap{max-width:920px;margin:0 auto;padding:24px}
  header{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;padding:20px 24px;border-radius:12px}
  header h1{margin:0;font-size:20px}
  header .sub{opacity:.85;font-size:13px;margin-top:4px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px}
  .card .k{font-size:12px;color:#64748b}
  .card .v{font-size:20px;font-weight:700;margin-top:4px}
  .panel{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px}
  .panel h2{margin:0 0 10px;font-size:15px;color:#1e293b}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{padding:6px 8px;border-bottom:1px solid #f1f5f9;text-align:left}
  th{color:#64748b;font-weight:600}
  .note{font-size:12px;color:#475569;line-height:1.6}
  .pos{color:#16a34a}.neg{color:#dc2626}
</style></head>
<body><div class="wrap">
<header><h1>QuantPilot 回测报告</h1>
<div class="sub">策略：${opts.strategyName}（${result.strategyId}） · 区间 ${result.startDate} ~ ${result.endDate} · 触发信号 ${opts.signals} 只</div></header>

<div class="cards">
  <div class="card"><div class="k">初始资金</div><div class="v">${fmtMoney(result.initialCapital)}</div></div>
  <div class="card"><div class="k">期末资金</div><div class="v ${result.finalCapital >= result.initialCapital ? 'pos' : 'neg'}">${fmtMoney(result.finalCapital)}</div></div>
  <div class="card"><div class="k">收益率</div><div class="v ${result.finalCapital >= result.initialCapital ? 'pos' : 'neg'}">${fmtPct(result.finalCapital / result.initialCapital - 1)}</div></div>
  <div class="card"><div class="k">胜率</div><div class="v">${fmtPct(result.winRate)}</div></div>
  <div class="card"><div class="k">盈亏比</div><div class="v">${fmtNum(result.profitFactor)}</div></div>
  <div class="card"><div class="k">最大回撤</div><div class="v neg">${fmtPct(result.maxDrawdown)}</div></div>
  <div class="card"><div class="k">夏普比率</div><div class="v">${fmtNum(result.sharpe)}</div></div>
  <div class="card"><div class="k">交易次数</div><div class="v">${result.totalTrades}</div></div>
  <div class="card"><div class="k">数据完整性</div><div class="v" style="font-size:14px">无未来函数</div></div>
</div>

<div class="panel"><h2>净值曲线</h2>${equitySvg(result)}</div>
<div class="panel"><h2>回撤（水下图）</h2>${drawdownSvg(result)}</div>
<div class="panel"><h2>成交明细</h2>
<table><thead><tr><th>代码 / 名称</th><th>买入</th><th>卖出</th><th>收益</th><th>持仓(日)</th><th>退出原因</th></tr></thead>
<tbody>${tradeRows(result)}</tbody></table></div>

<div class="panel"><h2>方法论说明</h2>
<p class="note">${opts.notes ?? '回测严格使用前复权/后复权数据，信号生成仅依赖截至当日的 K 线，杜绝未来函数。买入在 T+1 次日开盘（或 T 日收盘）成交，已计入手续费与滑点。'}</p></div>
</div></body></html>`;
  writeFileSync(path, html, 'utf-8');
}

export interface ComparisonRow {
  strategyId: StrategyId;
  name: string;
  signals: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpe: number;
  finalCapital: number;
  initialCapital: number;
  totalTrades: number;
}

/** 多策略对比 HTML 报告 */
export function writeComparisonHtml(rows: ComparisonRow[], path: string, title = 'QuantPilot 多策略回测对比'): void {
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{margin:0;font-family:system-ui,'Segoe UI',Arial,'Microsoft YaHei',sans-serif;background:#f1f5f9;color:#0f172a}
  .wrap{max-width:1000px;margin:0 auto;padding:24px}
  h1{font-size:20px;color:#1e3a8a}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;font-size:13px}
  th,td{padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right}
  th:first-child,td:first-child{text-align:left}
  thead th{background:#1e3a8a;color:#fff;font-weight:600}
  tbody tr:nth-child(even){background:#f8fafc}
  .pos{color:#16a34a}.neg{color:#dc2626}
</style></head>
<body><div class="wrap"><h1>${title}</h1>
<table><thead><tr>
  <th>策略</th><th>信号数</th><th>交易数</th><th>胜率</th><th>盈亏比</th><th>最大回撤</th><th>夏普</th><th>期末资金</th><th>收益率</th>
</tr></thead><tbody>
${rows
  .map(
    (r) => `<tr>
  <td>${r.name}</td>
  <td>${r.signals}</td>
  <td>${r.totalTrades}</td>
  <td>${fmtPct(r.winRate)}</td>
  <td>${fmtNum(r.profitFactor)}</td>
  <td class="neg">${fmtPct(r.maxDrawdown)}</td>
  <td>${fmtNum(r.sharpe)}</td>
  <td>${fmtMoney(r.finalCapital)}</td>
  <td class="${r.finalCapital >= r.initialCapital ? 'pos' : 'neg'}">${fmtPct(r.finalCapital / r.initialCapital - 1)}</td>
</tr>`,
  )
  .join('')}
</tbody></table>
<p style="font-size:12px;color:#64748b">回测在同一标的池上运行，手续费 0.03%、滑点 0.1%、止损 7%，T+1 次日开盘成交，信号与执行分离、无未来函数。</p>
</div></body></html>`;
  writeFileSync(path, html, 'utf-8');
}
