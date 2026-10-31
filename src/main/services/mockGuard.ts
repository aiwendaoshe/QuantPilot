/**
 * 【R1 风险前置】演示数据（mock）播种闸门 —— 纯函数层。
 *
 * 为什么必须有这一层：
 *   `seedMockData()` 是全量重灌，事务里先 `DELETE FROM daily` 再 INSERT。
 *   这意味着**在真实行情库上调用一次 = 几十万~几百万根历史 K 线当场清空**。
 *   旧守卫判的是 `meta.dataSource === 'baostock'`（`dataService.ts` 里的 `cur === 'baostock'`），
 *   一旦数据换成 Node Provider 写库，`meta.dataSource` 永远不会再出现 'baostock' →
 *   该判据**恒为 false → 守卫形同虚设 → 用户点一次"拉取"就把历史库抹了**。
 *
 * 为什么判据用 barCount 而不是 meta：
 *   `meta.dataSource` 是**可被写入层改写的可变状态**（换源、降级、未来改 schema 都会动它）；
 *   而 `daily` 表里的行数（barCount）是**数据库里实打实躺着的行**，不依赖任何字符串约定，
 *   换源/改 schema/加 provider 都不会让它过期。宁可多查一次 COUNT(*)，也不能让守卫生效依赖一个会变的字符串。
 *
 * 为什么判据是「barCount>0 且 不是 mock 库」而不是单纯「barCount>0」：
 *   库分三种：
 *     ① 空库（首次运行）        → 允许 mock，否则新用户打开就是一片空白，体验直接死；
 *     ② mock 库（本身就是演示库）→ 允许重灌，用户想重看演示效果得有路可走；
 *     ③ 真实库（baostock / 未来的 Node provider）→ **一律拒绝**，这是本闸的核心。
 *   只写「barCount>0 一律拒」会把 ② 也堵死，那是过度防护。
 *
 * 本文件刻意不 import electron / electron-log / better-sqlite3：
 *   保持纯函数，才能被 `_smoke/test_mockGuard.ts` 在纯 Node 下真跑断言（而不是"看着像对"）。
 */

/** meta.dataSource 的取值约定：演示数据会把自己写成这个值 */
export const MOCK_DATA_SOURCE = 'mock';

/** 'baostock' 是本项目的老真实源标识，换成 Node provider 后仅作历史兼容保留 */
export const LEGACY_REAL_DATA_SOURCE = 'baostock';

export interface SeedGate {
  /** true = 允许播种演示数据；false = 必须拒绝（调用方不该DELETE、不该写库） */
  allowed: boolean;
  /** 决定性理由，直接进日志、必要时透出给用户看 */
  reason: string;
  /** 库内当前行数，给上层日志与状态展示用 */
  barCount: number;
}

/**
 * 核心判据。调用方负责把「库内行数」和「meta.dataSource」取回来传进来，
 * 这样本函数保持零依赖、可单测。
 *
 * @param barCount   daily 表当前行数（= 真实 K 线总量）
 * @param dataSource meta.dataSource 当前值（null = 从未写过）
 */
export function canSeedMock(barCount: number, dataSource: string | null): SeedGate {
  if (!Number.isFinite(barCount) || barCount < 0) {
    return { allowed: false, reason: `库内行数非法(${barCount})，拒绝写入演示数据`, barCount };
  }
  if (barCount === 0) {
    return { allowed: true, reason: '空库：首次运行需要演示数据兜底，允许播种', barCount };
  }
  if (dataSource === MOCK_DATA_SOURCE) {
    return { allowed: true, reason: '当前已是演示库，允许重灌演示数据', barCount };
  }
  return {
    allowed: false,
    reason: `库内已有 ${barCount} 根真实 K 线（dataSource=${dataSource ?? 'null'}）`,
    barCount,
  };
}

/**
 * 被拒时给用户的提示。要点：说清「没动你的数据」，别让人以为拉取失败了还丢了数据。
 *
 * @param gate canSeedMock 的返回
 * @param extra 可选的上游错误（如 baostock 拉取失败的原因），拼在后面一起回传
 */
export function seedRefusalMessage(gate: SeedGate, extra?: string): string {
  const base = `${gate.reason}；演示数据为全量重灌会清空历史，已拒绝写入。本地原有数据未被修改`;
  return extra ? `${base}（上游：${extra}）` : base;
}

/**
 * 拒绝播种时，写给 PullResult.source 的值。
 *
 * 关键点：**绝不能回 'mock'** —— 前端 `isMock = dataSource === 'mock'` 是三页共用的假数据红标，
 * 守卫拦住了却返回 source:'mock'，等于一边说"没动你的数据"一边告诉用户"你现在看的是假的"，自打耳光。
 * 真实数据还在，就按真实数据报。
 *
 * 返回类型暂时收敛在 'baostock' | 'mock'：R1 阶段 meta.dataSource 仍只会写这两个值。
 * 换 Node provider 后（meta 会写 'tencent' 等），把这个联合扩开即可。
 */
export function realSourceLabel(dataSource: string | null): 'baostock' | 'mock' {
  if (dataSource === MOCK_DATA_SOURCE) return MOCK_DATA_SOURCE as 'mock';
  return LEGACY_REAL_DATA_SOURCE as 'baostock';
}
