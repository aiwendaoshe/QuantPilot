import { app } from 'electron';
import type { AppInfo } from '@shared/types/ipc';

/** 应用元信息统一出口：关于页、托盘提示、日志抬头都从这里拿，杜绝各处硬拼字符串 */
export function getAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    // 版权主体硬口径：AI问道社（electron-builder.yml 的 copyright 同步改这里）
    copyright: 'AI问道社',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  };
}
