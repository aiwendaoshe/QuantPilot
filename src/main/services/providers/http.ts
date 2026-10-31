/**
 * Provider 层的最小 HTTP 客户端：只用 node:http / node:https，不引任何三方依赖。
 *
 * 为什么不用 fetch：本工程 tsconfig `lib: ["ES2022"]`（不含 DOM），且 @types/node@20
 * 的 globals 未导出 fetch 签名，写了会编译不过；另外行情源大多带 GBK 中文名，
 * 必须拿到原始 Buffer 自己解码，fetch 的 arrayBuffer() 也要多绕一层。
 */
import http from 'node:http';
import https from 'node:https';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuantPilot/0.9.4';

export interface HttpGetOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** GET 返回原始 Buffer（GBK 源用 new TextDecoder('gbk') 解码，UTF-8 源直接 toString('utf8')） */
export function getBuffer(url: string, opts: HttpGetOptions = {}): Promise<Buffer> {
  const u = new URL(url);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const mod = (u.protocol === 'http:' ? http : https) as typeof https;

  return new Promise<Buffer>((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': UA, ...opts.headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            reject(new HttpError(status, `HTTP ${status} ${u.hostname}`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`HTTP 超时 ${timeoutMs}ms: ${u.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

/** GET 并返回 UTF-8 字符串 */
export async function getText(url: string, opts: HttpGetOptions = {}): Promise<string> {
  const buf = await getBuffer(url, opts);
  return buf.toString('utf8');
}

/**
 * 并发跑 n 个任务，返回「全部结果」而非「第一个异常」——
 * 全市场扫描时一次失败不该中断整批。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
