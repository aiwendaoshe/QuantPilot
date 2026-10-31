/**
 * Provider 注册表 + 跨源降级 —— Provider 层唯一的对外入口。
 *
 * 两条硬闸门（本文件存在的全部理由）：
 *
 * ① **复权闸门**：期望口径 `need` 不在源的 `supportedAdjust` 集合里时，该源**绝不**进日 K 降级链。
 *    典型场景：要把不复权 K 线写进前复权库，除权日附近会算出**假涨停/假跌停**，
 *    直接污染选股与回测 —— 这类错误不会报错、只会静默算错，必须靠类型外的运行时闸门拦死。
 *    故 need='qfq' 时只有 tencent 能进链，sina/tdx（只支持不复权）被拦。
 *    ⚠️ 反过来 need='none' 时必须放行腾讯（见 types.ts 的注释），否则会误杀正当的不复权需求。
 *
 * ② **熔断闸门**：单源连续失败 3 次/30s 直接短路，别让 5000 只票在一个挂掉的源上干等。
 *
 * 另有两条软规则：
 *  - 名单/快照没有复权概念，不受闸门①限制，按 capabilities 挑源即可；
 *  - 单只失败可跨源重试：全市场扫描里某只票超时，换下一个源即可，不中断整批。
 */
import { Breaker } from './breaker';
import { SinaProvider } from './sinaProvider';
import { TdxProvider } from './tdxProvider';
import { TencentProvider } from './tencentProvider';
import type { BreakerState } from './breaker';
import type {
  AdjustMode,
  Capability,
  DailyBarsOptions,
  MarketDataProvider,
  ProviderId,
  ProviderResult,
  UniverseItem,
  QuoteItem,
} from './types';

const providers: MarketDataProvider[] = [];
const breakers = new Map<ProviderId, Breaker>();

/**
 * 用户偏好选源（P4：「界面上能自选拉股接口」落点之一）。
 * 三层各自记住一个首选：`meta.providerPref.<cap>` 由 dataService 持久化，启动时 applyPreference 回灌。
 *
 * ⚠️ 偏好只是**排序加权**，不是硬绑：首选源正在熔断时，pick() 照常回退到次源，
 * 否则一次限流就会把整批 5400 只票卡死 —— 这是「用户自选」和「可用性」的边界。
 */
const preferred = new Map<Capability, ProviderId>();

/**
 * 锁死层的默认首选（P4）。
 * 日 K 层不给用户选：存量库 369 万根是腾讯 qfq 口径，换源实测会改写 37.54% 的行
 * （docs/DATA_LAYER_MIGRATION.md §0.5）。这里默认钉死它，
 * 顺带让「锁死」这件事在 registry 里有据可查，而不是只写在 UI 文案里。
 */
const LOCKED: Partial<Record<Capability, ProviderId>> = { dailyBars: 'tencent' };

