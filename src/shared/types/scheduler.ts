/** 定时任务配置（每日收盘后自动选股 → 桌面通知 / 飞书推送） */
export interface SchedulerConfig {
  enabled: boolean; // 是否启用定时选股
  hour: number; // 触发小时（24h，默认 15）
  minute: number; // 触发分钟（默认 30，收盘后）
  feishuWebhook: string; // 飞书自定义机器人 webhook（空则不推送）
  notifyDesktop: boolean; // 是否弹桌面通知
  topN: number; // 选股 TOP N
}

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  enabled: false,
  hour: 15,
  minute: 30,
  feishuWebhook: '',
  notifyDesktop: true,
  topN: 20,
};
