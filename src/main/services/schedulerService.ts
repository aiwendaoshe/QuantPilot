import Store from 'electron-store';
import { Notification } from 'electron';
import log from 'electron-log';
import { strategyService } from './strategyService';
import { DEFAULT_SCHEDULER, type SchedulerConfig } from '../../../src/shared/types/scheduler';
import type { Signal } from '@shared/types/signal';

interface StoreSchema {
  scheduler: SchedulerConfig;
}

const store = new Store<StoreSchema>({ defaults: { scheduler: DEFAULT_SCHEDULER } });

let timer: ReturnType<typeof setInterval> | null = null;

export const schedulerService = {
  getConfig(): SchedulerConfig {
    return store.get('scheduler');
  },

  setConfig(config: SchedulerConfig): { ok: boolean } {
    store.set('scheduler', config);
    log.info('[scheduler] 配置已保存', config);
    this.restart();
    return { ok: true };
  },

  /** 应用启动后调用：按配置启动/停止定时轮询 */
  start(): void {
    this.restart();
  },

  restart(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      log.info('[scheduler] 定时选股已禁用');
      return;
    }
    // 每分钟检查一次是否到达触发时刻
    timer = setInterval(() => void this.tick(), 60_000);
    log.info(`[scheduler] 定时选股已启动：每日 ${cfg.hour}:${String(cfg.minute).padStart(2, '0')}`);
  },

  async tick(): Promise<void> {
    const cfg = this.getConfig();
    const now = new Date();
    if (now.getHours() === cfg.hour && now.getMinutes() === cfg.minute) {
      await this.runAndNotify();
    }
  },

  /** 运行选股并把结果推送到飞书/桌面通知 */
  async runAndNotify(): Promise<string | null> {
    const cfg = this.getConfig();
    // 走主进程统一出口：指纹命中就复用缓存（定时任务与「仪表盘 / 重新选股」拿到的是同一份结果）
    const res = await strategyService.runScreener({}, cfg.topN);
    const signals = res.signals;
    if (res.cached) log.info('[scheduler] 复用选股缓存，未重算');
    const summary = this.formatSummary(signals.slice(0, 10));
    log.info(`[scheduler] 选股完成，命中 ${signals.length} 只`);

    if (cfg.notifyDesktop && typeof Notification !== 'undefined') {
      const top1 = signals[0];
      new Notification({
        title: 'QuantPilot 每日选股完成',
        body: `命中 ${signals.length} 只 · TOP1: ${top1 ? `${top1.name}(${top1.score})` : '无'}`,
      }).show();
    }

    if (cfg.feishuWebhook) {
      try {
        const resp = await fetch(cfg.feishuWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msg_type: 'text',
            content: { text: `【QuantPilot 每日选股 · ${new Date().toLocaleDateString()}】\n${summary}` },
          }),
        });
        if (!resp.ok) log.warn('[scheduler] 飞书推送返回', resp.status);
      } catch (e) {
        log.error('[scheduler] 飞书推送失败', e);
      }
    }
    return signals.length ? summary : null;
  },

  formatSummary(signals: Signal[]): string {
    if (signals.length === 0) return '今日无信号';
    return signals
      .map((s, i) => `${i + 1}. ${s.name}(${s.code}) 评分${s.score} ${s.type}`)
      .join('\n');
  },
};
