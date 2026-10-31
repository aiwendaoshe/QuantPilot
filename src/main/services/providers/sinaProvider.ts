/**
 * 新浪行情 Provider（兜底源 / 名单源）。
 *
 * 端点（来源：新浪财经公开 Web 接口）：
 *  - 全市场名单：vip.stock.finance.sina.com.cn …/Market_Center.getHQNodeData?node=hs_a
 *    （实测 hs_a 共 **5571 只**，且一并返回 settlement=昨收，是唯一一次拿全名单的口子）
 *  - 实时快照：hq.sinajs.cn/list=<code>（必须带 Referer，否则返回空）
 *
 * 口径：
 *  - 名单/快照都没有复权概念 → dataAdjust='none'，**不进 qfq 日 K 降级链**（防污染）；
 *  - 日 K 源（CN_MarketData.getKLineData）无复权参数，且实测与新除权个股口径对不齐，
 *    故 capabilities.dailyBars=false，宁可不支持也不写脏数据。
 */
import { getBuffer, getText, mapLimit } from './http';
import {
  fail,
  marketOf,
  num,
  ok,
  toDbCode,
  unsupported,
  type DailyBarsOptions,
  type MarketDataProvider,
  type ProviderId,
  type ProviderResult,
  type QuoteItem,
  type SectorItem,
  type UniverseItem,
} from './types';

/**
 * 存量大盘口径 = 沪深主板/创业/科创（sh.6* / sz.0* / sz.3*），**不含北交所**。
 * ⚠️ 实测新浪 `node=hs_a` 会混进北交所 920xxx（hs_a 实际是「沪深京 A 股」），
 * 不过滤就会往库里塞 900 只北交所票，选股池上限和 backtest 池口径全乱。
 */
const A_SHARE_PREFIXES = ['sh.6', 'sz.0', 'sz.3'];

function isAStock(code: string): boolean {
  return A_SHARE_PREFIXES.some((p) => code.startsWith(p));
}

const NODE_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const QUOTE_URL = 'https://hq.sinajs.cn/list=';
/** 行业板块列表（M2）：返回 GBK 的 JS 变量赋值串，需自行提取 JSON */
const SECTOR_URL = 'https://money.finance.sina.com.cn/q/view/newSinaHy.php';
const GBK = new TextDecoder('gbk');

export interface SinaProviderOptions {
  /** 名单分页大小（新浪上限约 100） */
  universePageSize?: number;
  snapshotBatch?: number;
  snapshotConcurrency?: number;
}

interface NodeRow {
  symbol?: string;
  name?: string;
  trade?: string;
  settlement?: string;
  changepercent?: string;
  volume?: string;
  amount?: string;
}

export class SinaProvider implements MarketDataProvider {
  readonly id: ProviderId = 'sina';
  readonly label = '新浪财经';
  readonly dataAdjust = 'none' as const;
  /** 新浪日 K（若有）只有不复权口径，所以它**进不了 qfq 日 K 链** —— 这正是防污染闸门要的效果 */
  readonly supportedAdjust = ['none'] as const;
  readonly capabilities = { universe: true, snapshot: true, dailyBars: false, sectors: true };

  private readonly pageSize: number;
  private readonly snapBatch: number;
  private readonly snapConcurrency: number;

  constructor(opts: SinaProviderOptions = {}) {
    this.pageSize = Math.min(100, Math.max(20, opts.universePageSize ?? 100));
    this.snapBatch = Math.max(1, opts.snapshotBatch ?? 100);
    this.snapConcurrency = Math.max(1, opts.snapshotConcurrency ?? 6);
  }

  async getUniverse(limit?: number): Promise<ProviderResult<UniverseItem[]>> {
    const t0 = Date.now();
    const want = limit !== undefined && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    const collected: UniverseItem[] = [];
    let page = 1;
    // 分页数上限兜底：理论上 hs_a 约 57 页，留 3 倍余量防分页死循环
    for (let guard = 0; guard < 300 && collected.length < want; guard += 1) {
      const rows = await this.fetchPage(page).catch(() => null);
      if (rows === null || rows.length === 0) break;
      for (const r of rows) {
        const sym = r.symbol ?? '';
        if (sym === '') continue;
        const code = toDbCode(sym);
        if (!isAStock(code)) continue; // 剔掉北交所等不在口径内的票
        collected.push({
          code,
          name: (r.name ?? '').trim(),
          market: marketOf(sym),
        });
        if (collected.length >= want) break;
      }
      // 短页 = 最后一页
      if (rows.length < this.pageSize) break;
      page += 1;
    }
    if (collected.length === 0) {
      return fail<UniverseItem[]>(this.id, Date.now() - t0, 'network', '新浪名单接口返回空');
    }
    return ok(this.id, Date.now() - t0, collected.slice(0, Number.isFinite(want) ? want : undefined));
  }

