import type { Signal } from './signal';
import type { StrategyConfig, StrategyMeta } from './strategy';
import type { BacktestResult, BacktestOptions, StrategyCompareResult, SensitivityResult } from './backtest';
import type { StrategyId } from './signal';
import type { StockDetail } from './stock';
import type { SchedulerConfig } from './scheduler';

/** 策略组合预设概览（只读，持久化由 strategy:applyPreset 触发） */
export interface StrategyPresetInfo {
  id: string;
  name: string;
  description: string;
  enabled: StrategyId[];
}

/** 拉取范围（标的数）：0 = 全市场 */
export type PullUniverse = number;

/**
 * 选股范围（M4）：'all' = 全市场（默认）/ 'watchlist' = 只扫自选池。
 * 这两个范围的选股结果**互不相同**，所以必须进指纹缓存 key（见 strategyService.screenKeyOf），
 * 否则先扫全市场再扫自选会命中彼此的缓存、显示错结果。
 */
export type ScreenScope = 'all' | 'watchlist';

/** 自选股分组（M4）：内置三组 + 用户可自定义（存字符串，不做枚举硬限制） */
export type WatchGroup = string;

/** 自选股一行（M4，含最新行情快照与浮动盈亏） */
export interface WatchlistRow {
  code: string;
  name: string;
  industry: string;
  group: WatchGroup;
  note: string;
  /** 加入时间（ISO） */
  addedAt: string;
  /** 用户录入的成本价（元）；null = 未录入 */
  costPrice: number | null;
  /** 最新交易日（库内 ≤今日 的最大交易日） */
  date: string | null;
  close: number | null;
  preClose: number | null;
  changePct: number | null;
  /** 浮动盈亏（元）= (close - costPrice)×100？—— 单股金额需手数，UI 用比例；此处仅比例 */
  pnlPct: number | null;
  /** 该股最近一次选股是否命中信号（联查 signals，null=未跑过/无信号） */
  hit: boolean | null;
}

/** 新增/更新自选股入参 */
export interface WatchUpsert {
  code: string;
  group?: WatchGroup;
  note?: string;
  costPrice?: number | null;
}

/**
 * 选股结果（v0.9.7）：带「结果版本」的返回体。
 *
 * 选股本质是 f(数据 × 策略) 的纯函数 —— 输入没变，结果就不该重算。
 * 主进程按「数据日期 + K线根数 + 池上限 + 启用策略参数」算指纹，命中即复用缓存；
 * 这里如实回传 cached / computedAt / dataDate，让 UI 能回答「这排结果是几号算的」，
 * 绝不让旧结果冒充新结果。
 */
export interface ScreenResult {
  signals: Signal[];
  /** true = 命中缓存直接返回，本次没有真的跑计算 */
  cached: boolean;
  /** 结果产生时间（ISO）；缓存命中时是缓存的产生时刻，不是「刚刚」 */
  computedAt: string | null;
  /** 结果依赖的数据日期（库内最后一根 K 线日期）；null = 未知 */
  dataDate: string | null;
  /** 本次指纹；排查「为什么命中 / 为什么没命中」时看它 */
  key: string;
}

/** 应用信息（关于页 / 关于窗口用） */
export interface AppInfo {
  name: string;
  version: string;
  /** 版权主体，硬口径＝AI问道社 */
  copyright: string;
  electron: string;
  /** Chromium 版本（关于窗按参考图列出「Electron / Chrome / Node.js」三行） */
  chrome: string;
  node: string;
}

/** 涨停池单行（连板统计，v0.9.0） */
export interface LimitUpRow {
  code: string;
  name: string;
  industry: string;
  /** 收盘价 */
  close: number;
  /** 涨跌幅（小数，如 0.0998 表示 +9.98%） */
  changePct: number;
  /** 连板数（≥1） */
  streak: number;
  /** N天M板 的 N（窗口交易日数；与 streak 相等时 UI 只展示「n连板」） */
  windowDays: number;
  /** N天M板 的 M（窗口内涨停总数） */
  windowBoards: number;
  /** 本轮首个涨停日 */
  firstDate: string;
  /** 一字板（开盘=最高=最低） */
  isOneWord: boolean;
  /** 成交额（元） */
  amount: number;
  /** 按当前名称判定为 ST（历史时点可能已摘帽/戴帽，存在误判，UI 免责标注） */
  stSuspect: boolean;
}

