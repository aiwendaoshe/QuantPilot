/**
 * 行情 Provider 层统一契约（v0.9.4 引入）。
 *
 * 设计红线（写新 provider 前先读）：
 *  1. **出口只有一个类型** `ProviderResult<T>`：成功/失败同构，调用方不用 try/catch；
 *  2. **单位统一**：volume=股、amount=元（与存量 baostock 库逐字段一致，换源零重灌）；
 *     腾讯 fqkline 给「手」、TDX 给「手」→ 入口统一 ×100；TDX 价格给「厘」→ ÷1000；
 *  3. **复权口径用 dataAdjust 显式声明**，registry 的硬闸门据此拦截「不复权源写 qfq 库」；
 *  4. 本层**不 import electron / electron-log**，保持可脱离 Electron 单测
 *     （`_smoke/test_providers.ts` 正是靠这点在纯 Node 下跑断言）；
 *  5. 代码统一 `sh600519`（不带点）——HTTP 源（腾讯/新浪）带点会直接报 `param error`，
 *     由 toProviderCode()/toDbCode() 在边界收发两端转换，业务层只见 sh.600519。
 */

export type AdjustMode = 'qfq' | 'hfq' | 'none';

/** DB 主键市场前缀 */
export type MarketCode = 'sh' | 'sz' | 'bj';

export type ProviderId = 'tencent' | 'sina' | 'tdx';

/** provider 归一后的单根日 K；单位见文件头 */
export interface ProviderBar {
  date: string; // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 股
  amount: number; // 元
  /**
   * 昨收。
   * ⚠️ 腾讯 fqkline / TDX / 东财 的 K 线接口**都不返回前收**，
   * 此处只能是「上一根 qfq close」的近似（除权日会偏），故首根填 0 由上层自算。
   */
  preClose: number;
}

/** 全市场名单条目（DB 主键格式 code） */
export interface UniverseItem {
  code: string; // 'sh.600519'
  name: string;
  market: MarketCode;
}

/** 实时/最新快照条目 */
export interface QuoteItem {
  code: string;
  name: string;
  market: MarketCode;
  close: number;
  preClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  volume: number; // 股
  amount: number; // 元
}

/**
 * 失败类型。
 * ⚠️ 'no-data' 与其余四类语义完全不同：它不是故障，而是「该源确实没有这只票的这个口径数据」
 * （响应里只有 day 没有 qfqday）。
 * 上层必须区别对待 —— 计入 no-data 而**不是** failed，且**不要重试**（重试多少次结果都一样）。
 *
 * 【2026-10-06 更正】早期注释写「实测集中在近期大比例除权股，约 2.5%」，**这条已不复现**：
 *   P5 对 sz.301489 / sh.688808 / sh.688720（3 只历史命中过的除权票）+ sh.600519 / sz.000001
 *   两只对照，用「近 6 根 / from=2023-10-01 / from=2024-01-01」三种打法打腾讯 fqkline，
 *   qfqday **始终存在**，close 与存量库逐位一致。
 *   根因：fqkline 端点换过（老 web.ifzq.gtimg.cn 被 WAF 拦，现走 proxy.finance.qq.com），
 *   老端点在除权票上只吐 day；P2/P3 的口径观测是在老端点上做的。
 *   → 判定逻辑保留（响应缺该复权口径就是 no-data），但别再把它当「除权股专属症状」。
 *   留档见 meta.knownAdjustBias 的 kind='missing-qfq' 条目。
 */
export type ProviderErrorKind = 'network' | 'protocol' | 'unsupported' | 'no-data' | 'exhausted';

export interface ProviderFailure {
  kind: ProviderErrorKind;
  message: string;
}

export type ProviderResult<T> =
  | { ok: true; provider: ProviderId; costMs: number; value: T }
  | { ok: false; provider: ProviderId; costMs: number; failure: ProviderFailure };

export interface DailyBarsOptions {
  /** 起始日 'YYYY-MM-DD'；省略 = 取最近 limit 根 */
  from?: string;
  /** 取最近 N 根；默认 320（对齐 strategy 的 SCREEN_BARS） */
  limit?: number;
  /** 期望的复权口径；registry 会按 dataAdjust 硬闸门过滤 */
  adjust?: AdjustMode;
  timeoutMs?: number;
}

export interface ProviderCapabilities {
  /** 全市场名单 */
  universe: boolean;
  /** 实时/最新快照（含昨收，可算涨跌幅） */
  snapshot: boolean;
  /** 日 K（受 dataAdjust 约束，见 registry 的 qfqOnly） */
  dailyBars: boolean;
  /** 行业/概念板块列表（M2；仅新浪提供） */
  sectors: boolean;
}

