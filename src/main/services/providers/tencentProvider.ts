/**
 * 腾讯行情 Provider（主力源）。
 *
 * 端点（来源：腾讯财经公开 Web 接口，非官方 SDK）：
 *  - 前复权日 K：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,<from>,,<count>,qfq
 *  - 实时快照：https://qt.gtimg.cn/q=<code1>,<code2>…
 *
 * 实测结论（2026-09 本机电信出口）：
 *  - fqkline qfq 与前复权存量库逐字段一致 → **换源零重灌**（573MB/369 万根不必重建）；
 *  - 200 只并发 6 = 3.1s、0 失败、峰值 217ms/只 → 外推全市场 5571 只 ≈ 1.4 分钟；
 *  - code **必须不带点**（sh600519），带点会返回 `{"code":0,"msg":"param error"}`；
 *  - ⚠️ 快照中文名是 GBK，必须用 TextDecoder('gbk')，直接 toString('utf8') 是乱码。
 */
import { getBuffer, getText, mapLimit } from './http';
import {
  fail,
  marketOf,
  num,
  ok,
  toDbCode,
  toProviderCode,
  type MarketDataProvider,
  type ProviderId,
  type ProviderResult,
  type QuoteItem,
  type UniverseItem,
} from './types';

/**
 * ⚠️ 端点换过：老的 `web.ifzq.gtimg.cn/appstock/app/fqkline/get` 曾被腾讯 WAF 拦
 * （HTTP 501 + 跳 waf.tencent.com 挑战页），主源改走 proxy.finance.qq.com/ifzqgtimg 前缀。
 *
 * ✅ M6 更新（2026-10-06 实测）：老 host **已恢复可用**（HTTP 200），且与主 host 返回
 * **逐字节一致**的 qfq（茅台近 10 日对拍完全相同）。WAF 拦截是间歇性的，不是永久封禁。
 * → 把两个 host 都列上，按顺序 failover：**同源同口径**的冗余，不碰 qfq 库、不违反 LOCKED。
 *
 * 降级触发条件（重要）：只在**传输层失败**（连接被拒 / 超时 / 5xx / 403 / 429）时切 host；
 * 拿到 HTTP 200 响应后即使解析出 no-data / param error 也**不切**——那是 host 无关的
 * 确定性结论（同一后端两个 host 行为一致，实测对拍验证），切了也是白切一遍。
 */
const FQ_HOSTS = [
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
] as const;
const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const GBK = new TextDecoder('gbk');

export interface TencentProviderOptions {
  /** 快照单批最多多少只（qt.gtimg.cn 一次塞几千只容易被限） */
  snapshotBatch?: number;
  snapshotConcurrency?: number;
  /**
   * 日 K（fqkline）host 列表，按顺序 failover（M6）。默认 FQ_HOSTS（主 + 老 host）。
   * 注入点仅供测试/未来换 host；生产走默认即可。
   */
  fqHosts?: readonly string[];
}

export class TencentProvider implements MarketDataProvider {
  readonly id: ProviderId = 'tencent';
  readonly label = '腾讯财经';
  /** 该源吐出的是前复权 → 唯一允许写进 qfq 库的源 */
  readonly dataAdjust = 'qfq' as const;
  /** 腾讯 fqkline 的 fq 字段实测传 qfq / hfq / none（甚至留空）都有效，三种口径全支持 */
  readonly supportedAdjust = ['qfq', 'hfq', 'none'] as const;
  readonly capabilities = { universe: false, snapshot: true, dailyBars: true, sectors: false };

  private readonly snapshotBatch: number;
  private readonly snapshotConcurrency: number;
  private readonly fqHosts: readonly string[];

  constructor(opts: TencentProviderOptions = {}) {
    this.snapshotBatch = Math.max(1, opts.snapshotBatch ?? 80);
    this.snapshotConcurrency = Math.max(1, opts.snapshotConcurrency ?? 6);
    this.fqHosts = opts.fqHosts ?? FQ_HOSTS;
  }

