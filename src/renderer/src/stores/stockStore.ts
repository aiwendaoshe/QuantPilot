import { defineStore } from 'pinia';
import type { Signal, StrategyId } from '@shared/types/signal';
import type { StrategyMeta, StrategyConfig } from '@shared/types/strategy';
import type { StockDetail } from '@shared/types/stock';
import type { BacktestResult, BacktestOptions, StrategyCompareResult, SensitivityResult } from '@shared/types/backtest';
import type { SchedulerConfig } from '@shared/types/scheduler';
import type {
  Capability,
  DbStatus,
  DataHealth,
  MarketRow,
  PullProgress,
  ProviderId,
  PullEngine,
  PythonDetectResult,
  ScreenScope,
  SentimentResult,
  SourceConfig,
  StrategyPresetInfo,
  LimitUpPoolResult,
  WatchlistRow,
  WatchUpsert,
} from '@shared/types/ipc';
import { quantApi } from '../api/quantApi';
import { plainify } from '../utils/plain';
import { IPC } from '@shared/constants/channels';

const UNIVERSE_KEY = 'qp.pullUniverse';
/** 可选拉取范围（标的数）；数值越大越慢 */
export const UNIVERSE_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 200, label: '200 只（最快）', hint: '约 1~3 分钟' },
  { value: 500, label: '500 只（推荐）', hint: '约 5~10 分钟' },
  { value: 1000, label: '1000 只', hint: '约 15~30 分钟' },
  { value: 2000, label: '2000 只（最慢）', hint: '约 30~60 分钟' },
  // value=0 = 不截断，走全市场（沪深主板/创业板/科创板约 5400 只，不含北交所）
  { value: 0, label: '全市场（约 5400 只）', hint: '约 20~40 分钟 / 约 300MB / 回看 3 年' },
];

function loadUniverse(): number {
  const raw = window.localStorage.getItem(UNIVERSE_KEY);
  const n = raw === null ? NaN : Number(raw);
  return UNIVERSE_OPTIONS.some((o) => o.value === n) ? n : 500;
}

/** 上次选股结果的「版本信息」（v0.9.7）：UI 据此如实告诉用户「这排结果是几号算的」 */
export interface ScreenMeta {
  /** true = 命中指纹缓存，本次没有真的跑计算 */
  cached: boolean;
  /** 结果产生时间（ISO）；缓存命中时是缓存的产生时刻 */
  computedAt: string | null;
  /** 结果依赖的数据日期（库内最后一根 K 线日期） */
  dataDate: string | null;
}

interface StockState {
  signals: Signal[];
  strategies: StrategyMeta[];
  configs: StrategyConfig[];
  /** 策略组合预设（只读定义，来自主进程 presets.ts） */
  presets: StrategyPresetInfo[];
  stockDetail: StockDetail | null;
  backtestResult: BacktestResult | null;
  scheduler: SchedulerConfig | null;
  loading: boolean;
  lastUpdate: string;
  /** 本地行情库状态 */
  dbStatus: DbStatus;
  /** 数据健康：本地标的覆盖度（v0.9.2；null=尚未加载） */
  health: DataHealth | null;
  /** 数据拉取中（Node 批量回填可能耗时数分钟） */
  pulling: boolean;
  pullMessage: string;
  /** 实时抓取进度（主进程推送） */
  pullProgress: PullProgress | null;
  /** 本次选择的拉取范围（标的数） */
  universe: number;
  /** Python/baostock 环境探测结果 */
  pyDetect: PythonDetectResult | null;
  detecting: boolean;
  /** A 股行情列表（本地库内已有标的） */
  marketRows: MarketRow[];
  marketLoading: boolean;
  marketLoaded: boolean;
  /** 涨停池（v0.9.0） */
  limitUpResult: LimitUpPoolResult | null;
  limitUpLoading: boolean;
  /** 上次查询的日期（空串 = 最新交易日），用于缓存跳过 */
  limitUpDate: string;
  /** 上次选股结果的版本信息（v0.9.7 指纹缓存）；null=尚未算过 */
  screenMeta: ScreenMeta | null;
  /** 市场情绪看板（M3）；null=尚未加载 */
  sentimentResult: SentimentResult | null;
  sentimentLoading: boolean;
  /** 情绪缓存键 `${date}|${historyDays}`，避免重复全池扫描 */
  sentimentKey: string;
  /** 多策略横向对比（M5） */
  compareResult: StrategyCompareResult | null;
  comparing: boolean;
  /** 参数敏感度扫描（M5） */
  sensitivityResult: SensitivityResult | null;
  sensitivityLoading: boolean;
  /** 选股真的在跑（命中指纹缓存不算）；与 loading 分离，避免切回页面闪一下「正在运行策略引擎…」 */
  screening: boolean;
  /** 数据源配置（名单/快照/日 K 三层 + 拉取引擎），null=尚未加载 */
  sourceConfig: SourceConfig | null;
  /** 切换数据源 / 引擎时的失败原因（合法切换不产生） */
  sourceError: string | null;
  /** 自选股列表（M4） */
  watchlist: WatchlistRow[];
  watchlistLoading: boolean;
  /** 当前选股范围（M4）：'all' 全市场 / 'watchlist' 仅自选池 */
  screenScope: ScreenScope;
}

