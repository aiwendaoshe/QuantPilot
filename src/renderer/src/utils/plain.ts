/**
 * 把值转成「可结构化克隆」的纯数据。
 *
 * 背景（真机踩过的坑，勿删注释）：
 * `ipcRenderer.invoke` 底层走 structuredClone，而 Vue 的 `reactive()` / Pinia state
 * 返回的是 Proxy 代理对象 —— structuredClone 对代理对象直接抛
 * DataCloneError，界面上就是一句「保存失败：An object could not be cloned.」。
 * 历史上这条异常被静默吞掉，用户体感是「点了保存没反应」。
 *
 * 因此：**凡是送进 IPC 的入参，一律先 plainify 一次**。
 */
export function plainify<T>(value: T): T {
  if (value === undefined) return value;
  // 本项目 IPC 入参全为 number / boolean / string / 其数组或对象，JSON 往返安全
  return JSON.parse(JSON.stringify(value)) as T;
}
