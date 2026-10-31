// A 股行情页的纯逻辑（过滤/排序/格式化）：抽出来便于离线单测，组件只做渲染
import type { MarketRow } from '@shared/types/ipc';

export type MarketSortKey = 'code' | 'changePct' | 'amount';

/** 涨跌配色：A 股口径 —— 涨=红（bull）、跌=绿（bear） */
export function pctClass(v: number): string {
  if (v > 0) return 'text-bull';
  if (v < 0) return 'text-bear';
  return 'text-gray-400';
}

/** 涨跌幅：带正号，两位小数 */
export function fmtPct(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** 涨跌额：带正号 */
export function fmtChange(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** 成交额：元 → 亿元 / 万元 */
export function fmtAmount(v: number): string {
  if (!v) return '—';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return v.toFixed(0);
}

/** 成交量：手 → 万手 */
export function fmtVolume(v: number): string {
  if (!v) return '—';
  return v >= 1e4 ? `${(v / 1e4).toFixed(2)} 万手` : `${v.toFixed(0)} 手`;
}

/** 关键字过滤：代码或名称包含即可（忽略大小写） */
export function filterMarket(rows: MarketRow[], keyword: string): MarketRow[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return rows.slice();
  return rows.filter(
    (r) => r.code.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
  );
}

/** 排序：code/changePct/amount，不改动入参数组 */
export function sortMarket(rows: MarketRow[], key: MarketSortKey, asc: boolean): MarketRow[] {
  const dir = asc ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === 'code') return a.code < b.code ? -dir : a.code > b.code ? dir : 0;
    if (key === 'amount') return (a.amount - b.amount) * dir;
    return (a.changePct - b.changePct) * dir;
  });
}

/** 上涨 / 下跌 / 平盘家数 */
export function marketStats(rows: MarketRow[]): { up: number; down: number; flat: number } {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const r of rows) {
    if (r.changePct > 0) up++;
    else if (r.changePct < 0) down++;
    else flat++;
  }
  return { up, down, flat };
}