function breakerFor(id: ProviderId): Breaker {
  const b = breakers.get(id);
  if (b) return b;
  const created = new Breaker();
  breakers.set(id, created);
  return created;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 注册一个数据源；重复注册同 id 会被忽略 */
export function register(provider: MarketDataProvider): void {
  if (providers.some((p) => p.id === provider.id)) return;
  providers.push(provider);
}

/** 默认装配：腾讯（qfq 主力）+ 新浪（名单兜底）+ TDX（实时可选） */
export function bootstrapDefaultProviders(): void {
  register(new TencentProvider());
  register(new SinaProvider());
  register(new TdxProvider());
  // 幂等：上面 register 已去重，这里再钉一次锁死层的默认首选
  if (!preferred.has('dailyBars')) preferred.set('dailyBars', 'tencent');
}

export function allProviders(): readonly MarketDataProvider[] {
  return providers;
}

export function getProvider(id: ProviderId): MarketDataProvider | undefined {
  return providers.find((p) => p.id === id);
}

function usable(p: MarketDataProvider): boolean {
  return breakerFor(p.id).allow();
}

/**
 * 挑源：只取「支持该能力」且「能吐出期望复权口径」的源，再按「用户偏好 → 注册顺序」排序。
 *
 * ⚠️ 判定用 supportedAdjust 集合而不是 dataAdjust 单值 —— 详见 types.ts 的注释。
 */
function pick(need: AdjustMode, cap: Capability): MarketDataProvider[] {
  const same = providers.filter(
    (p) => p.capabilities[cap] && usable(p) && p.supportedAdjust.includes(need),
  );
  // 用户偏好排最前；偏好源若不在候选里（被熔断/不支持该口径），顺序自然不变 —— 不硬绑
  return preferred.has(cap)
    ? [...same].sort((a, b) => (preferred.get(cap) === a.id ? -1 : preferred.get(cap) === b.id ? 1 : 0))
    : same;
}

// ---------------------------------------------------------------------------
// 日 K（受复权闸门约束，这是唯一会被写进 qfq 库的数据）
// ---------------------------------------------------------------------------

export async function fetchDailyBars(
  code: string,
  opts: DailyBarsOptions = {},
): Promise<ProviderResult<import('./types').ProviderBar[]>> {
  const need = opts.adjust ?? 'qfq';
  const candidates = pick(need, 'dailyBars');
  if (candidates.length === 0) {
    return {
      ok: false,
      provider: 'tencent',
      costMs: 0,
      failure: {
        kind: 'exhausted',
        message: `没有可用数据源（期望复权口径=${need}）`,
      },
    } as ProviderResult<import('./types').ProviderBar[]>;
  }

  const errors: string[] = [];
  // 只要出现过「真故障」（网络/协议/超时），最终就报 exhausted；
  // 全是 no-data 才报 no-data —— 让上层能区分「源挂了」与「这只票本来就没这个口径」。
  let sawRealFailure = false;
  for (const p of candidates) {
    try {
      // 单只重试：实测腾讯源 **约 1.6% 的单只请求会偶发失败**（超时/WAF 抖动），
      // 重试间隔带随机抖动，避免整批同时重试又被限流。
      // ⚠️ no-data 不重试：那是确定性结论（该标的无此复权口径），重试多少次都一样。
      let res = await p.getDailyBars(code, opts);
      for (
        let attempt = 1;
        !res.ok && res.failure.kind !== 'no-data' && attempt < 2;
        attempt += 1
      ) {
        await sleep(120 + Math.floor(Math.random() * 180));
        res = await p.getDailyBars(code, opts);
      }
      if (res.ok) {
        breakerFor(p.id).recordSuccess();
        return res;
      }
      if (res.failure.kind === 'no-data') {
        errors.push(`${p.id}: no-data ${res.failure.message}`);
        continue; // 不记熔断：源没坏，只是这只票没数据
      }
      sawRealFailure = true;
      breakerFor(p.id).recordFailure();
      errors.push(`${p.id}: ${res.failure.kind} ${res.failure.message}`);
    } catch (e) {
      sawRealFailure = true;
      breakerFor(p.id).recordFailure();
      errors.push(`${p.id}: throw ${String(e)}`);
    }
  }
  return {
    ok: false,
    provider: candidates[0]?.id ?? 'tencent',
    costMs: Date.now(),
    failure: {
      kind: sawRealFailure ? 'exhausted' : 'no-data',
      message: errors.slice(0, 3).join(' | '),
    },
  } as ProviderResult<import('./types').ProviderBar[]>;
}

// ---------------------------------------------------------------------------
// 名单（无复权概念，不受闸门限制）
// ---------------------------------------------------------------------------

export async function fetchUniverse(limit?: number): Promise<ProviderResult<UniverseItem[]>> {
  const candidates = providers.filter((p) => p.capabilities.universe && usable(p));
  const errors: string[] = [];
  for (const p of candidates) {
    try {
      const res = await p.getUniverse(limit);
      if (res.ok) {
        breakerFor(p.id).recordSuccess();
        return res;
      }
      breakerFor(p.id).recordFailure();
      errors.push(`${p.id}: ${res.failure.message}`);
    } catch (e) {
      breakerFor(p.id).recordFailure();
      errors.push(`${p.id}: throw ${String(e)}`);
    }
  }
  return {
    ok: false,
    provider: candidates[0]?.id ?? 'sina',
    costMs: 0,
    failure: { kind: 'exhausted', message: errors.slice(0, 3).join(' | ') || '无可用名单源' },
  } as ProviderResult<UniverseItem[]>;
}

// ---------------------------------------------------------------------------
// 快照（无复权概念；TDX 快但不装依赖时自动跳过）
// ---------------------------------------------------------------------------

export async function fetchSnapshot(codes: readonly string[]): Promise<ProviderResult<QuoteItem[]>> {
  const candidates = providers.filter((p) => p.capabilities.snapshot && usable(p));
  const errors: string[] = [];
  for (const p of candidates) {
    try {
      const res = await p.getSnapshot(codes);
      if (res.ok) {
        breakerFor(p.id).recordSuccess();
        return res;
      }
      breakerFor(p.id).recordFailure();
      errors.push(`${p.id}: ${res.failure.message}`);
    } catch (e) {
      breakerFor(p.id).recordFailure();
      errors.push(`${p.id}: throw ${String(e)}`);
    }
  }
  return {
    ok: false,
    provider: candidates[0]?.id ?? 'tencent',
    costMs: 0,
    failure: { kind: 'exhausted', message: errors.slice(0, 3).join(' | ') || '无可用快照源' },
  } as ProviderResult<QuoteItem[]>;
}

// ---------------------------------------------------------------------------
// 用户偏好选源（P4）
// ---------------------------------------------------------------------------

/** 设置用户指定的首选源（传 null 清除偏好，回到注册顺序） */
export function setPreferred(cap: Capability, id: ProviderId | null): void {
  // 锁死层：只有注册时的那个默认源能进，别的（包括用户手抖）一律拒
  if (LOCKED[cap] !== undefined && id !== null && id !== LOCKED[cap]) {
    throw new Error(`${cap} 层已锁死为 ${LOCKED[cap]}，不支持改成 ${id}`);
  }
  if (id === null) {
    preferred.delete(cap);
    return;
  }
  if (!providers.some((p) => p.id === id && p.capabilities[cap])) {
    // 该源不支持这个能力（例如给名单层选 tdx）→ 直接拒，别让下拉里能选的东西实际不生效
    throw new Error(`${id} 不支持该能力层（${cap}），已忽略`);
  }
  preferred.set(cap, id);
}

export function preferredOf(cap: Capability): ProviderId | null {
  return preferred.get(cap) ?? null;
}

/** 快照/名单层的候选（不含熔断判定，纯能力） */
export function candidatesOf(cap: Capability): ProviderId[] {
  return providers.filter((p) => p.capabilities[cap]).map((p) => p.id);
}

/**
 * 日 K 源健康快照（M6）。
 *
 * 日 K 层锁死腾讯 qfq 且**无降级兜底**（sina/tdx 的 capabilities.dailyBars 都是 false，
 * 结构上就取不到 qfq 日 K）。所以「是否降级」只能诚实地读腾讯自己的熔断状态：
 *   - closed    → 正常，腾讯在服务
 *   - open      → 已熔断（连续失败触发），日 K 暂时拉不到 → UI 必须显示「降级/不可用」
 *   - half-open → 冷却后试探中
 * 换句话说：dailyBars 层现在**没有**「自动回退到次源」这回事（M6 只做指示，不放开 LOCKED），
 * 腾讯熔断就等于日 K 停摆，UI 要把这件事告诉用户而不是静默。
 */
export function dailySourceHealth(): { provider: ProviderId; breaker: BreakerState } {
  const id = LOCKED.dailyBars ?? 'tencent';
  return { provider: id, breaker: breakerFor(id).state };
}

// ---------------------------------------------------------------------------
// 供 UI 渲染的源清单（状态灯数据来源）
// ---------------------------------------------------------------------------

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  /** 是否需要额外安装依赖（TDX 为 true） */
  optional: boolean;
  /** 是否需要额外安装依赖时的说明文案 */
  requiredPackage: string | null;
  /** 熔断状态；closed = 正常 */
  breaker: BreakerState;
  /** 是否被设为某一层的首选 */
  preferredIn: Capability | null;
}