export const useStockStore = defineStore('stock', {
  state: (): StockState => ({
    signals: [],
    strategies: [],
    configs: [],
    presets: [],
    stockDetail: null,
    backtestResult: null,
    scheduler: null,
    loading: false,
    lastUpdate: '',
    dbStatus: {
      stockCount: 0,
      poolCount: 0,
      barCount: 0,
      lastUpdate: null,
      dataSource: 'mock',
      barFrom: null,
      barTo: null,
      poolLimit: 500,
      provider: null,
      adjust: null,
      amountCoverage: null,
      engine: 'node',
      dailySource: 'tencent',
      dailyBreaker: 'closed',
      degraded: false,
    },
    health: null,
    pulling: false,
    pullMessage: '',
    pullProgress: null,
    universe: 500,
    pyDetect: null,
    detecting: false,
    marketRows: [],
    marketLoading: false,
    marketLoaded: false,
    limitUpResult: null,
    limitUpLoading: false,
    limitUpDate: '',
    sentimentResult: null,
    sentimentLoading: false,
    sentimentKey: '',
    compareResult: null,
    comparing: false,
    sensitivityResult: null,
    sensitivityLoading: false,
    screenMeta: null,
    screening: false,
    sourceConfig: null,
    sourceError: null,
    watchlist: [],
    watchlistLoading: false,
    screenScope: 'all',
  }),
  actions: {
    /** 从本地读出上次选择的范围，并由主进程进度事件驱动 UI */
    initUi(): void {
      this.universe = loadUniverse();
      quantApi().onPullProgress((p) => {
        this.pullProgress = p;
        if (p.phase === 'done' || p.phase === 'error') this.pullMessage = p.message;
      });
    },

    setUniverse(v: number): void {
      this.universe = v;
      window.localStorage.setItem(UNIVERSE_KEY, String(v));
    },

    /**
     * 跑选股（v0.9.7 指纹缓存 / M4 支持仅扫自选池）。
     * 主进程按「数据日期+根数+池上限+策略参数+scope(+自选内容)」判指纹：命中就直接把上次结果回传（cached=true），
     * 所以「切走再切回仪表盘」不会再白扫一遍全池——只有数据或策略真变了才会重算。
     * force=true 给「重新选股」按钮用。scope 缺省用当前 store.screenScope。
     */
    async runScreener(force = false, scope?: ScreenScope): Promise<void> {
      this.screening = true;
      const useScope = scope ?? this.screenScope;
      try {
        const res = await quantApi().invoke('screener:run', { force, scope: useScope });
        // 命中缓存就立刻收起进度文案，别让用户看到一次无意义的「正在运行策略引擎…」
        this.screening = !res.cached;
        this.signals = [...res.signals].sort((a, b) => b.score - a.score).slice(0, 20);
        this.screenMeta = {
          cached: res.cached,
          computedAt: res.computedAt,
          dataDate: res.dataDate,
        };
      } finally {
        this.loading = false;
        // 异常路径（IPC 抛错）也要收起进度，否则「正在运行策略引擎…」会一直挂着。
        // 命中缓存的分支上面已经置 false，这里重复赋一次无副作用。
        this.screening = false;
      }
    },

    /** 切换选股范围（全市场 / 仅自选池）并按新范围重算 */
    async setScreenScope(scope: ScreenScope): Promise<void> {
      this.screenScope = scope;
      await this.runScreener(true, scope);
    },

    // ---- 自选股（M4）----
    async loadWatchlist(): Promise<void> {
      this.watchlistLoading = true;
      try {
        this.watchlist = await quantApi().invoke('watch:list');
      } finally {
        this.watchlistLoading = false;
      }
    },

    /** 新增或更新自选；写完顺手刷新列表（成本/分组变动立刻反映） */
    async upsertWatch(input: WatchUpsert): Promise<{ ok: boolean; error?: string | null }> {
      const r = await quantApi().invoke('watch:upsert', input);
      if (r.ok) await this.loadWatchlist();
      return r;
    },

    async removeWatch(code: string): Promise<void> {
      await quantApi().invoke('watch:remove', { code });
      await this.loadWatchlist();
    },

    async hasWatch(code: string): Promise<boolean> {
      const r = await quantApi().invoke('watch:has', { code });
      return r.has;
    },

    async refreshStatus(): Promise<void> {
      const st = await quantApi().invoke('data:status');
      this.dbStatus = st;
      this.lastUpdate = st.lastUpdate ?? '';
    },

    /**
     * 拉取历史数据：默认走 Node 内置源（零依赖，见「设置 → 数据源」）；
     * 旧 baostock 双轨要用户在设置里显式切引擎，不再自动兜底（打包版没随包发 Python 桥）。
     * force=true 为全量回填（按当前范围重建，可能耗时数分钟）；
     * mode='fill-missing' 为补拉缺失标的（v0.9.2，只拉全市场名单里本地没有的）。
     */
    async pullHistory(force = false, mode?: 'full' | 'incremental' | 'fill-missing'): Promise<void> {
      this.pulling = true;
      this.pullProgress = null;
      const target = this.universe === 0 ? '全市场（沪深 A 股）' : `目标 ${this.universe} 只`;
      this.pullMessage =
        mode === 'fill-missing'
          ? '正在对照全市场名单补拉缺失标的…'
          : force
            ? `正在全量回填（${target}）…`
            : '正在增量更新库内已有标的…';
      try {
        const res = await quantApi().invoke('data:pullHistory', {
          force,
          universe: this.universe,
          mode,
        });
        if (res.source === 'baostock' && res.error) {
          // 拉取失败但本地真实数据被保留
          this.pullMessage = `拉取失败：${res.error}（已保留本地行情数据）`;
        } else if (res.source === 'mock') {
          this.pullMessage = res.error
            ? `数据拉取失败（${res.error}），已回退内置演示数据`
            : '当前为内置演示数据（未取到真实行情）';
        } else {
          const parts = [`完成 · 目标 ${res.codes ?? 0} 只`, `新增 ${res.inserted} 根`];
          if (res.updated) parts.push(`更新 ${res.updated} 根`);
          if (res.failed) parts.push(`${res.failed} 只未取到（服务端波动，可重试）`);
          this.pullMessage = parts.join(' / ');
        }
        await this.refreshStatus();
        await this.loadHealth();
        this.marketLoaded = false; // 行情表需要重读
        await this.runScreener();
      } finally {
        this.pulling = false;
      }
    },

    /** 数据健康：本地标的覆盖度（v0.9.2） */
    async loadHealth(): Promise<void> {
      this.health = await quantApi().invoke('data:dataHealth');
    },

    /** 探测本机是否装好 baostock（找得到哪个 Python 解释器） */
    async detectPythonEnv(): Promise<void> {
      this.detecting = true;
      try {
        this.pyDetect = await quantApi().invoke('data:detectPython');
        if (this.pyDetect.found) {
          this.pullMessage = `已找到 baostock 解释器：${this.pyDetect.found}`;
        } else {
          this.pullMessage = `未找到带 baostock 的解释器（已探测 ${this.pyDetect.candidates.length} 个候选）`;
        }
      } finally {
        this.detecting = false;
      }
    },

    /** A 股行情：读取本地库内已有标的的最新行情 */
    async loadMarket(force = false): Promise<void> {
      if (this.marketLoaded && !force) return;
      this.marketLoading = true;
      try {
        this.marketRows = await quantApi().invoke('market:list');
        this.marketLoaded = true;
      } finally {
        this.marketLoading = false;
      }
    },

    /** 涨停池：同日期缓存跳过，force 强制重扫 */
    async loadLimitUpPool(date?: string, force = false): Promise<void> {
      const key = date ?? '';
      if (this.limitUpResult && this.limitUpDate === key && !force) return;
      this.limitUpLoading = true;
      try {
        this.limitUpResult = await quantApi().invoke('limitup:pool', { date });
        this.limitUpDate = key;
      } finally {
        this.limitUpLoading = false;
      }
    },

    /** 市场情绪看板（M3）：全池扫描较重（十几秒），故按 date+historyDays 缓存，避免来回切页重复扫 */
    async loadSentiment(date?: string, historyDays = 30, force = false): Promise<void> {
      const key = `${date ?? ''}|${historyDays}`;
      if (this.sentimentResult && this.sentimentKey === key && !force) return;
      this.sentimentLoading = true;
      try {
        this.sentimentResult = await quantApi().invoke('sentiment:get', { date, historyDays });
        this.sentimentKey = key;
      } finally {
        this.sentimentLoading = false;
      }
    },

    async loadStrategies(): Promise<void> {
      this.strategies = await quantApi().invoke('strategy:list');
    },

    async loadConfig(): Promise<void> {
      this.configs = await quantApi().invoke('strategy:configGet');
    },

    async saveConfig(configs: StrategyConfig[]): Promise<void> {
      // 调用方常把 reactive 草稿直接传进来，先转纯数据再落状态（响应式代理过不了 IPC）
      const payload = plainify(configs);
      await quantApi().invoke('strategy:configSave', { configs: payload });
      this.configs = payload;
    },

    /** 读取策略组合预设定义（组合A/B/C/D） */
    async loadPresets(): Promise<void> {
      this.presets = await quantApi().invoke('strategy:listPresets');
    },

    /**
     * 应用组合预设：只切换 enabled，保留参数。
     * 传入当前草稿 configs（含用户已调未保存的参数），落库后拉回权威配置。
     */
    async applyPreset(presetId: string, draftConfigs?: StrategyConfig[]): Promise<void> {
      await quantApi().invoke('strategy:applyPreset', plainify({ presetId, configs: draftConfigs }));
      this.configs = await quantApi().invoke('strategy:configGet');
    },

    async loadStockDetail(code: string): Promise<void> {
      this.loading = true;
      try {
        this.stockDetail = await quantApi().invoke('stock:detail', { code });
      } finally {
        this.loading = false;
      }
    },

    async runBacktest(
      strategyId: StrategyId,
      startDate: string,
      endDate: string,
      options: BacktestOptions,
    ): Promise<void> {
      this.loading = true;
      try {
        this.backtestResult = await quantApi().invoke('backtest:run', {
          strategyId,
          startDate,
          endDate,
          options,
        });
      } finally {
        this.loading = false;
      }
    },

    /**
     * 导出最近一次回测为 Excel(M5)。主进程弹保存框写盘。
     * @returns 写入结果；canceled=true 表示用户在保存框点了取消（不算错误）
     */
    async exportBacktestXlsx(): Promise<{ ok: boolean; path?: string | null; error?: string | null; canceled?: boolean }> {
      return quantApi().invoke('backtest:exportExcel');
    },

    /** 多策略横向对比（M5）：同区间同参数下各跑一次回测，主进程按收益率降序返回 */
    async compareStrategies(
      strategyIds: string[],
      startDate: string,
      endDate: string,
      options: BacktestOptions,
    ): Promise<StrategyCompareResult> {
      this.comparing = true;
      try {
        this.compareResult = await quantApi().invoke('backtest:compare', {
          strategyIds,
          startDate,
          endDate,
          options,
        });
        return this.compareResult;
      } finally {
        this.comparing = false;
      }
    },

    /** 参数敏感度扫描（M5）：某数值参数网格取值各跑一次回测（不写回用户配置） */
    async scanSensitivity(
      strategyId: string,
      paramKey: string,
      startDate: string,
      endDate: string,
      options: BacktestOptions,
      values: number[],
    ): Promise<SensitivityResult> {
      this.sensitivityLoading = true;
      try {
        this.sensitivityResult = await quantApi().invoke('backtest:sensitivity', {
          strategyId,
          paramKey,
          startDate,
          endDate,
          options,
          values,
        });
        return this.sensitivityResult;
      } finally {
        this.sensitivityLoading = false;
      }
    },

    /**
     * 数据源配置（设置页「数据源」区块）。
     * 三层各自可换：名单（universe）/ 快照（snapshot）；日 K 由主进程锁死为腾讯 qfq，不给选项。
     */
    async loadSourceConfig(): Promise<void> {
      this.sourceConfig = await quantApi().invoke(IPC.SOURCE_CONFIG);
      this.sourceError = null;
    },

    /** 设置某一能力层的首选源；非法切换由主进程回传 error，不静默 */
    async setSourcePreference(cap: Capability, provider: ProviderId): Promise<void> {
      const res = await quantApi().invoke(IPC.SET_SOURCE_PREFERENCE, {
        cap,
        provider,
      });
      this.sourceError = res.error;
      // 偏好已落库（meta.providerPref.<cap>），但熔断/当前可用态要重新取才准
      if (res.ok) await this.loadSourceConfig();
    },

    /**
     * 切换拉取引擎（node=零依赖默认；python=旧 baostock 实验路径）。
     * 打包版没有随包发布 python/，切 python 会被主进程拒（回传 error），这里如实显示不静默。
     */
    async setPullEngine(engine: PullEngine): Promise<void> {
      const res = await quantApi().invoke(IPC.SET_PULL_ENGINE, { engine });
      this.sourceError = res.ok ? null : (res.error ?? '切换失败');
      if (res.ok && this.sourceConfig) this.sourceConfig.engine = engine;
      if (!res.ok) await this.loadSourceConfig();
    },

    async loadScheduler(): Promise<void> {
      this.scheduler = await quantApi().invoke('scheduler:get');
    },

    async saveScheduler(config: SchedulerConfig): Promise<void> {
      // 同上：设置页传来的可能是 reactive draft，落进 pinia 前先转纯数据
      const payload = plainify(config);
      await quantApi().invoke('scheduler:set', { config: payload });
      this.scheduler = payload;
    },
  },
});
