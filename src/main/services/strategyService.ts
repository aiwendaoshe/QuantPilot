import Store from 'electron-store';
import log from 'electron-log';
import { createHash } from 'node:crypto';
import { allStrategies } from '../../../strategy/registry';
import { runBacktest } from '../../../strategy/backtest';
import { buildReport } from '@shared/reportCore';
import { buildXlsx } from '../../../strategy/xlsx';
import { writeFileSync } from 'node:fs';
import { aggregateSignals } from '../../../strategy/aggregate';
import { presetById, DEFAULT_PRESET_ID, STRATEGY_PRESETS } from '../../../strategy/presets';
import { SCREEN_BARS } from '../../../strategy/dbPool';
import type { StrategyBase } from '../../../strategy/StrategyBase';
import { computeLimitUpPool } from '../../../strategy/limitup';
import { computeSentiment } from '../../../strategy/sentiment';
import type { StrategyConfig, StrategyMeta } from '@shared/types/strategy';
import type { Signal, SignalMark, StrategyId } from '@shared/types/signal';
import type { BacktestOptions, BacktestResult } from '@shared/types/backtest';
import type { LimitUpPoolResult, ScreenResult, ScreenScope, SentimentResult } from '@shared/types/ipc';
import type {
  StrategyCompareResult,
  StrategyCompareRow,
  SensitivityPoint,
  SensitivityResult,
} from '@shared/types/backtest';
import type { StockDetail, DailyBar } from '@shared/types/stock';
import { dataService } from './dataService';
import { computeService } from './computeService';

interface StoreSchema {
  configs: StrategyConfig[];
}

const store = new Store<StoreSchema>({ defaults: { configs: [] } });

/** 选股任务并发锁：托盘「重新选股」连点 / 与仪表盘同时触发时只跑一次 */
let screenTask: Promise<ScreenResult> | null = null;

/** 涨停池任务并发锁：防止连点重复扫全池 */
let limitUpTask: Promise<LimitUpPoolResult> | null = null;

/** 最近一次回测结果 + 策略名（M5 导出用；结果可能上千笔，留在主进程不让渲染层再传一遍） */
let lastBacktest: { result: BacktestResult; name: string } | null = null;

/**
 * 选股结果缓存（v0.9.7，主子拍板：指纹命中就不算）。
 *
 * 起因：仪表盘 onMounted 无条件跑选股，而路由没套 KeepAlive —— 切走 unmount、切回 remount，
 * 每次切回都白扫一遍全池（5400 只 × 320 根 ≈ 173 万根）。主进程的并发锁只挡得住「同时」，
 * 挡不住「串行重入」，所以那条锁救不了。
 *
 * 解法：选股是 f(数据 × 策略) 的纯函数 —— 输入没变，结果在数学上不可能变。
 * 按「数据日期 + K线根数 + 池上限 + asOf + 启用策略id/参数」算指纹，命中即复用。
 * 两级：内存命中最快，跨进程命中走 meta.screenCache（冷启动也秒开）。
 */
interface ScreenCacheEntry {
  key: string;
  signals: Signal[];
  computedAt: string;
  dataDate: string | null;
}

let screenCache: ScreenCacheEntry | null = null;

/**
 * 选股输入指纹。
 * 刻意不放 dbPath（随安装目录漂移，换目录就白算一次）、不放 provider（换源不改历史 K 线时结果一致）。
 * ⚠️ scope 必须在 key 里（M4）：'all' 与 'watchlist' 是两份不同结果，不区分就会互相命中缓存。
 */
function screenKeyOf(date?: string, scope: ScreenScope = 'all'): string {
  const st = dataService.getStatus();
  const enabled = buildStrategies()
    .filter((s) => s.getConfig().enabled)
    .map((s) => `${s.id}:${JSON.stringify(s.getConfig().params)}`)
    .sort();
  // 自选池内容变了（加/删票）也要换 key：把自选 code 摘要并进来
  const watchSig =
    scope === 'watchlist'
      ? dataService
          .watchlistCodes()
          .join(',')
      : '';
  return createHash('sha1')
    .update(
      [
        st.barTo ?? '',
        st.barCount ?? 0,
        dataService.poolLimit(),
        date ?? '',
        scope,
        watchSig,
        enabled.join('|'),
      ].join('\x1f'),
    )
    .digest('hex')
    .slice(0, 16);
}

