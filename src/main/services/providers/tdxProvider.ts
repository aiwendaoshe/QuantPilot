/**
 * 通达信 TDX Provider（盘中实时可选源）。
 *
 * ⚠️ 关于自研协议：TDX 是私有二进制协议（本机实测：
 *    13 字节握手帧 `0c 00 00 00 00 01 03 00 03 00 0d 00 01`，
 *    日 K 帧 38 字节 `0c 01 00 00 00 01 | u16LE 28 | u16LE 28 | u16BE 0x2D05 |
 *    market@12 | code@14(6B) | category@20=9 | start u16LE@22 | count u16LE@25`，
 *    请求发出后 46ms 即回包；但响应侧带压缩/混淆层，自研解析风险高）
 *    → 这里**不重写协议栈**，改为薄适配 `node-tdx-market`（可选依赖）。
 *
 * 为什么值得保留这一层：
 *  - 实测本机房 6 台 TDX 服务器有 3 台可用（20~63ms），getQuote 两只需 25ms，
 *    是「盘中实时刷新」里最快的一条腿；
 *  - 迁移目标是**去掉 Python**，不是去掉所有依赖；
 *  - 最重要的：TDX 是**不复权**口径（dataAdjust='none'），被 registry 硬闸门挡在 qfq 日 K
 *    降级链之外，装不装它都不影响主链路数据正确性 —— 缺失它只是少一个实时源。
 *
 * 启用方式：`npm i node-tdx-market`（不装则本 provider 自动 unavailable，不报错）。
 */
import { createRequire } from 'node:module';
import {
  marketOf,
  num,
  ok,
  toDbCode,
  type MarketDataProvider,
  type ProviderId,
  type ProviderResult,
  type QuoteItem,
  type SectorItem,
  type UniverseItem,
} from './types';

/** node-tdx-market 的最小契约（只声明我们用到的部分，避免依赖它的 .d.ts） */
interface TdxLikeClient {
  on(event: string, cb: (arg: unknown) => void): void;
  connect(): Promise<unknown>;
  getQuote(codes: readonly string[]): Promise<TdxLikeQuote[]>;
  disconnect(): void;
}

interface TdxLikeQuote {
  fullCode?: string;
  exchange?: number;
  code?: string;
  lastClose?: number;
  open?: number;
  high?: number;
  low?: number;
  price?: number;
  volume?: number;
  amount?: number;
}

type TdxClientCtor = new (opts?: { autoReconnect?: boolean }) => TdxLikeClient;

function loadTdxClient(): TdxClientCtor | null {
  try {
    const mod: unknown = createRequire(__filename)('node-tdx-market');
    if (typeof mod === 'object' && mod !== null && 'TdxClient' in mod) {
      const raw = (mod as Record<string, unknown>).TdxClient;
      if (typeof raw === 'function') return raw as TdxClientCtor;
    }
  } catch {
    // 未安装 / ABI 不匹配：按「不支持」处理，绝不抛到调用链
  }
  return null;
}

export class TdxProvider implements MarketDataProvider {
  readonly id: ProviderId = 'tdx';
  readonly label = '通达信 TDX';
  readonly optional = '未安装可选依赖 node-tdx-market';
  /** 不复权 */
  readonly dataAdjust = 'none' as const;
  /** TDX 通达信协议只给不复权 K 线 → 天然写不进 qfq 库，被闸门挡住是预期行为 */
  readonly supportedAdjust = ['none'] as const;
  readonly capabilities: { universe: false; snapshot: boolean; dailyBars: false; sectors: false };

  private readonly Ctor: TdxClientCtor | null;
  private client: TdxLikeClient | null = null;

  constructor() {
    this.Ctor = loadTdxClient();
    this.capabilities = { universe: false, snapshot: this.Ctor !== null, dailyBars: false, sectors: false };
  }

  async getUniverse(_limit?: number) {
    return {
      ok: false,
      provider: this.id,
      costMs: 0,
      failure: { kind: 'unsupported', message: `${this.label} 不支持全市场名单` },
    } as ProviderResult<UniverseItem[]>;
  }

  async getSectors() {
    return {
      ok: false,
      provider: this.id,
      costMs: 0,
      failure: { kind: 'unsupported', message: `${this.label} 不支持板块列表` },
    } as ProviderResult<SectorItem[]>;
  }

  async getSectorMembers(_sectorId: string) {
    return {
      ok: false,
      provider: this.id,
      costMs: 0,
      failure: { kind: 'unsupported', message: `${this.label} 不支持板块成分` },
    } as ProviderResult<UniverseItem[]>;
  }

  async getSnapshot(codes: readonly string[]): Promise<ProviderResult<QuoteItem[]>> {
    if (this.Ctor === null) {
      return {
        ok: false,
        provider: this.id,
        costMs: 0,
        failure: { kind: 'unsupported', message: '未安装 node-tdx-market（盘中实时源可选）' },
      } as ProviderResult<QuoteItem[]>;
    }
    const t0 = Date.now();
    let client = this.client;
    if (client === null) {
      client = new this.Ctor({ autoReconnect: false });
      client.on('error', (e) => {
        // 连接断了就丢掉旧实例，下次调用重连（长连接保活交给上层 registry 重试）
        if (this.client === client) this.client = null;
        void e;
      });
      try {
        await client.connect();
      } catch (e) {
        this.client = null;
        return {
          ok: false,
          provider: this.id,
          costMs: Date.now() - t0,
          failure: { kind: 'network', message: `TDX 连不上：${String(e)}` },
        } as ProviderResult<QuoteItem[]>;
      }
      this.client = client;
    }
    try {
      const raw = await client.getQuote(codes.map((c) => c.replace('.', '')));
      const value = raw.map((q) => this.mapQuote(q));
      return ok(this.id, Date.now() - t0, value);
    } catch (e) {
      this.client = null;
      return {
        ok: false,
        provider: this.id,
        costMs: Date.now() - t0,
        failure: { kind: 'network', message: `TDX 快照失败：${String(e)}` },
      } as ProviderResult<QuoteItem[]>;
    }
  }

  /** TDX 内部口径：价格 ×1000（厘）、金额 ×1000、成交量「手」→ 统一换成 元/股 */
  private mapQuote(q: TdxLikeQuote): QuoteItem {
    const code = q.fullCode ?? `${q.exchange ?? 0}${q.code ?? ''}`;
    const close = num(q.price) / 1000;
    const preClose = num(q.lastClose) / 1000;
    return {
      code: toDbCode(code.length > 2 ? code : 'sh000000'),
      name: '',
      market: marketOf(code),
      close,
      preClose,
      open: num(q.open) / 1000,
      high: num(q.high) / 1000,
      low: num(q.low) / 1000,
      change: close - preClose,
      changePct: preClose > 0 ? ((close - preClose) / preClose) * 100 : 0,
      volume: num(q.volume) * 100,
      amount: num(q.amount) / 1000,
    };
  }

  async getDailyBars() {
    return {
      ok: false,
      provider: this.id,
      costMs: 0,
      failure: { kind: 'unsupported', message: `${this.label} 只提供实时快照，日 K 走腾讯 qfq` },
    } as ProviderResult<never>;
  }

  dispose(): void {
    try {
      this.client?.disconnect();
    } catch {
      // 断开失败无所谓，进程退出即释放
    }
    this.client = null;
  }
}