/** 能力层：UI 上「数据源」分三层各自选源 */
export type Capability = 'universe' | 'snapshot' | 'dailyBars';

/** 板块列表一行（M2，新浪行业板块） */
export interface SectorItem {
  /** 板块 id，如 new_blhy */
  id: string;
  name: string;
  /** 板块成分股数 */
  stockCount: number;
  /** 板块涨跌幅 % */
  changePct: number;
  /** 板块总成交额（元） */
  amount: number;
  /** 领涨股（库内 db code，如 sh600519） */
  leaderCode: string;
  leaderName: string;
  leaderChangePct: number;
}

export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly label: string;
  /**
   * 可选依赖提示：该源需要额外安装的第三方包，未安装时 UI 应置灰并给出这句文案。
   * 只作展示，registry 不据此翻转 capabilities（是否可用仍以真实能力判定为准）。
   */
  readonly optional?: string;
  /** 该源**主推**的复权口径（展示用，不是闸门依据） */
  readonly dataAdjust: AdjustMode;
  /**
   * 该源**实际能吐出**哪些复权口径 —— registry 硬闸门的唯一依据。
   *
   * 为什么必须是集合而不是单个值（P2 对拍暴露的设计缺陷）：
   *   早期写 `supported.includes` 时用的是 `dataAdjust === need`，
   *   但同一个源往往能同时给多档口径 —— 腾讯 fqkline 的 fq 字段传 qfq/hfq/none 都是有效值，
   *   于是「业务明确要不复权」这个正当请求会被防污染闸门误杀。
   *   集合语义同时保住了两件事：
   *     · need='qfq' 时 sina/tdx（只支持 none）被拦 → 不复权源写不进 qfq 库
   *     · need='none' 时 tencent 放行 → 想保全存量不复权口径的需求不被误杀
   */
  readonly supportedAdjust: readonly AdjustMode[];
  readonly capabilities: ProviderCapabilities;

  getUniverse(limit?: number): Promise<ProviderResult<UniverseItem[]>>;
  getSnapshot(codes: readonly string[]): Promise<ProviderResult<QuoteItem[]>>;
  getDailyBars(code: string, opts?: DailyBarsOptions): Promise<ProviderResult<ProviderBar[]>>;
  /** 板块列表（M2）；不支持的源返回 unsupported */
  getSectors(): Promise<ProviderResult<SectorItem[]>>;
  /** 某板块成分股（M2）；返回该板块全部成分（db code + 名称） */
  getSectorMembers(sectorId: string): Promise<ProviderResult<UniverseItem[]>>;

  /** 释放长连接（TDX）/ 清理计时器；必须幂等，可安全重复调用 */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 构造 ProviderResult 的小工具：让每个 provider 少写样板，且成功/失败字段永不手写错
// ---------------------------------------------------------------------------

export function ok<T>(provider: ProviderId, costMs: number, value: T): ProviderResult<T> {
  return { ok: true, provider, costMs, value };
}

export function fail<T>(
  provider: ProviderId,
  costMs: number,
  kind: ProviderErrorKind,
  message: string,
): ProviderResult<T> {
  return { ok: false, provider, costMs, failure: { kind, message } };
}

export function unsupported(provider: ProviderId, what: string): ProviderFailure {
  return { kind: 'unsupported', message: `${provider} 不支持${what}` };
}

// ---------------------------------------------------------------------------
// 代码格式转换（业务层只见 sh.600519，网络层只见 sh600519）
// ---------------------------------------------------------------------------

/** 'sh.600519' | 'sh600519' → 'sh600519'（HTTP 源要求不带点） */
export function toProviderCode(code: string): string {
  return code.replace('.', '');
}

/** 'sh600519' | 'sh.600519' → 'sh.600519'（DB 主键） */
export function toDbCode(code: string): string {
  return code.includes('.') ? code : code.slice(0, 2) + '.' + code.slice(2);
}

/** 'sh.600519' | 'sh600519' → 'sh'（market 字段 + TDX 市场字节） */
export function marketOf(code: string): MarketCode {
  const s = code.replace('.', '');
  if (s.startsWith('sh')) return 'sh';
  if (s.startsWith('sz')) return 'sz';
  return 'bj';
}

/** 数值字段解析：空串/'-'/'--' 一律 NaN→0，避免脏数据污染 SQLite REAL 列 */
export function num(v: string | number | undefined | null): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v === undefined || v === null) return 0;
  const s = v.trim();
  if (s === '' || s === '-' || s === '--') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