/** 指纹命中则返回缓存，同时把磁盘命中回填进内存（下次不再读盘） */
function screenCacheHit(key: string): ScreenCacheEntry | null {
  if (screenCache && screenCache.key === key) return screenCache;
  const persisted = dataService.readScreenCache();
  if (persisted && persisted.key === key) {
    screenCache = persisted;
    return persisted;
  }
  return null;
}

/** 策略注册表：返回全部 7 个内置策略（阶段一验证 + 阶段二 6 大） */
function baseStrategies(): StrategyBase[] {
  return allStrategies();
}

function buildStrategies(): StrategyBase[] {
  const saved = store.get('configs');
  const hasSaved = Array.isArray(saved) && saved.length > 0;
  if (hasSaved) {
    return baseStrategies().map((s) => {
      const cfg = (saved as StrategyConfig[]).find((c) => c.id === s.id);
      if (cfg) s.setConfig(cfg);
      return s;
    });
  }
  // 出厂默认：configs 为空（全新安装 / 已重置）时启用默认组合（组合A），其余策略禁用
  const preset = presetById(DEFAULT_PRESET_ID);
  return baseStrategies().map((s) => {
    s.setConfig({
      id: s.id,
      enabled: preset ? preset.enabled.includes(s.id) : true,
      params: {},
    });
    return s;
  });
}