  async getUniverse(_limit?: number) {
    return fail<UniverseItem[]>(this.id, 0, 'unsupported', '腾讯侧名单接口不稳定，统一走 sinaProvider');
  }

  async getSectors() {
    return fail<import('./types').SectorItem[]>(this.id, 0, 'unsupported', '腾讯板块接口未验证，统一走 sinaProvider');
  }

  async getSectorMembers(_sectorId: string) {
    return fail<UniverseItem[]>(this.id, 0, 'unsupported', '腾讯板块成分未验证，统一走 sinaProvider');
  }

  async getSnapshot(codes: readonly string[]): Promise<ProviderResult<QuoteItem[]>> {
    const t0 = Date.now();
    const batches: string[][] = [];
    for (let i = 0; i < codes.length; i += this.snapshotBatch) {
      batches.push(codes.slice(i, i + this.snapshotBatch).map(toProviderCode));
    }
    // 一批失败不该带崩整批：逐批发，失败批空着（调用方按 code 对齐即可）
    const groups = await mapLimit(batches, this.snapshotConcurrency, (batch) =>
      this.fetchOneBatch(batch).catch(() => [] as QuoteItem[]),
    );
    const value = groups.flat();
    if (value.length === 0) {
      return fail<QuoteItem[]>(this.id, Date.now() - t0, 'network', '腾讯快照全部批次失败');
    }
    return ok(this.id, Date.now() - t0, value);
  }