/** 涨停池扫描结果 */
export interface LimitUpPoolResult {
  /** 实际判定交易日（= 请求 date 或库内 ≤date 的最大交易日） */
  date: string;
  /** 已按 streak desc → amount desc → code asc 排序 */
  rows: LimitUpRow[];
  /** 连板高度分布 */
  distribution: { first: number; two: number; threePlus: number; maxStreak: number };
  /** 命中 ST 判定的条数 */
  stSuspectCount: number;
}

/**
 * 单日情绪快照（M3）：一天的全市场情绪横截面。
 * 涨跌家数/涨停/跌停/连板分布都用**交易所严格口径**（isLimitUp/DownStrict），
 * 而不是「涨跌幅≥9.5%」这种粗判——ST 5%、创业板/科创 20% 会被误判。
 */
export interface SentimentSnapshot {
  /** 实际判定的交易日（库内 ≤date 的最大交易日） */
  date: string;
  /** 有行情的标的总数（本池） */
  total: number;
  up: number;
  down: number;
  flat: number;
  /** 涨停家数 */
  limitUp: number;
  /** 跌停家数 */
  limitDown: number;
  /** 连板高度分布：key=连板数，value=家数（1=首板） */
  streakDist: Record<string, number>;
  /** 最高连板高度（空间板） */
  maxStreak: number;
  /** 全市场当日总成交量（股）与总成交额（元）；amount 多为 0 时为 null（源不提供，诚实） */
  totalVolume: number;
  totalAmount: number | null;
  /** 情绪温度 0~100（详见 sentiment.ts 打分口径） */
  score: number;
  /** 温度档位：冰点/偏冷/中性/偏热/过热 */
  level: SentimentLevel;
  /** 昨日涨停股今日表现（打板赚钱效应）：平均涨跌幅 %；null=昨日无涨停 */
  yesterdayLimitUpPerf: number | null;
}

/** 情绪温度档位 */
export type SentimentLevel = '冰点' | '偏冷' | '中性' | '偏热' | '过热';

/** 情绪看板整页返回（M3） */
export interface SentimentResult {
  /** 当日横截面 */
  current: SentimentSnapshot;
  /** 近 N 日历史（按日期升序，用于画曲线） */
  history: SentimentSnapshot[];
}

/** 板块一行（M2，落库自新浪行业板块） */
export interface SectorRow {
  id: string;
  name: string;
  stockCount: number;
  /** 板块涨跌幅 % */
  changePct: number;
  /** 板块总成交额（元） */
  amount: number;
  leaderCode: string;
  leaderName: string;
  leaderChangePct: number;
  /** 库内已有行情的成分股数（≤ stockCount；差额=库外的票） */
  memberCount: number;
  updatedAt: string;
}

/** 板块成分股一行（带库内最新行情；库外成分只给代码/名称） */
export interface SectorMemberRow {
  code: string;
  name: string;
  /** 是否在本地行情库（false = 仅板块源有、库内无 K 线） */
  inLibrary: boolean;
  close: number | null;
  changePct: number | null;
  /** 该股最近一次选股是否命中信号 */
  hit: boolean | null;
}

/** 板块详情 = 板块行 + 成分股 */
export interface SectorDetail extends SectorRow {
  members: SectorMemberRow[];
}

/** 回填模式：full=全量重建 / incremental=增量 / fill-missing=补拉缺失标的（v0.9.2） */
export type PullMode = 'full' | 'incremental' | 'fill-missing';

