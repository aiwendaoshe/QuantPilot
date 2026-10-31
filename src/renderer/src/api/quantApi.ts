import type { QuantApi } from '../quant-api';
import type { IpcChannel, IpcRequestMap } from '@shared/types/ipc';
import { plainify } from '../utils/plain';

/**
 * 渲染进程统一调用入口（经 preload 的类型安全 IPC）。
 *
 * 出口统一 plainify 入参：Vue 响应式代理（reactive / Pinia state）不能直接过 IPC，
 * structuredClone 会抛 DataCloneError「An object could not be cloned.」。
 * 集中一处处理，避免每个调用点都漏。
 */
export function quantApi(): QuantApi {
  return {
    ...window.quantApi,
    invoke<C extends IpcChannel>(channel: C, req?: IpcRequestMap[C]) {
      return window.quantApi.invoke(channel, plainify(req));
    },
  };
}
