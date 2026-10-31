import type { IpcChannel, IpcEvent } from '../types/ipc';

/** 统一 IPC 通道常量，禁止在业务中硬编码字符串 */
export const IPC = {
  PULL_HISTORY: 'data:pullHistory',
  DATA_STATUS: 'data:status',
  DETECT_PYTHON: 'data:detectPython',
  DATA_HEALTH: 'data:dataHealth',
  MARKET_LIST: 'market:list',
  LIMITUP_POOL: 'limitup:pool',
  /** M3 市场情绪看板 */
  SENTIMENT_GET: 'sentiment:get',
  /** M2 板块/行业 */
  SECTOR_REFRESH: 'sector:refresh',
  SECTOR_LIST: 'sector:list',
  SECTOR_DETAIL: 'sector:detail',
  STRATEGY_LIST: 'strategy:list',
  STRATEGY_CONFIG_GET: 'strategy:configGet',
  STRATEGY_CONFIG_SAVE: 'strategy:configSave',
  SCREENER_RUN: 'screener:run',
  BACKTEST_RUN: 'backtest:run',
  /** M5 回测报告导出 Excel */
  BACKTEST_EXPORT_EXCEL: 'backtest:exportExcel',
  /** M5 多策略横向对比 */
  BACKTEST_COMPARE: 'backtest:compare',
  /** M5 参数敏感度扫描 */
  BACKTEST_SENSITIVITY: 'backtest:sensitivity',
  STOCK_DETAIL: 'stock:detail',
  SCHEDULER_GET: 'scheduler:get',
  SCHEDULER_SET: 'scheduler:set',
  SOURCE_CONFIG: 'data:sourceConfig',
  SET_SOURCE_PREFERENCE: 'data:setSourcePreference',
  SET_PULL_ENGINE: 'data:setPullEngine',
  APP_INFO: 'app:info',
  /** 关于窗：渲染层实测内容高度 → 主进程按需调整窗口尺寸（去滚动条的正解） */
  FIT_WINDOW: 'window:fitContent',
  /** M4 自选股 */
  WATCH_LIST: 'watch:list',
  WATCH_UPSERT: 'watch:upsert',
  WATCH_REMOVE: 'watch:remove',
  WATCH_HAS: 'watch:has',
} as const satisfies Record<string, IpcChannel>;

/** 主进程 → 渲染进程的单向事件通道 */
export const IPC_EVENT = {
  PULL_PROGRESS: 'data:pullProgress',
  APP_NAVIGATE: 'app:navigate', // 主进程（托盘/菜单）→ 渲染进程路由跳转
} as const satisfies Record<string, IpcEvent>;