  private async fetchOneBatch(batch: readonly string[]): Promise<QuoteItem[]> {
    const buf = await getBuf(QUOTE_URL + batch.join(','));
    const text = GBK.decode(buf);
    const out: QuoteItem[] = [];
    // v_sh600519="1~贵州茅台~600519~1258.62~1235.58~..."
    const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const raw = m[2] ?? '';
      const a = raw.split('~');
      // 字段下标经实测确认（茅台：现价 1258.62 / 昨收 1235.58 / 量 38331 手 / 额 479725 万）
      if (a.length < 38) continue;
      const code = toDbCode(m[1] ?? '');
      const close = num(a[3]);
      const preClose = num(a[4]);
      out.push({
        code,
        name: a[1] ?? '',
        market: marketOf(code),
        close,
        preClose,
        open: num(a[5]),
        high: num(a[33]),
        low: num(a[34]),
        change: Number((close - preClose).toFixed(4)),
        changePct: preClose > 0 ? Number((((close - preClose) / preClose) * 100).toFixed(4)) : 0,
        volume: num(a[36]) * 100, // 手 → 股
        amount: num(a[37]) * 10_000, // 万元 → 元
      });
    }
    return out;
  }

  async getDailyBars(code: string, opts?: Parameters<MarketDataProvider['getDailyBars']>[1]) {
    const t0 = Date.now();
    const cd = toProviderCode(code);
    const count = String(opts?.limit ?? 320);
    const adjust = opts?.adjust ?? 'qfq';
    // 有 from 时必须是 `cd,day,from,,count,fq`；没有 from 时是 `cd,day,,,count,fq`
    const param = opts?.from
      ? `${cd},day,${opts.from},,${count},${adjust}`
      : `${cd},day,,,${count},${adjust}`;

    // M6 host 级 failover：只在「传输层失败」时切 host（连接被拒/超时/5xx/403/429）；
    // 拿到 200 响应后的解析结论（no-data / protocol）是 host 无关的确定结果，直接返回不切，
    // 避免同一后端白切一遍。全部 host 都传输失败 → 报 network。
    let lastTransportError: string | null = null;
    for (const host of this.fqHosts) {
      let text: string;
      try {
        // ⚠️ 逗号**不能** encodeURIComponent —— 实测整串编码后腾讯直接回 HTTP 501，
        // 逗号本身在 query string 里合法，保持原样即可。
        text = await getText(`${host}?param=${param}`, {
          timeoutMs: opts?.timeoutMs ?? 10_000,
        });
      } catch (e) {
        // 传输层失败（HttpError 5xx/403/429、超时、DNS、连接被拒…）→ 换下一个 host
        lastTransportError = String(e);
        continue;
      }

      // 以下为「已拿到 200 响应」的解析路径：与 host 无关，直接给结论。
      // ⚠️ 但 WAF 软封会返回 200 + HTML 挑战页（body 非 JSON）——这属于「这个 host 被挡了」，
      //    必须当 host 级失败切下一个，而不是让 JSON.parse 抛出去把整个方法炸掉。
      let root: {
        code?: number;
        msg?: string;
        data?: Record<string, { qfqday?: unknown[][]; hfqday?: unknown[][]; day?: unknown[][] }>;
      };
      try {
        root = JSON.parse(text) as typeof root;
      } catch (e) {
        lastTransportError = `host 返回非 JSON（WAF 软封?）: ${String(e)}`;
        continue;
      }
      const key = adjust === 'qfq' ? 'qfqday' : adjust === 'hfq' ? 'hfqday' : 'day';
      const node = root.data?.[cd];
      const rows = node?.[key];
      if (!Array.isArray(rows) || rows.length === 0) {
        // 区分「该标的没有这个复权口径的数据」与「接口异常」：
        // 前者是确定性事实（响应里 day 有、qfqday 没有），重试多少次都一样，
        // 必须报 'no-data' 让上层跳过并保留库内原数据，而不是当成故障反复重试。
        const hasOther = node !== undefined && Object.keys(node).length > 0;
        return fail<import('./types').ProviderBar[]>(
          this.id,
          Date.now() - t0,
          hasOther ? 'no-data' : 'protocol',
          hasOther
            ? `该标的无 ${adjust} 数据（响应仅有 ${Object.keys(node ?? {}).join('/')}）`
            : `腾讯 K 线返回为空（msg=${root.msg ?? '-'}）`,
        );
      }
      // ⚠️⚠️ volume 单位在**科创板上不一样**，这是实测踩出来的坑（P2 对拍证据）：
      //   · 沪主板 60 / 深主板 00 / 创业板 30 → 单位是「手」，需 ×100 才是股
      //   · 科创板 688 开头 → 返回的**本来就是「股」**，再 ×100 会让成交量虚增 100 倍
      // 对拍实证：sh688496 原始 volume=11410204 与存量库逐位相同（= 股）；
      //          sh600519 原始 38331（手=383.31 万股，与 48 亿成交额吻合）。
      // 判定按 code 前缀：接口规则复杂且会变，宁可显式写死并留注释，也不要靠启发式猜。
      const volToShares = cd.startsWith('sh688') ? 1 : 100;

      // [date, open, close, high, low, volume, ...]
      const bars = rows.map((r, i) => ({
        date: str(r[0]),
        open: num(str(r[1])),
        high: num(str(r[3])),
        low: num(str(r[4])),
        close: num(str(r[2])),
        volume: num(str(r[5])) * volToShares, // → 股
        // ⚠️ 腾讯 K 线只有 6 个字段（date/open/close/high/low/volume），**不返回成交额**。
        // 这里固定给 0 表示「源未提供」：写入层见 0 应保留库存量值，禁止拿 volume×close 估算造假。
        amount: 0,
        // 腾讯不返回前收：用上一根 close 近似；首根留 0 由上层自算
        preClose: i > 0 ? num(str(rows[i - 1]?.[2])) : 0,
      }));
      return ok(this.id, Date.now() - t0, bars);
    }

    // 所有 host 均传输层失败
    return fail<import('./types').ProviderBar[]>(
      this.id,
      Date.now() - t0,
      'network',
      `腾讯 qfq 日 K 全部 host 传输失败：${lastTransportError ?? '未知'}`,
    );
  }

  dispose(): void {
    // 无长连接，HTTP 请求随 socket 自然回收
  }
}

/** 独立小函数：避免 fetchOneBatch 里 import 名与包名撞车 */
function getBuf(url: string): Promise<Buffer> {
  return getBuffer(url, { headers: { Referer: 'https://gu.qq.com/' } });
}

/** JSON 里的字段可能是各种类型，统一先落成 string 再喂给 num() */
function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}
