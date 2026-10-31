// window.quantApi 全局类型声明（与 preload.ts 的 contextBridge 暴露严格对应）
import type {
  IpcRequestMap,
  IpcResponseMap,
  IpcChannel,
  PullProgress,
  AppInfo,
} from '@shared/types/ipc';

declare global {
  interface Window {
    quantApi: QuantApi;
  }
}

export interface QuantApi {
  invoke<C extends IpcChannel>(channel: C, req?: IpcRequestMap[C]): Promise<IpcResponseMap[C]>;
  /** 订阅数据抓取进度，返回取消订阅函数 */
  onPullProgress(cb: (p: PullProgress) => void): () => void;
  /** 应用版本 / 版权信息（关于页） */
  getAppInfo(): Promise<AppInfo>;
  /** 关于窗上报内容实测高度，主进程据此把窗口调到刚好放下（仅关于窗生效） */
  fitWindowHeight(height: number): Promise<void>;
  /** 订阅主进程路由跳转（托盘菜单 / 应用菜单），返回取消订阅函数 */
  onNavigate(cb: (p: { path: string }) => void): () => void;
}

export {};