export interface LayerDescriptor {
  cap: Capability;
  /** 结构上支持该能力的全部源（含不可用/熔断） */
  options: ProviderId[];
  /** 当前真正能服务的源（含熔断判定） */
  available: ProviderId[];
  preferred: ProviderId | null;
}

export function describeProviders(): ProviderDescriptor[] {
  return providers.map((p) => ({
    id: p.id,
    label: p.label,
    optional: p.optional !== undefined,
    requiredPackage: p.optional ?? null,
    breaker: breakerFor(p.id).state,
    preferredIn: (['universe', 'snapshot', 'dailyBars'] as Capability[]).find((c) => preferred.get(c) === p.id) ?? null,
  }));
}

export function describeLayers(): LayerDescriptor[] {
  const caps: Capability[] = ['universe', 'snapshot', 'dailyBars'];
  return caps.map((cap) => {
    const options = candidatesOf(cap);
    return {
      cap,
      options,
      // 名单/快照没有复权概念，只看熔断；日 K 还要过 qfq 闸门（不复权源天然进不了链）
      available: options.filter((id) => {
        const p = providers.find((x) => x.id === id);
        if (p === undefined || !usable(p)) return false;
        return cap === 'dailyBars' ? p.supportedAdjust.includes('qfq') : true;
      }),
      preferred: preferred.get(cap) ?? null,
    };
  });
}

/** 全源释放（app.quit 前调用一次） */
export function disposeAll(): void {
  for (const p of providers) {
    try {
      p.dispose();
    } catch {
      // 释放失败无所谓
    }
  }
  providers.length = 0;
  breakers.clear();
}