/** IPC 请求载荷映射：channel -> 入参 */
export interface IpcRequestMap {
  'data:pullHistory': {
    force?: boolean;
    universe?: PullUniverse;
    lookbackYears?: number;
    /** v0.9.2：显式模式；缺省按 force 语义（true=full / false=incremental） */
    mode?: PullMode;
  };
  'data:status': void;
  'data:detectPython': void;
  /** 数据健康：本地覆盖度（v0.9.2） */
  'data:dataHealth': void;
  'market:list': void;
  /** 涨停池：date 缺省 = 库内最新交易日 */
  'limitup:pool': { date?: string };
  /** M3 市场情绪：date 缺省 = 库内最新交易日；historyDays = 回看天数（默认 30） */
  'sentiment:get': { date?: string; historyDays?: number };
  'strategy:list': void;
  'strategy:configGet': void;
  'strategy:configSave': { configs: StrategyConfig[] };
  /**
   * 应用组合预设：presetId 决定启用开关列表；
   * 可选 configs = 前端当前草稿（用于保留用户已调、尚未保存的参数）。
   * 铁律：预设「只管开关、不动参数」。
   */
  'strategy:applyPreset': { presetId: string; configs?: StrategyConfig[] };
  'strategy:listPresets': void;
  // force=true 强制重算（「重新选股」按钮）；缺省 = 让主进程按指纹决定要不要真跑
  // scope='watchlist' 时只扫自选池（M4）；缺省/'all' = 全市场
  'screener:run': { date?: string; force?: boolean; scope?: ScreenScope };
  'backtest:run': {
    strategyId: StrategyId;
    startDate: string;
    endDate: string;
    options: BacktestOptions;
  };
  /** M5 导出最近一次回测为 Excel；主进程弹保存对话框，写盘后返回路径（取消=null） */
  'backtest:exportExcel': void;
  /** M5 多策略横向对比：同区间同参数下各跑一次回测 */
  'backtest:compare': {
    strategyIds: string[];
    startDate: string;
    endDate: string;
    options: BacktestOptions;
  };
  /** M5 参数敏感度扫描：某数值参数网格取值各跑一次回测（不写回用户配置） */
  'backtest:sensitivity': {
    strategyId: string;
    paramKey: string;
    startDate: string;
    endDate: string;
    options: BacktestOptions;
    values: number[];
  };
  'stock:detail': { code: string };
  'scheduler:get': void;
  'scheduler:set': { config: SchedulerConfig };
  'app:info': void;
  /**
   * 关于窗：渲染层把「内容实测高度」上报给主进程，主进程据此 setContentSize。
   *
   * 为什么不写死窗口高度：字体/DPI/缩放下内容高度会漂移，任何硬编码值早晚会
   * 溢出（→ 出现滚动条）或留大片空白。窗口不接收非关于窗的请求（主进程按 sender 校验）。
   */
  'window:fitContent': { height: number };
  /** P4：设置页「数据源」区块的全部输入 */
  'data:sourceConfig': void;
  'data:setSourcePreference': { cap: Capability; provider: ProviderId };
  'data:setPullEngine': { engine: PullEngine };
  /** M4 自选股：列表（带最新行情 + 信号命中联查） */
  'watch:list': void;
  /** M4 自选股：新增或更新（按 code upsert） */
  'watch:upsert': WatchUpsert;
  /** M4 自选股：移出 */
  'watch:remove': { code: string };
  /** M4 自选股：是否已自选（StockDetail 按钮态） */
  'watch:has': { code: string };
  /** M2 板块：拉取并落库板块列表+成分（首次/刷新用） */
  'sector:refresh': { withMembers?: boolean };
  /** M2 板块：板块列表（按涨幅/成交额排序） */
  'sector:list': { sort?: 'changePct' | 'amount' };
  /** M2 板块：板块详情（含成分股+库内行情） */
  'sector:detail': { id: string };
}

/**
 * 数据来源标识。
 *
 * ⚠️ 判「是不是演示数据」**一律用 `=== 'mock'`**，绝不要写 `=== 'baostock'` ——
 * 那是 R1 已经踩过的坑：换源后旧判据恒为 false，守卫形同虚设（见 services/mockGuard.ts）。
 * 除 'mock' 之外的都是真实行情，只是取的源不同。
 */
export type DataSourceId = 'baostock' | 'tencent' | 'sina' | 'tdx' | 'mock';

/**
 * 能力层（P4）：界面上「数据源」分三层各自选源。
 * 日 K 层只有一个选项且**锁死**腾讯 qfq —— 库里 369 万根就是这个口径，换源会改写 37% 的行。
 */
export type Capability = 'universe' | 'snapshot' | 'dailyBars';

/** 行情源标识（与 providers/types.ts 的 ProviderId 同名同源，渲染层直接复用） */
export type ProviderId = 'tencent' | 'sina' | 'tdx';

/** 拉取引擎：node（默认，零依赖）/ python（旧 baostock 实验路径） */
export type PullEngine = 'node' | 'python';

