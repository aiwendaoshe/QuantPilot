/**
 * 「已知口径偏差」名单的解析与基线。
 *
 * 为什么单独成一个文件：解析逻辑必须**零 electron 依赖**，才能在 `_smoke/p5` 下
 * 脱离主进程直接跑断言（dataService 顶层就 import 了 electron，tsx 里 import 它必炸）。
 *
 * 名单的两条来源、优先级：
 *   1. `meta.knownAdjustBias` —— 库内存档，最权威（_smoke/p5/seed_adjust_bias.py 写入）；
 *   2. `KNOWN_BASELINE`      —— 内置基线，只在「库内存档缺失 且 这是 baostock 存量库」时兜底。
 *
 * ⚠️ 第 2 条的诚实边界：内置基线描述的是**从 baostock 库迁移过来时必然带的那几行口径偏差**，
 * 对「全新库 / 已经重灌过的库」并不适用 —— 那种情况返回空数组，UI 就不显示这块，
 * 绝不为了让界面好看去编一条。
 */
import type { AdjustBiasEntry } from '@shared/types/ipc';

/** meta 里的键名 */
export const ADJUST_BIAS_KEY = 'knownAdjustBias';

const RECORDED_AT = '2026-10-06T10:30:00';

const FIX = 'preClose 改为上一根 qfq close（_smoke/p4/fix_preclose.py --apply，P4 已执行）';

/**
 * 内置基线（baostock 存量库 → 换源迁移时的已知偏差）。
 * 数据来源：docs/DATA_LAYER_MIGRATION.md §0.7，由 P4 实测扫描 + 修复得出。
 */
export const KNOWN_BASELINE: readonly AdjustBiasEntry[] = [
  {
    code: 'sz.301489',
    dates: ['2023-10-25'],
    kind: 'preClose-unadjusted',
    detail:
      'baostock 的 preClose 是未复权昨收、close 却是 qfq；除权日涨跌幅错算 +14.85%（真实 −41.88%）',
    fix: FIX,
    status: 'fixed',
    recordedAt: RECORDED_AT,
  },
  {
    code: 'sh.688808',
    dates: ['2026-04-27'],
    kind: 'preClose-unadjusted',
    detail: '同上口径冲突：除权日涨跌幅错算 +10.14%（真实 −25.58%）',
    fix: FIX,
    status: 'fixed',
    recordedAt: RECORDED_AT,
  },
  {
    code: 'sh.688720',
    dates: ['2023-12-08'],
    kind: 'preClose-unadjusted',
    detail: '同上口径冲突：除权日涨跌幅错算 +2.72%（真实 −26.61%）',
    fix: FIX,
    status: 'fixed',
    recordedAt: RECORDED_AT,
  },
  {
    code: '*',
    dates: [],
    kind: 'missing-qfq',
    detail:
      '【已证伪，留档】曾推测「近期大比例除权股」在腾讯 fqkline 里只有 day 没有 qfqday → 触发 no-data。' +
      '2026-10-06 实测：对 sz.301489/sh.688808/sh.688720 加 sh.600519/sz.000001 两只对照，' +
      '「近 6 根 / from=2023-10-01 / from=2024-01-01」三种打法，qfqday 均正常返回且 close 与库内一致。' +
      '根因是 fqkline 端点换过（老 web.ifzq.gtimg.cn 被 WAF 拦，现走 proxy.finance.qq.com）。',
    fix:
      'no-data 分类逻辑保留（响应缺该复权口径时确实该判它、不重试、保留库内原数据），' +
      '但不再当作「除权股专属症状」；providers/types.ts 注释已同步改写。',
    status: 'retained',
    recordedAt: RECORDED_AT,
  },
];

/**
 * 解析 meta.knownAdjustBias 的 JSON。
 * 坏数据一律当空名单返回 error，绝不抛 —— 这是设置页，不是数据管道，崩了就是体验事故。
 */
export function parseAdjustBias(
  raw: string | null,
): { entries: AdjustBiasEntry[]; error: string | null } {
  if (raw === null) return { entries: [], error: null };
  if (raw.trim() === '') return { entries: [], error: null };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { entries: [], error: 'meta.knownAdjustBias 不是合法 JSON' };
  }
  if (!Array.isArray(v)) return { entries: [], error: 'meta.knownAdjustBias 不是数组' };
  const entries: AdjustBiasEntry[] = [];
  for (const x of v) {
    if (typeof x !== 'object' || x === null) continue;
    const e = x as Partial<AdjustBiasEntry>;
    if (typeof e.code !== 'string' || !Array.isArray(e.dates)) continue;
    entries.push({
      code: e.code,
      dates: e.dates.filter((d): d is string => typeof d === 'string'),
      kind:
        e.kind === 'preClose-unadjusted' || e.kind === 'missing-qfq' || e.kind === 'amount-gap'
          ? e.kind
          : 'preClose-unadjusted',
      detail: typeof e.detail === 'string' ? e.detail : '',
      fix: typeof e.fix === 'string' ? e.fix : '',
      status: e.status === 'retained' ? 'retained' : 'fixed',
      recordedAt: typeof e.recordedAt === 'string' ? e.recordedAt : '',
    });
  }
  return { entries, error: null };
}

/**
 * 最终名单：库内存档优先，缺失且是 baostock 存量库才回落到内置基线。
 * 判据只看 `meta.dataSource`，不看行数 —— 新库重灌完就该是空的。
 */
export function resolveAdjustBias(
  raw: string | null,
  dataSource: string | null,
): { entries: AdjustBiasEntry[]; source: 'meta' | 'baseline' | 'empty'; error: string | null } {
  const parsed = parseAdjustBias(raw);
  if (parsed.entries.length > 0) return { entries: parsed.entries, source: 'meta', error: parsed.error };
  if (parsed.error !== null) return { entries: [], source: 'empty', error: parsed.error };
  if (dataSource === 'baostock') {
    return { entries: [...KNOWN_BASELINE], source: 'baseline', error: null };
  }
  return { entries: [], source: 'empty', error: null };
}
