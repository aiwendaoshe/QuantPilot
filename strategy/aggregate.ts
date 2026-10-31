import type { Signal } from '../src/shared/types/signal';

/**
 * 同一只票在同一天被多个策略命中时，聚合成一条。
 * 保留分数最高的那条，并在 extra 里记：
 *   - hits：命中它（这）的策略数量
 *   - strategyIds：命中的策略 id（逗号分隔）
 *
 * 不聚合的话 TOP20 里会出现 3 张同一只票的卡，观感像 bug。
 */
export function aggregateSignals(input: Signal[]): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const sig of input) {
    if (!sig?.code || !sig.date) continue;
    const key = `${sig.code}|${sig.date}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        ...sig,
        extra: { ...sig.extra, hits: 1, strategyIds: sig.strategyId },
      });
      continue;
    }
    const hits = Number(cur.extra.hits ?? 1) + 1;
    cur.extra.hits = hits;
    const ids = cur.extra.strategyIds;
    cur.extra.strategyIds =
      typeof ids === 'string' && ids ? `${ids},${sig.strategyId}` : String(sig.strategyId);
    // 主信号保留最高分那条的策略 id，便于卡片说明「由哪个策略给出」
    if (sig.score > cur.score) {
      cur.strategyId = sig.strategyId;
      // 雷达图跟随最高分那条策略的 breakdown，避免展示与评分不匹配的旧雷达
      if (sig.breakdown) cur.breakdown = sig.breakdown;
    }
    cur.score = Math.max(cur.score, sig.score);
  }
  const out = Array.from(byKey.values());
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 命中策略数（1 = 只有这一个策略，界面就不必再显示「+N 策略」角标） */
export function hitCount(sig: Pick<Signal, 'extra'>): number {
  const h = sig.extra?.hits;
  return typeof h === 'number' ? h : 1;
}