/** 设置页用的源健康状态灯 */
export interface ProviderStatusInfo {
  id: ProviderId;
  label: string;
  /** 需要额外安装依赖（TDX 为 true） */
  optional: boolean;
  requiredPackage: string | null;
  breaker: 'closed' | 'open' | 'half-open';
  preferredIn: Capability | null;
}

export interface LayerStatusInfo {
  cap: Capability;
  options: ProviderId[];
  available: ProviderId[];
  preferred: ProviderId | null;
}

/**
 * 已知口径偏差条目：库里「口径不自洽但已定位、已处理 / 有意保留」的行。
 *
 * 为什么显式记成名单而不是靠扫描现算（P4/P5 教训）：
 *   P4 用 `abs(preClose - lag(close)) / lag(close) > 5%` 扫出来 3 行、修完复验归零，
 *   结果**下一次再扫就扫不出任何东西了**——偏差已经消失，可「这段代码为什么存在、
 *   未来怎么防范」这件事必须留痕，否则下一个人换源重灌时会重蹈覆辙。
 *   所以名单是**事实记录**，不是实时检测结果；UI 只做如实提示，不做自动判定。
 */
export interface AdjustBiasEntry {
  code: string;
  /** 受影响的日期（可能有多个除权日） */
  dates: string[];
  /** 偏差类型 */
  kind: 'preClose-unadjusted' | 'missing-qfq' | 'amount-gap';
  /** 一句话说清「哪里错了、错成什么样」 */
  detail: string;
  /** 处理动作 */
  fix: string;
  /** 状态：fixed=已修复留痕 / retained=有意保留（如 no-data 的老行） */
  status: 'fixed' | 'retained';
  /** 记录写入时间（ISO） */
  recordedAt: string;
}

export interface SourceConfig {
  providers: ProviderStatusInfo[];
  layers: LayerStatusInfo[];
  engine: PullEngine;
  /** 日 K 层锁死说明（不给切换，见 §0.5 换源改写 37.54% 的实测） */
  dailyLock: { provider: ProviderId; adjust: 'qfq' };
  /** 本机是否检测到 Python 解释器（只判解释器，不判桥脚本） */
  pythonAvailable: boolean;
  /**
   * Python 桥脚本（baostock_fetcher.py）是否在位。
   * v0.9.5 起打包版不再随包发布 python/，这里会是 false → UI 必须把「Python / baostock（实验）」置灰。
   */
  pythonScriptReady: boolean;
  /** 库内带成交额（amount≠0）的行占比 0~1；换源后新行 amount=0，这个数会缓慢下降 */
  amountCoverage: number | null;
  /** 已知口径偏差名单（meta.knownAdjustBias）；空数组 = 库里没这回事 */
  adjustBias: AdjustBiasEntry[];
}

/** 本地行情库状态 */
export interface DbStatus {
  stockCount: number;
  /** 真正带 K 线的标的数（可能小于 stockCount：目标内但有标的没取到数据） */
  poolCount: number;
  barCount: number;
  /** 最后一次写入时间（ISO 字符串） */
  lastUpdate: string | null;
  /** 见 DataSourceId；判断是否演示数据用 === 'mock' */
  dataSource: DataSourceId;
  /** K 线起始日期 */
  barFrom: string | null;
  /** K 线截止日期 */
  barTo: string | null;
  /** 当前选股池上限（0=全部） */
  poolLimit: number;
  /** 最近一次写入实际命中的源（meta.provider） */
  provider: ProviderId | null;
  /** 最近一次写入的复权口径（meta.adjust） */
  adjust: 'qfq' | 'hfq' | 'none' | null;
  /** 库内带成交额占比（meta.amountCoverage）；null=从未统计 */
  amountCoverage: number | null;
  /**
   * 当前拉取引擎（meta.pullEngine）：'node'（默认，零依赖）/ 'python'（旧 baostock 实验路径）。
   * Dashboard 的进度条文案要按这个显示，不能写死「baostock 逐只拉取」。
   */
  engine: PullEngine;
  /**
   * 当前日 K 数据源（M6）：日 K 层锁死腾讯 qfq、无降级兜底，这个字段就是它。
   * UI 用来明示「日 K 来自哪个源」，避免用户不知道数据出处。
   */
  dailySource: ProviderId;
  /** 日 K 源熔断状态（M6）：closed=正常 / open=已熔断（日 K 暂不可用）/ half-open=试探中 */
  dailyBreaker: 'closed' | 'open' | 'half-open';
  /**
   * 日 K 是否处于「降级/不可用」态（M6）。
   * 日 K 无自动回退次源，所以 open/half-open 就等于腾讯在熔断 —— UI 应显式警示，
   * 绝不能让用户在腾讯挂掉时还以为「只是没数据」。
   */
  degraded: boolean;
}