  private async fetchPage(page: number, node = 'hs_a'): Promise<NodeRow[]> {
    const url =
      `${NODE_URL}?page=${page}&num=${this.pageSize}&sort=symbol&asc=1&node=${node}&symbol=&_s_r_a=page`;
    const text = await getText(url, { timeoutMs: 10_000 });
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === 'null') return [];
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as NodeRow[]) : [];
  }

  /**
   * 行业板块列表（M2）：newSinaHy 返回 GBK 的 `var S_Finance_bankuai_sinaindustry = {json}`，
   * 需截出 JSON 再 parse。每行 13 字段（实测）：
   *   id,名称,家数,均价,涨跌额,涨跌幅%,总成交量(股),总成交额(元),领涨股code,领涨股涨幅%,现价,涨跌额,领涨股名
   */
  async getSectors(): Promise<ProviderResult<SectorItem[]>> {
    const t0 = Date.now();
    try {
      const buf = await getBuffer(SECTOR_URL, { timeoutMs: 10_000 });
      const text = GBK.decode(buf);
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) {
        return fail<SectorItem[]>(this.id, Date.now() - t0, 'protocol', '板块列表格式异常（未找到 JSON）');
      }
      const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, string>;
      const out: SectorItem[] = [];
      for (const row of Object.values(raw)) {
        const p = row.split(',');
        if (p.length < 13) continue;
        out.push({
          id: p[0] ?? '',
          name: p[1] ?? '',
          stockCount: num(p[2]),
          changePct: +num(p[5]).toFixed(2),
          amount: num(p[7]),
          leaderCode: p[8] ? toDbCode(p[8]) : '',
          leaderName: p[12] ?? '',
          leaderChangePct: +num(p[9]).toFixed(2),
        });
      }
      if (out.length === 0) {
        return fail<SectorItem[]>(this.id, Date.now() - t0, 'protocol', '板块列表解析为空');
      }
      return ok(this.id, Date.now() - t0, out);
    } catch (e) {
      return fail<SectorItem[]>(this.id, Date.now() - t0, 'network', String(e));
    }
  }

  /** 某板块成分股（M2）：复用 list 节点分页（node=<板块id>），返回 db code + 名称 */
  async getSectorMembers(sectorId: string): Promise<ProviderResult<UniverseItem[]>> {
    const t0 = Date.now();
    const collected: UniverseItem[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await this
        .fetchPage(page, sectorId)
        .catch(() => null);
      if (rows === null || rows.length === 0) break;
      for (const r of rows) {
        const sym = r.symbol ?? '';
        if (sym === '') continue;
        const code = toDbCode(sym);
        if (!isAStock(code)) continue;
        collected.push({ code, name: (r.name ?? '').trim(), market: marketOf(sym) });
      }
      if (rows.length < this.pageSize) break; // 短页 = 最后一页
    }
    if (collected.length === 0) {
      return fail<UniverseItem[]>(this.id, Date.now() - t0, 'network', `板块 ${sectorId} 成分为空`);
    }
    return ok(this.id, Date.now() - t0, collected);
  }

  async getSnapshot(codes: readonly string[]): Promise<ProviderResult<QuoteItem[]>> {
    const t0 = Date.now();
    const batches: string[][] = [];
    for (let i = 0; i < codes.length; i += this.snapBatch) {
      batches.push(codes.slice(i, i + this.snapBatch));
    }
    const groups = await mapLimit(batches, this.snapConcurrency, (b) =>
      this.fetchOneBatch(b).catch(() => [] as QuoteItem[]),
    );
    const value = groups.flat();
    if (value.length === 0) {
      return fail<QuoteItem[]>(this.id, Date.now() - t0, 'network', '新浪快照全部失败');
    }
    return ok(this.id, Date.now() - t0, value);
  }

  private async fetchOneBatch(batch: readonly string[]): Promise<QuoteItem[]> {
    const buf = await getBuffer(QUOTE_URL + batch.join(','), {
      headers: { Referer: 'https://finance.sina.com.cn' },
    });
    const text = GBK.decode(buf);
    const out: QuoteItem[] = [];
    // var hq_str_sh600519="贵州茅台,9.90,9.95,9.96,9.99,9.88,...,成交量,成交额,...";
    const re = /hq_str_([a-z]{2}\d{6})="([^"]*)"/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const a = (m[2] ?? '').split(',');
      if (a.length < 10) continue;
      const code = toDbCode(m[1] ?? '');
      const close = num(a[3]);
      const preClose = num(a[2]);
      out.push({
        code,
        name: a[0] ?? '',
        market: marketOf(code),
        close,
        preClose,
        open: num(a[1]),
        high: num(a[4]),
        low: num(a[5]),
        change: Number((close - preClose).toFixed(4)),
        changePct: preClose > 0 ? Number((((close - preClose) / preClose) * 100).toFixed(4)) : 0,
        volume: num(a[8]), // 新浪直接给「股」
        amount: num(a[9]), // 直接给「元」
      });
    }
    return out;
  }

  async getDailyBars(_code: string, _opts?: DailyBarsOptions) {
    return fail<never>(this.id, 0, 'unsupported', unsupported(this.id, '前复权日 K').message);
  }

  dispose(): void {
    // 无长连接
  }
}
