import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRequestMap, IpcResponseMap, IpcChannel } from '@shared/types/ipc';
import type { PullProgress, AppInfo } from '@shared/types/ipc';
import { IPC, IPC_EVENT } from '@shared/constants/channels';

// 暴露给渲染进程的类型安全 API（仅 invoke + 白名单事件订阅，
// 禁止直接暴露 Node/electron 对象，禁止让渲染进程自定义通道名）
const api = {
  invoke<C extends IpcChannel>(channel: C, req?: IpcRequestMap[C]): Promise<IpcResponseMap[C]> {
    return ipcRenderer.invoke(channel, req);
  },
  /** 订阅数据抓取进度，返回取消订阅函数 */
  onPullProgress(cb: (p: PullProgress) => void): () => void {
    const handler = (_e: unknown, p: PullProgress): void => cb(p);
    ipcRenderer.on(IPC_EVENT.PULL_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT.PULL_PROGRESS, handler);
  },
  /** 应用版本 / 版权信息（关于页） */
  getAppInfo(): Promise<AppInfo> {
    return ipcRenderer.invoke(IPC.APP_INFO);
  },
  /**
   * 上报「内容实测高度」，主进程据此把窗口调到刚好放下（去滚动条）。
   * 仅关于窗生效：主进程会校验 sender，主窗口调用一律忽略。
   */
  fitWindowHeight(height: number): Promise<void> {
    return ipcRenderer.invoke(IPC.FIT_WINDOW, { height });
  },
  /** 订阅主进程路由跳转（托盘菜单 / 应用菜单），返回取消订阅函数 */
  onNavigate(cb: (p: { path: string }) => void): () => void {
    const handler = (_e: unknown, p: { path: string }): void => cb(p);
    ipcRenderer.on(IPC_EVENT.APP_NAVIGATE, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT.APP_NAVIGATE, handler);
  },
};

contextBridge.exposeInMainWorld('quantApi', api);
