/**
 * 熔断器：单个数据源连续失败就先「拉黑」一段时间，别让 5000 只票在一个挂掉的源上排队。
 *
 * 阈值取 3 次 / 30s 窗口：一次全市场扫描里同一个源失败 3 次基本可以判定不可用（多半是
 * 出口 IP 被限流），后续几千次请求白等网络超时纯属浪费。cooldown 后进入 half-open，
 * 成功一次即闭合（真实行情服务恢复通常是一次成功就够）。
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** 窗口内失败多少次后熔断 */
  threshold?: number;
  /** 统计窗口（ms） */
  windowMs?: number;
  /** 熔断后过多久试一次（ms） */
  cooldownMs?: number;
}

export class Breaker {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly stamps: number[] = [];
  private trippedAt: number | null = null;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.windowMs = opts.windowMs ?? 30_000;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  /** 当前是否允许发请求 */
  allow(now: number = Date.now()): boolean {
    if (this.trippedAt === null) return true;
    if (now - this.trippedAt < this.cooldownMs) return false;
    // 冷却结束：放一个探测请求出去
    this.trippedAt = null;
    return true;
  }

  recordSuccess(): void {
    this.stamps.length = 0;
    this.trippedAt = null;
  }

  recordFailure(now: number = Date.now()): void {
    this.stamps.push(now);
    while (this.stamps.length > 0 && now - (this.stamps[0] as number) > this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.threshold) this.trippedAt = now;
  }

  get state(): BreakerState {
    if (this.trippedAt === null) return 'closed';
    return Date.now() - this.trippedAt < this.cooldownMs ? 'open' : 'half-open';
  }
}