export const strategyService = {
  /** 是否有选股任务在跑（托盘菜单据此给「正在选股…」提示，避免连点无反馈） */
  isScreening(): boolean {
    return screenTask !== null;
  },

  listStrategies(): StrategyMeta[] {
    return baseStrategies().map((s) => s.meta);
  },

  /** 列出全部策略组合预设（只读，供 UI 渲染切换按钮） */
  listPresets() {
    return STRATEGY_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      enabled: p.enabled,
    }));
  },

  getConfig(): StrategyConfig[] {
    return buildStrategies().map((s) => s.getConfig());
  },

  /**
   * 保存策略配置：写入持久化 store，并立刻让内存里的策略实例生效。
   * 校验失败直接抛错（渲染层会显示原因），绝不静默「点了没反应」。
   */
  saveConfig(req: { configs: StrategyConfig[] }): { ok: boolean; count: number } {
    const incoming = Array.isArray(req?.configs) ? req.configs : [];
    const known = new Set(baseStrategies().map((s) => s.id));
    for (const c of incoming) {
      if (!known.has(c.id)) throw new Error(`未知策略 id：${String(c.id)}`);
      if (typeof c.enabled !== 'boolean') throw new Error(`策略 ${c.id} 的 enabled 必须是布尔值`);
      if (!c.params || typeof c.params !== 'object') throw new Error(`策略 ${c.id} 缺少 params`);
    }
    // 全量覆盖写入：草稿里没出现的策略一律回落为默认配置，避免旧值残留在 store 里
    const all = baseStrategies().map((s) => {
      const hit = incoming.find((c) => c.id === s.id);
      return hit ? { id: s.id, enabled: hit.enabled, params: { ...hit.params } } : s.getConfig();
    });
    store.set('configs', all);
    // 立刻把新配置灌进内存实例，保证后续的选股/回测/详情同一次请求内一致
    for (const s of baseStrategies()) {
      const hit = all.find((c) => c.id === s.id);
      if (hit) s.setConfig(hit);
    }
    log.info(`[strategyService] 配置已保存 ${all.length} 条`, all.map((c) => c.id).join(','));
    return { ok: true, count: all.length };
  },

  /**
   * 应用策略组合预设：按预设的 enabled 列表重写持久化配置。
   * 铁律（主子定）——预设「只管开关、不动参数」：
   *   参数优先取前端传来的草稿（保住用户已调未保存的参数），否则取各策略当前生效参数；
   *   绝不回落成 defaultParams，否则用户调好的参数会被组合切换一键抹掉。
   */
  applyPreset(req: { presetId: string; configs?: StrategyConfig[] }): {
    ok: boolean;
    presetId: string;
    count: number;
  } {
    const preset = presetById(req?.presetId ?? DEFAULT_PRESET_ID);
    if (!preset) throw new Error(`未知预设: ${String(req?.presetId)}`);
    const draft = Array.isArray(req?.configs) ? req.configs : [];
    const configs: StrategyConfig[] = baseStrategies().map((s) => {
      const fromDraft = draft.find((c) => c.id === s.id);
      const params = fromDraft?.params ?? s.getConfig().params;
      return { id: s.id, enabled: preset.enabled.includes(s.id), params: { ...params } };
    });
    const res = this.saveConfig({ configs });
    log.info(
      `[strategyService] 已应用组合预设 ${preset.id}（${preset.name}），启用 ${preset.enabled.length} 个策略`,
    );
    return { ok: res.ok, presetId: preset.id, count: res.count };
  },

  /**
   * 选股：优先在 Worker 线程计算（不阻塞主进程/渲染进程），
   * Worker 不可用或失败时回退主进程同步计算。
   */
  async runScreener(
    req: { date?: string; force?: boolean; scope?: ScreenScope } | undefined,
    topN = 20,
  ): Promise<ScreenResult> {
    const scope: ScreenScope = req?.scope ?? 'all';
    // 指纹必须含 scope：全市场 vs 自选池是**两份不同结果**，不进 key 会互相命中缓存显示错数据
    const key = screenKeyOf(req?.date, scope);

    // ① 并发锁放在缓存**之前**：连点「重新选股」时连缓存判定都别绕过去，直接复用进行中的任务
    if (screenTask) {
      log.warn('[strategyService] 已有选股任务在进行中，本次点击复用它');
      return screenTask;
    }

    // ② 指纹缓存命中即复用（切走再切回仪表盘不该重算）；force 只给「重新选股」按钮
    const hit = req?.force ? null : screenCacheHit(key);
    if (hit) {
      log.info(
        `[strategyService] 命中选股缓存 key=${key} · ${hit.signals.length} 只 · 计算于 ${hit.computedAt}`,
      );
      return {
        signals: hit.signals,
        cached: true,
        computedAt: hit.computedAt,
        dataDate: hit.dataDate,
        key,
      };
    }

    screenTask = (async (): Promise<ScreenResult> => {
  // 结果依赖的数据日期：先取，计算过程中不会再写库
  const dataDate = dataService.getStatus().barTo ?? null;
  /** 算完即入缓存（内存 + meta 双级），并把「这结果是几号算的」如实带出去 */
  const pack = (signals: Signal[], cached: boolean): ScreenResult => {
    const entry: ScreenCacheEntry = { key, signals, computedAt: new Date().toISOString(), dataDate };
    screenCache = entry;
    dataService.saveScreenCache(entry);
    return { signals, cached, computedAt: entry.computedAt, dataDate, key };
  };
  // 选股池跟随「数据范围」设置：只取每只最近 N 根 K 线，池子放大到上千只也不会吃爆内存。
  // 关键性能改造（PID-02）：不再在主进程读全池后结构化克隆给 Worker（5400×320≈173 万根，
  // 克隆峰值 0.5~1.5GB），而是只把 dbPath + 范围参数交给 Worker，由 Worker 直连 SQLite 流式取算。
  // asOf 在闭包外先取值：req 允许为 undefined（scheduler 与 IPC 都传 {}），闭包里直接读会报 possibly undefined
  const asOfDate = req?.date; // 保持 undefined（不是 null）：computeService 要 string | undefined
  const dbPath = dataService.dbPath();
  const limit = dataService.poolLimit();
  const configs = buildStrategies().map((s) => s.getConfig());
  // 「仅扫自选池」：自选池很小（几十只），直接把池喂给 Worker（走 req.pool 就地算），
  // 不用改 SQL/流式取——那样反而把大池的性能优势丢了。dbPath 仍传，pool 存在时 Worker 优先用 pool。
  const watchPool = scope === 'watchlist' ? dataService.getWatchlistPool(SCREEN_BARS) : null;
  const res = await computeService.call({
    kind: 'screener',
    dbPath,
    limit,
    recentBars: SCREEN_BARS,
    configs,
    asOf: asOfDate,
    topN,
    ...(watchPool ? { pool: watchPool } : {}),
  });
  if (res && res.ok && res.kind === 'screener') {
    log.info(`[strategyService] 选股(Worker) 完成：${res.signals.length} 只`);
    return pack(res.signals, false);
  }
  if (res && !res.ok) log.warn('[strategyService] Worker 选股失败，回退主进程:', res.error);

  // ---- 主进程同步兜底（Worker 不可用/失败）：主进程自己批量读池再算 ----
  const pool = scope === 'watchlist' ? dataService.getWatchlistPool(SCREEN_BARS) : dataService.getScreeningPool();
  log.info(`[strategyService] 选股池 ${pool.length} 只（主进程兜底 · scope=${scope}）`);
  const asOf = asOfDate;
  const strategies = buildStrategies();
  const signals: Signal[] = [];
  for (const strat of strategies) {
    if (!strat.getConfig().enabled) continue;
    for (const series of pool) {
      const bars = asOf ? series.bars.filter((b) => b.date <= asOf) : series.bars;
      if (bars.length === 0) continue;
      const sig = strat.generateSignal(bars, series.meta);
      if (sig) signals.push(sig);
    }
  }
      const out = aggregateSignals(signals).slice(0, topN);
      log.info(`[strategyService] 选股(主进程) 完成：${out.length} 只（含同股多策略合并）`);
      return pack(out, false);
    })();
    try {
      return await screenTask;
    } finally {
      screenTask = null;
    }
  },

  /**
   * 显式失效选股缓存（v0.9.7）。
   * 指纹能自动挡住「数据/策略没变」；但**历史数据被就地修正**（如补 preClose、改 amount）时
   * 数据日期和根数可能都不变，指纹不变 → 必须靠这口显式失效，否则旧结果会冒充新结果。
   * 调用点：拉完数据、切数据源/引擎、改策略配置、清库重建。
   */
  invalidateScreenCache(reason: string): void {
    screenCache = null;
    dataService.clearScreenCache();
    log.info(`[strategyService] 选股缓存已失效（${reason}）`);
  },

  /** 回测：优先 Worker 线程，失败回退主进程 */
  async runBacktest(req: {
    strategyId: string;
    startDate: string;
    endDate: string;
    options: BacktestOptions;
  }): Promise<BacktestResult> {
    const out = await this.backtestOnce(req.strategyId, req.startDate, req.endDate, req.options);
    // 缓存本次结果：导出 Excel 时用（M5）。结果可能上千笔，不让渲染层再传一遍。
    const meta = this.listStrategies().find((s) => s.id === req.strategyId);
    lastBacktest = { result: out, name: meta?.name ?? req.strategyId };
    return out;
  },

  /**
   * 单策略跑一次回测（runBacktest / 多策略对比 / 参数敏感度 共用）。
   * @param overrideParams 参数覆盖（如敏感度扫描把某个 param 换成网格值）——只影响本次，不落盘。
   */
  async backtestOnce(
    strategyId: string,
    startDate: string,
    endDate: string,
    options: BacktestOptions,
    overrideParams?: Record<string, number>,
  ): Promise<BacktestResult> {
    const strategies = buildStrategies();
    const strat = strategies.find((s) => s.id === strategyId);
    if (!strat) {
      throw new Error(`未知策略: ${strategyId}`);
    }
    // 参数覆盖：先应用用户配置，再叠加本次覆盖值（敏感度扫描用；不写回 store）
    if (overrideParams && Object.keys(overrideParams).length > 0) {
      const saved = store.get('configs');
      const base =
        Array.isArray(saved) && saved.length > 0
          ? { ...(saved as StrategyConfig[]).find((c) => c.id === strategyId)?.params }
          : { ...strat.getConfig().params };
      strat.setConfig({ ...strat.getConfig(), params: { ...base, ...overrideParams } });
    }
    // 回测需要完整历史：只把 dbPath + 范围交给 Worker（PID-02），由 Worker 直连 SQLite 读全量历史。
    const range = { startDate, endDate };
    // 传 configs：让 Worker 应用用户参数（v0.9.20 修复，此前 Worker 用默认参数，与兜底路径不一致）
    const configs = strategies.map((s) => s.getConfig());
    const res = await computeService.call({
      kind: 'backtest',
      dbPath: dataService.dbPath(),
      limit: dataService.poolLimit(),
      strategyId: strategyId as StrategyId,
      configs,
      options,
      range,
    });
    if (res && res.ok && res.kind === 'backtest') {
      return res.result;
    }
    if (res && !res.ok) log.warn('[strategyService] Worker 回测失败，回退主进程:', res.error);
    // 主进程兜底：自己批量读池再算（PID-07 批量 SQL）。注意 strat 已是 buildStrategies() 出来的，
    // 参数（含 override）已应用，与 Worker 口径一致。
    const pool = dataService.getPool();
    return runBacktest(strat, pool, options, range);
  },

  /**
   * 多策略横向对比（M5）：同一区间/参数下对多个策略各跑一次回测。
   * 串行执行（回测吃 CPU，并发只会互相拖慢 + 池读放大），策略数上限 7。
   */
  async compareStrategies(req: {
    strategyIds: string[];
    startDate: string;
    endDate: string;
    options: BacktestOptions;
  }): Promise<StrategyCompareResult> {
    const ids = req.strategyIds.slice(0, 7);
    const rows: StrategyCompareRow[] = [];
    for (const id of ids) {
      const meta = this.listStrategies().find((s) => s.id === id);
      try {
        const r = await this.backtestOnce(id, req.startDate, req.endDate, req.options);
        rows.push({
          strategyId: id as StrategyId,
          name: meta?.name ?? id,
          signals: r.totalTrades, // 对比表用交易数代表该策略活跃度
          totalTrades: r.totalTrades,
          winRate: r.winRate,
          profitFactor: r.profitFactor,
          maxDrawdown: r.maxDrawdown,
          sharpe: r.sharpe,
          finalCapital: r.finalCapital,
          initialCapital: r.initialCapital,
          totalReturn: r.initialCapital > 0 ? r.finalCapital / r.initialCapital - 1 : 0,
        });
      } catch (e) {
        log.warn(`[strategyService] 策略对比跳过 ${id}: ${String(e)}`);
      }
    }
    // 按总收益率降序，一眼看出谁强
    rows.sort((a, b) => b.totalReturn - a.totalReturn);
    return { startDate: req.startDate, endDate: req.endDate, rows };
  },

  /**
   * 参数敏感度扫描（M5）：把某个数值参数在 min~max 间按 step 网格取值，各跑一次回测。
   * 每次扫描 = N 次完整回测，故限制网格点上限（默认 9）避免长时间占用。
   * 绝不写回用户配置——只读+覆盖。
   */
  async scanSensitivity(req: {
    strategyId: string;
    paramKey: string;
    startDate: string;
    endDate: string;
    options: BacktestOptions;
    /** 网格值（由渲染层按 paramSchema 的 min/max/step 生成） */
    values: number[];
  }): Promise<SensitivityResult> {
    const meta = this.listStrategies().find((s) => s.id === req.strategyId);
    if (!meta) throw new Error(`未知策略: ${req.strategyId}`);
    const field = meta.paramSchema.find((f) => f.key === req.paramKey);
    if (!field) throw new Error(`策略 ${meta.name} 无参数 ${req.paramKey}`);
    const values = req.values.slice(0, 12); // 上限防呆
    const points: SensitivityPoint[] = [];
    for (const v of values) {
      try {
        const r = await this.backtestOnce(req.strategyId, req.startDate, req.endDate, req.options, {
          [req.paramKey]: v,
        });
        points.push({
          value: v,
          totalReturn: r.initialCapital > 0 ? r.finalCapital / r.initialCapital - 1 : 0,
          winRate: r.winRate,
          maxDrawdown: r.maxDrawdown,
          sharpe: r.sharpe,
          totalTrades: r.totalTrades,
        });
      } catch (e) {
        log.warn(`[strategyService] 敏感度跳过 ${req.paramKey}=${v}: ${String(e)}`);
      }
    }
    // 用户当前该参数取值（用于在结果里标基准线）
    const savedCfg = store.get('configs');
    const savedParams = Array.isArray(savedCfg)
      ? (savedCfg as StrategyConfig[]).find((c) => c.id === req.strategyId)?.params
      : undefined;
    const currentRaw = savedParams?.[req.paramKey] ?? meta.defaultParams[req.paramKey];
    const currentValue = typeof currentRaw === 'number' ? currentRaw : null;
    return {
      strategyId: req.strategyId as StrategyId,
      paramKey: req.paramKey,
      paramLabel: field.label,
      currentValue,
      points,
    };
  },

  /**
   * 导出最近一次回测为 Excel(M5)。零三方依赖：手写 xlsx（strategy/xlsx.ts），
   * 含「回测摘要 / 分年 / 分月 / 交易明细 / 权益曲线」5 张表。
   * @param path 由主进程 save dialog 选定的绝对路径（.xlsx）
   */
  exportBacktestXlsx(path: string): { ok: boolean; error?: string } {
    if (!lastBacktest) return { ok: false, error: '还没有可导出的回测结果，请先跑一次回测' };
    const { result, name } = lastBacktest;
    const rep = buildReport(result.equityCurve, result.trades);
    const totalRet = result.initialCapital > 0 ? (result.finalCapital / result.initialCapital - 1) * 100 : 0;
    const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

    // 摘要表：先建二维数组再 push 回撤行（避免条件展开破坏行元组类型推断）
    const summaryRows: (string | number)[][] = [
      ['项目', '数值'],
      ['策略', `${name}（${result.strategyId}）`],
      ['回测区间', `${result.startDate} ~ ${result.endDate}`],
      ['初始资金', result.initialCapital],
      ['期末资金', result.finalCapital],
      ['总收益率(%)', +totalRet.toFixed(2)],
      ['交易笔数', result.totalTrades],
      ['胜率', pct(result.winRate)],
      ['盈亏比', Number.isFinite(result.profitFactor) ? +result.profitFactor.toFixed(2) : '∞'],
      ['最大回撤', pct(result.maxDrawdown)],
      ['夏普比率', +result.sharpe.toFixed(2)],
      ['平均持仓(交易日)', rep.avgHoldingDays],
      ['最长持仓(交易日)', rep.maxHoldingDays],
      ['最好单笔(%)', +rep.bestTradePct.toFixed(2)],
      ['最差单笔(%)', +rep.worstTradePct.toFixed(2)],
    ];
    if (rep.maxDrawdownPeriod) {
      const d = rep.maxDrawdownPeriod;
      summaryRows.push([
        '最大回撤区间',
        `峰值 ${d.peakDate} → 谷底 ${d.troughDate}（${(d.depth * 100).toFixed(2)}%，历时${d.lengthDays}日，收复：${d.recoveredDate ?? '未收复'}）`,
      ]);
    }

    const buf = buildXlsx([
      {
        name: '回测摘要',
        rows: summaryRows,
      },
      {
        name: '分年收益',
        rows: [
          ['年份', '期初权益', '期末权益', '收益率(%)', '成交笔数'],
          ...rep.yearly.map((r) => [r.year, +r.startEquity.toFixed(2), +r.endEquity.toFixed(2), r.returnPct, r.trades]),
        ],
      },
      {
        name: '分月收益',
        rows: [
          ['月份', '期初权益', '期末权益', '收益率(%)', '成交笔数'],
          ...rep.monthly.map((r) => [r.month, +r.startEquity.toFixed(2), +r.endEquity.toFixed(2), r.returnPct, r.trades]),
        ],
      },
      {
        name: '交易明细',
        rows: [
          ['代码', '名称', '买入日', '买入价', '卖出日', '卖出价', '收益率(%)', '持仓(交易日)', '离场原因'],
          ...result.trades.map((t) => [
            t.code,
            t.name,
            t.entryDate,
            +t.entryPrice.toFixed(2),
            t.exitDate,
            +t.exitPrice.toFixed(2),
            +t.pnlPct.toFixed(2),
            t.holdingDays,
            t.reason,
          ]),
        ],
      },
      {
        name: '权益曲线',
        rows: [['日期', '权益'], ...result.equityCurve.map((p) => [p.date, +p.equity.toFixed(2)])],
      },
    ]);
    writeFileSync(path, buf);
    log.info(`[strategyService] 回测报告已导出：${path}（${result.totalTrades} 笔）`);
    return { ok: true };
  },

  /**
   * 涨停池（v0.9.0）：Worker 直连 SQLite 流式扫尾部 30 根（约 16 万行，秒级），
   * 失败回退主进程同步扫描（computeLimitUpPool 同一实现）。
   */
  async getLimitUpPool(req: { date?: string }): Promise<LimitUpPoolResult> {
    if (limitUpTask) {
      log.warn('[strategyService] 已有涨停池任务在进行中，本次点击复用它');
      return limitUpTask;
    }
    limitUpTask = (async (): Promise<LimitUpPoolResult> => {
      const dbPath = dataService.dbPath();
      // v0.9.1：涨停池是全市场统计页，固定全市场扫描（limit=0），不受「选股池上限」设置约束
      // （v0.9.0 误用 poolLimit() 导致只扫了前 N 名，实证 500 上限把 57 只截成 11 只）
      const limit = 0;
      const res = await computeService.call({
        kind: 'limitup',
        dbPath,
        limit,
        asOf: req.date,
      });
      if (res && res.ok && res.kind === 'limitup') {
        // 完整命中名单进日志（v0.9.2）：与 Python 复算名单 diff 定性口径差异的利器
        const roster = res.result.rows.map((r) => `${r.code}:${r.streak}`).join(' ');
        log.info(
          `[strategyService] 涨停池(Worker) 完成：${res.result.rows.length} 只（${res.result.date}）\n名单: ${roster}`,
        );
        return res.result;
      }
      if (res && !res.ok) log.warn('[strategyService] Worker 涨停池失败，回退主进程:', res.error);
      // 主进程同步兜底（与 Worker 同一实现；量小，同步扫可接受）
      const result = computeLimitUpPool(dataService.limitUpScanDb(), {
        limit,
        asOf: req.date,
      });
      log.info(`[strategyService] 涨停池(主进程) 完成：${result.rows.length} 只（${result.date}）`);
      return result;
    })();
    try {
      return await limitUpTask;
    } finally {
      limitUpTask = null;
    }
  },

  /**
   * 市场情绪看板（M3）：全池情绪横截面 + 近 N 日曲线。
   * 与涨停池同为「全市场统计页」，固定全市场扫描（limit=0），不受选股池上限约束。
   * Worker 优先，失败回退主进程同步（computeSentiment 同一实现）。
   */
  async getSentiment(req: { date?: string; historyDays?: number }): Promise<SentimentResult> {
    const limit = 0;
    const res = await computeService.call({
      kind: 'sentiment',
      dbPath: dataService.dbPath(),
      limit,
      asOf: req.date,
      historyDays: req.historyDays,
    });
    if (res && res.ok && res.kind === 'sentiment') {
      const c = res.result.current;
      log.info(
        `[strategyService] 情绪(Worker) 完成：${c.date} 温度=${c.score}(${c.level}) 涨停=${c.limitUp} 跌停=${c.limitDown} 最高板=${c.maxStreak}`,
      );
      return res.result;
    }
    if (res && !res.ok) log.warn('[strategyService] Worker 情绪失败，回退主进程:', res.error);
    const result = computeSentiment(dataService.limitUpScanDb(), {
      limit,
      asOf: req.date,
      historyDays: req.historyDays,
    });
    log.info(
      `[strategyService] 情绪(主进程) 完成：${result.current.date} 温度=${result.current.score}(${result.current.level})`,
    );
    return result;
  },

  /** 个股详情：近 240 根 K 线 + 历史上各策略信号标记（用于 K 线叠加） */
  getStockDetail(req: { code: string }, windowBars = 240): StockDetail | null {
    const series = dataService.getSeries(req.code);
    if (!series) return null;
    const bars = series.bars.slice(-windowBars);
    const marks: SignalMark[] = [];
    if (bars.length > 0) {
      // 必须用「带用户配置」的实例，否则改了策略参数后个股 K 线上的信号标记仍是默认值
      for (const strat of buildStrategies()) {
        // PID-08 修复：增量 hist（只 push 一次、不每根 slice 复制），把 O(n²) 数组拷贝降为 O(n)。
        const hist: DailyBar[] = [];
        let sliceTo = 0;
        const total = series.bars.length;
        for (const bar of bars) {
          while (sliceTo < total && series.bars[sliceTo].date <= bar.date) {
            hist.push(series.bars[sliceTo]);
            sliceTo++;
          }
          const sig = strat.generateSignal(hist, series.meta);
          if (sig && sig.date === bar.date) {
            marks.push({ date: sig.date, strategyId: sig.strategyId, type: sig.type, score: sig.score });
          }
        }
      }
    }
    return { meta: series.meta, bars, marks };
  },
};