/** 数据健康（v0.9.2）：本地标的覆盖度——universeSize 缺失表示尚未跑过全市场口径回填 */
export interface DataHealth {
  /** 库内标的总数（stocks 表） */
  stocksCount: number;
  /** 最近一次全市场口径名单总数（meta.universeSize；null=未知） */
  universeSize: number | null;
  /** 最后一次写入时间（ISO 字符串） */
  lastUpdate: string | null;
}

/** 拉取历史数据结果 */
export interface PullResultPayload {
  inserted: number;
  updated: number;
  error: string | null;
  /** 见 DataSourceId；判演示数据用 === 'mock' */
  source?: DataSourceId;
  /** 本次目标标的数 */
  codes?: number;
  /** 本次未取到数据的标的数（服务端波动） */
  failed?: number;
  /** 本次全市场名单总数（fill-missing/全量时由名单接口返回） */
  universeSize?: number;
}

/** Python/baostock 环境探测结果 */
export interface PythonDetectResult {
  /** 命中的可用解释器路径；null 表示未找到带 baostock 的解释器 */
  found: string | null;
  /** 已生成的全部候选路径（诊断用） */
  candidates: string[];
  /** 实际尝试过的候选（按顺序，用于定位卡在哪一步） */
  tried: string[];
}

/** A 股行情行（本地库已有标的的最新一根 K 线汇总） */
export interface MarketRow {
  code: string;
  name: string;
  industry: string;
  market: string;
  /** 最新交易日 */
  date: string;
  close: number;
  preClose: number;
  /** 涨跌额 */
  change: number;
  /** 涨跌幅 % */
  changePct: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /** 本地 K 线根数 */
  bars: number;
  barFrom: string;
  barTo: string;
}

/** 拉取进度事件（主进程 → 渲染进程单向推送） */
export interface PullProgress {
  phase: 'code-list' | 'fetch' | 'done' | 'error';
  done: number;
  total: number;
  bars: number;
  message: string;
}

/** IPC 响应载荷映射：channel -> 返回值 */
export interface IpcResponseMap {
  'data:pullHistory': PullResultPayload;
  'data:status': DbStatus;
  'data:sourceConfig': SourceConfig;
  'data:setSourcePreference': { ok: boolean; error: string | null };
  'data:setPullEngine': { ok: boolean; error?: string | null };
  'data:detectPython': PythonDetectResult;
  'data:dataHealth': DataHealth;
  'market:list': MarketRow[];
  'limitup:pool': LimitUpPoolResult;
  'sentiment:get': SentimentResult;
  'strategy:list': StrategyMeta[];
  'strategy:configGet': StrategyConfig[];
  'strategy:configSave': { ok: boolean };
  'strategy:applyPreset': { ok: boolean; presetId: string; count: number };
  'strategy:listPresets': StrategyPresetInfo[];
  'screener:run': ScreenResult;
  'backtest:run': BacktestResult;
  'backtest:exportExcel': { ok: boolean; path?: string | null; error?: string | null; canceled?: boolean };
  'backtest:compare': StrategyCompareResult;
  'backtest:sensitivity': SensitivityResult;
  'stock:detail': StockDetail | null;
  'scheduler:get': SchedulerConfig;
  'scheduler:set': { ok: boolean };
  'app:info': AppInfo;
  'window:fitContent': void;
  'watch:list': WatchlistRow[];
  'watch:upsert': { ok: boolean; error?: string | null };
  'watch:remove': { ok: boolean };
  'watch:has': { has: boolean };
  'sector:refresh': { ok: boolean; sectors: number; members: number; error?: string | null };
  'sector:list': SectorRow[];
  'sector:detail': SectorDetail | null;
}

/** IPC 事件映射：主进程 -> 渲染进程单向推送 */
export interface IpcEventMap {
  'data:pullProgress': PullProgress;
  'app:navigate': { path: string };
}

export type IpcChannel = keyof IpcRequestMap;
export type IpcEvent = keyof IpcEventMap;
