import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import { exec, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import log from 'electron-log';
import type { DailyBar, StockMeta, StockSeries } from '@shared/types/stock';
import type { Signal } from '@shared/types/signal';
import type {
  AdjustBiasEntry,
  Capability,
  DataSourceId,
  MarketRow,
  PullEngine,
  PullProgress,
  ProviderId,
  SourceConfig,
  SectorRow,
  SectorMemberRow,
  WatchlistRow,
  WatchUpsert,
} from '@shared/types/ipc';
import { IPC_EVENT } from '@shared/constants/channels';
import { ADJUST_BIAS_KEY, resolveAdjustBias } from './adjustBias';
import { generateMockPool } from '../../../strategy/mockData';
import {
  loadScreeningPool,
  loadBacktestPool,
  POOL_HARD_CAP,
  SCREEN_BARS,
} from '../../../strategy/dbPool';
import { canSeedMock, seedRefusalMessage, realSourceLabel } from './mockGuard';
import { runNodePull, amountCoverage } from './pullRunner';
import {
  bootstrapDefaultProviders,
  dailySourceHealth,
  describeLayers,
  describeProviders,
  setPreferred,
} from './providers/registry';

// better-sqlite3 是原生模块（.node）：必须运行时 require，禁止被 vite bundle 内联。
// createRequire 的调用在构建期是黑盒，rollup 不会尝试解析/打包它；
// 打包后从 asar 内 node_modules 加载（.node 由 asarUnpack 释放到 app.asar.unpacked）。
const nodeRequire = createRequire(__filename);
const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  market TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS daily (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL,
  volume REAL, amount REAL, preClose REAL,
  PRIMARY KEY (code, date)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS watchlist (
  code TEXT PRIMARY KEY,
  grp TEXT NOT NULL DEFAULT '观察',
  note TEXT NOT NULL DEFAULT '',
  cost_price REAL,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stock_count INTEGER NOT NULL DEFAULT 0,
  change_pct REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  leader_code TEXT NOT NULL DEFAULT '',
  leader_name TEXT NOT NULL DEFAULT '',
  leader_change_pct REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sector_members (
  sector_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (sector_id, code)
);
CREATE INDEX IF NOT EXISTS idx_daily_code ON daily(code);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily(date);
CREATE INDEX IF NOT EXISTS idx_watchlist_grp ON watchlist(grp);
CREATE INDEX IF NOT EXISTS idx_sector_members_code ON sector_members(code);
`;

// Python 脚本路径：dev 取项目根（app.getAppPath()）；
// 打包版起 extraResources 不再发布 python/，所以 resources/python 下会**不存在**这个脚本——
// UI 的「Python / baostock（实验）」因此要置灰，setEngine 也要当场拒绝，不能让用户点了才发现空跑。
const PY_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'python', 'baostock_fetcher.py')
  : path.join(app.getAppPath(), 'python', 'baostock_fetcher.py');

/** Python 桥脚本是否真的在位（打包版未发布 python/ → false） */
function pythonScriptReady(): boolean {
  try {
    return statSync(PY_SCRIPT).isFile();
  } catch {
    return false;
  }
}

const DB_PATH = () => path.join(app.getPath('userData'), 'quantpilot.db');

/** meta 里存放「上次选股结果」的键（v0.9.7 指纹缓存落盘用） */
const SCREEN_CACHE_META_KEY = 'screenCache';

/**
 * 选股池上限硬顶：对齐沪深 A 股全市场（约 5400 只）。
 * 单只取最近 SCREEN_BARS=320 根 → 5400×320 ≈ 173 万根，Worker 线程可扛，
 * 但选股耗时会从「几十秒」升到「数分钟」，故 computeService 超时同步放宽到 600s。
 * 想缩回小池子：meta.poolLimit 或环境变量 QUANTPILOT_POOL_LIMIT（0 = 用本硬顶）。
 */
const DEFAULT_UNIVERSE = 500;

type SqliteDatabase = import('better-sqlite3').Database;

let db: SqliteDatabase | null = null;

/**
 * 拉取任务并发锁：托盘连点多次、或「增量更新」和「全量回填」同时点，
 * 会 spawn 出两个 python 抢同一个 sqlite 写锁 —— 重复进入一律复用同一个任务。
 */
let pullTask: Promise<PullResult> | null = null;

/** 与 Python 抓取器争写锁时，最多再等这么久（ms）。两边都会设，WAL 下冲突不该超过这个量级 */
const BUSY_TIMEOUT_MS = 15_000;

function getDb(): SqliteDatabase {
  if (db) return db;
  db = new Database(DB_PATH());
  db.pragma('journal_mode = WAL');
  // 关键：Node 与 python/baostock_fetcher.py 会同时写同一个 quantpilot.db。
  // 没有 busy_timeout 时，抓取进行中做任何写操作会直接抛 `database is locked` 崩掉 UI。
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(SCHEMA);
  return db;
}

function isBusyError(e: unknown): boolean {
  return /sqlite.*(busy|locked)|database is (busy|locked)/i.test(String(e));
}

/**
 * meta 表是「显示用状态」，写失败不该炸掉调用链路。
 * 与 Python 抢写锁时记一条 warn 就降级，等抓取结束它会自己把 lastUpdate 写准。
 */
function setMeta(key: string, value: string): void {
  try {
    getDb().prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(key, value);
  } catch (e) {
    log.warn(`[dataService] meta.${key} 写入失败（多半是抓取器正持有写锁）：${String(e)}`);
  }
}

function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export interface PullResult {
  inserted: number;
  updated: number;
  error: string | null;
  /** 数据来源；判演示数据一律用 === 'mock'（换源后 'baostock' 不再是唯一真值） */
  source?: DataSourceId;
  /** 本次目标标的数 */
  codes?: number;
  /** 本次未取到数据的标的数 */
  failed?: number;
  /** 本次全市场名单总数（fill-missing/全量时 Python 返回，写 meta.universeSize） */
  universeSize?: number;
}

/** 当前选股池上限（0 = 不限制）；环境变量优先，其次 meta，最后默认值 */
function poolLimit(): number {
  const env = process.env.QUANTPILOT_POOL_LIMIT;
  if (env !== undefined && env !== '') return Math.max(0, Number(env) || 0);
  const m = getMeta('poolLimit');
  if (m !== null) return Math.max(0, Number(m) || 0);
  return DEFAULT_UNIVERSE;
}

/**
 * 已知口径偏差名单（meta.knownAdjustBias）。
 *
 * 名单是「事实记录」而不是「实时检测」：P4 靠 5% 阈值扫出 3 行、修完复验就归零了，
 * 之后再扫一个都扫不出来 —— 「过去踩过什么坑、坑长什么样」这件事只能靠名单留档。
 */
function readAdjustBias(): AdjustBiasEntry[] {
  const r = resolveAdjustBias(getMeta(ADJUST_BIAS_KEY), getMeta('dataSource'));
  if (r.error !== null) log.warn(`[dataService] ${r.error}，按空名单处理`);
  if (r.source === 'baseline') {
    log.info('[dataService] 已知口径偏差走内置基线（meta 未落档，且这是 baostock 存量库）');
  }
  return r.entries;
}

export const dataService = {
  /** 是否有拉取任务在跑（托盘菜单据此给「正在拉取…」提示，避免连点无反馈） */
  isPulling(): boolean {
    return pullTask !== null;
  },

  /** 数据库文件路径（供 Worker 直连 SQLite 用，Worker 不能 import electron 的 app） */
  dbPath(): string {
    return DB_PATH();
  },

  /** 当前生效的选股池上限（0 = 不限制，受硬顶约束）；供 Worker 选股时对齐范围 */
  poolLimit(): number {
    return poolLimit();
  },

  /** 涨停池扫描用只读句柄（strategy/limitup.ts 只需 prepare，不暴露完整 db） */
  limitUpScanDb(): Pick<SqliteDatabase, 'prepare'> {
    return getDb();
  },

  init(): void {
    getDb();
    log.info('[dataService] SQLite 已初始化:', DB_PATH());
    log.info(`[dataService] 选股池上限 ${poolLimit()}（0=不限，受硬顶 ${POOL_HARD_CAP} 约束）`);
    // 用户在设置页选过的源要跨重启生效：偏好存在 meta 里，这里回灌进 registry
    applyProviderPreference();
  },

  // ---- 选股结果缓存（v0.9.7）------------------------------------------------
  // 落 meta 而不是只放内存：主子要「重启软件也秒开上次结果」。
  // 代价是要防止「旧结果冒充新结果」——所以每条缓存都带 key / computedAt / dataDate，
  // 指纹对不上直接作废，UI 上也如实显示「结果基于 X 日数据」。
  saveScreenCache(entry: {
    key: string;
    signals: Signal[];
    computedAt: string;
    dataDate: string | null;
  }): void {
    setMeta(SCREEN_CACHE_META_KEY, JSON.stringify(entry));
  },

  readScreenCache(): {
    key: string;
    signals: Signal[];
    computedAt: string;
    dataDate: string | null;
  } | null {
    try {
      const raw = getMeta(SCREEN_CACHE_META_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof o?.key !== 'string' ||
        !Array.isArray(o.signals) ||
        typeof o?.computedAt !== 'string'
      ) {
        log.warn('[dataService] meta.screenCache 结构异常，按无缓存处理');
        return null;
      }
      return {
        key: o.key,
        signals: o.signals as Signal[],
        computedAt: o.computedAt,
        dataDate: typeof o.dataDate === 'string' ? o.dataDate : null,
      };
    } catch (e) {
      log.warn(`[dataService] meta.screenCache 读取失败：${String(e)}`);
      return null;
    }
  },

  clearScreenCache(): void {
    try {
      getDb().prepare('DELETE FROM meta WHERE key=?').run(SCREEN_CACHE_META_KEY);
    } catch (e) {
      log.warn(`[dataService] meta.${SCREEN_CACHE_META_KEY} 清除失败：${String(e)}`);
    }
  },

  /**
   * 数据源配置（设置页「数据源」区块的全部输入）：三层各自的候选/首选/可用性 + 熔断状态灯。
   * 日 K 层是**锁死**的（库里 369 万根是腾讯 qfq，换源会改写 37.54% 的行，见 §0.5），
   * 所以这里刻意不返回它的可选项，UI 侧按只读说明渲染。
   */
  async getSourceConfig(): Promise<SourceConfig> {
    bootstrapDefaultProviders();
    const coverage = getMeta('amountCoverage');
    const n = coverage === null ? NaN : Number(coverage);
    return {
      providers: describeProviders(),
      layers: describeLayers(),
      engine: pullEngine(),
      dailyLock: { provider: 'tencent', adjust: 'qfq' },
      /** 本机有没有 Python 解释器 */
      pythonAvailable: (await detectPython()).found !== null,
      /** Python 桥脚本是否随包在位（dev=true；v0.9.5 起的打包版=false，故 python 引擎不可用） */
      pythonScriptReady: pythonScriptReady(),
      amountCoverage: Number.isFinite(n) ? n : null,
      adjustBias: readAdjustBias(),
    };
  },

  /** 设置某一能力层的首选源；非法（源不支持该层）时返回 error，不静默吞掉 */
  setSourcePreference(cap: Capability, id: ProviderId): { ok: boolean; error: string | null } {
    try {
      setPreferred(cap, id);
      setMeta(`providerPref.${cap}`, id);
      log.info(`[dataService] ${cap} 层数据源切换为 ${id}（下次拉取生效；首选源熔断时自动回退次源）`);
      return { ok: true, error: null };
    } catch (e) {
      const msg = `该数据源不支持「${cap}」这一层：${String(e)}`;
      log.warn('[dataService]', msg);
      return { ok: false, error: msg };
    }
  },

  /** 当前拉取引擎（'node' 默认 / 'python' 实验） */
  getEngine(): 'node' | 'python' {
    return pullEngine();
  },

  /**
   * 切换拉取引擎；写 meta.pullEngine，立即对下一次拉取生效。
   * 'python' 是旧 baostock 双轨路径，仅在「解释器可用 **且** 桥脚本在位」时才放行——
   * 打包版没有随包发布 python/，这里必须拒，否则用户点了只会得到一个空跑的抓取。
   */
  async setEngine(engine: 'node' | 'python'): Promise<{ ok: boolean; error?: string }> {
    if (engine === 'python') {
      if (!pythonScriptReady()) {
        const msg = '本机没有可用的 Python 数据桥（脚本不存在）：请切回 Node 内置源';
        log.warn('[dataService]', msg);
        return { ok: false, error: msg };
      }
      if ((await detectPython()).found === null) {
        const msg = '本机未检测到 Python 解释器，无法启用 baostock 路径';
        log.warn('[dataService]', msg);
        return { ok: false, error: msg };
      }
    }
    setPullEngine(engine);
    return { ok: true };
  },

  /**
   * 拉取历史数据。
   * - force=false 增量：只续拉库内已有标的（快），不会新增标的；
   * - force=true 全量：以 universe 为目标集合重建（清掉非目标旧行）。
   */
  async pullHistory(req: {
    force?: boolean;
    universe?: number;
    lookbackYears?: number;
    /** v0.9.2：显式模式；缺省按 force 语义（true=full / false=incremental） */
    mode?: 'full' | 'incremental' | 'fill-missing';
  }): Promise<PullResult> {
    if (pullTask) {
      log.warn('[dataService] 已有数据拉取任务在进行中，本次点击复用它（不再 spawn 第二个抓取器）');
      return pullTask;
    }
    const task = (async (): Promise<PullResult> => {
      // universe=0 是合法值（= 全市场），不能靠 `||` 兜底，否则 0 会被换成默认值
      const universe = req.universe ?? (poolLimit() > 0 ? poolLimit() : DEFAULT_UNIVERSE);
      const mode = req.mode ?? (req.force ? 'full' : 'incremental');
      const lookbackYears = req.lookbackYears ?? Number(process.env.QUANTPILOT_LOOKBACK_YEARS ?? 3);

      // 【双轨开关】默认 Node 路径（零依赖，用户不需要装 Python / baostock）。
      // 只有 meta.pullEngine === 'python' 才走旧路径 —— baostock.com:10030 实测 TCP 5s 超时不可达
      // （docs/DATA_LAYER_MIGRATION.md §0.2），Python 路径已降级为「用户显式选择的实验项」，
      // 不再自动兜底，也不再是默认。
      if (pullEngine() === 'python') return runPythonPath(mode, universe, lookbackYears);
      return runNodePath(mode, universe, lookbackYears);
    })();
    pullTask = task;
    try {
      return await task;
    } finally {
      pullTask = null;
    }
  },

  getStatus(): {
    stockCount: number;
    poolCount: number;
    barCount: number;
    lastUpdate: string | null;
    dataSource: DataSourceId;
    barFrom: string | null;
    barTo: string | null;
    poolLimit: number;
    provider: ProviderId | null;
    adjust: 'qfq' | 'hfq' | 'none' | null;
    amountCoverage: number | null;
    engine: PullEngine;
    dailySource: ProviderId;
    dailyBreaker: 'closed' | 'open' | 'half-open';
    degraded: boolean;
  } {
    const d = getDb();
    const stockCount = (d.prepare('SELECT COUNT(*) c FROM stocks').get() as { c: number }).c;
    const poolCount = (
      d.prepare('SELECT COUNT(DISTINCT code) c FROM daily').get() as { c: number }
    ).c;
    const barCount = (d.prepare('SELECT COUNT(*) c FROM daily').get() as { c: number }).c;
    const lastUpdate = getMeta('lastUpdate');
    const dataSource = (getMeta('dataSource') as DataSourceId | null) ?? 'mock';
    const range = d.prepare('SELECT MIN(date) f, MAX(date) t FROM daily').get() as
      | { f: string | null; t: string | null }
      | undefined;
    const cov = getMeta('amountCoverage');
    const covN = cov === null ? NaN : Number(cov);
    // M6：日 K 源健康快照（锁死腾讯 qfq、无兜底，熔断=停摆）
    const daily = dailySourceHealth();
    return {
      stockCount,
      poolCount,
      barCount,
      lastUpdate,
      dataSource,
      barFrom: range?.f ?? null,
      barTo: range?.t ?? null,
      poolLimit: poolLimit(),
      provider: (getMeta('provider') as ProviderId | null) ?? null,
      adjust: (getMeta('adjust') as 'qfq' | 'hfq' | 'none' | null) ?? null,
      amountCoverage: Number.isFinite(covN) ? covN : null,
      engine: pullEngine(),
      dailySource: daily.provider,
      dailyBreaker: daily.breaker,
      degraded: daily.breaker !== 'closed',
    };
  },

  /** 数据健康（v0.9.2）：本地标的覆盖度——universeSize 为 null 表示尚未跑过全市场口径回填 */
  getHealth(): { stocksCount: number; universeSize: number | null; lastUpdate: string | null } {
    const d = getDb();
    const stocksCount = (d.prepare('SELECT COUNT(*) c FROM stocks').get() as { c: number }).c;
    const raw = getMeta('universeSize');
    const n = raw === null ? NaN : Number(raw);
    return {
      stocksCount,
      universeSize: Number.isFinite(n) && n > 0 ? n : null,
      lastUpdate: getMeta('lastUpdate'),
    };
  },

  /**
   * A 股行情：库内已有标的的最新一根 K 线（单次 JOIN 查询，不逐只回捞）
   */
  getMarketList(): MarketRow[] {
    const d = getDb();
    const rows = d
      .prepare(
        `SELECT s.code AS code, s.name AS name, s.industry AS industry, s.market AS market,
                d.date AS date, d.close AS close, d.preClose AS preClose,
                d.volume AS volume, d.amount AS amount,
                t.bars AS bars, t.barFrom AS barFrom, t.barTo AS barTo
           FROM stocks s
           JOIN (SELECT code, COUNT(*) AS bars, MIN(date) AS barFrom, MAX(date) AS barTo
                   FROM daily GROUP BY code) t ON t.code = s.code
           JOIN daily d ON d.code = s.code AND d.date = t.barTo
          ORDER BY s.code`,
      )
      .all() as (Omit<MarketRow, 'change' | 'changePct'> & {
      close: number;
      preClose: number;
    })[];
    return rows.map((r) => {
      const pre = Number(r.preClose) || 0;
      const close = Number(r.close) || 0;
      return {
        ...r,
        close,
        preClose: pre,
        change: +(close - pre).toFixed(2),
        changePct: pre > 0 ? +(((close - pre) / pre) * 100).toFixed(2) : 0,
      };
    });
  },

  /**
   * 选股池：只取每只最近 SCREEN_BARS 根 K 线。改用单条批量 SQL（窗口式流式取），
   * 不再 5400 次逐只 SELECT（审计 PID-07）。Worker 直连 SQLite 时主进程根本不调用它，
   * 仅作 Worker 不可用时的兜底计算路径。
   */
  getScreeningPool(opts?: { limit?: number; recentBars?: number }): StockSeries[] {
    return loadScreeningPool(getDb(), opts?.limit ?? poolLimit(), opts?.recentBars ?? SCREEN_BARS);
  },

  /** 全量历史池（回测用）：每只返回完整 K 线。同样走批量 SQL（PID-07）。 */
  getPool(limit?: number): StockSeries[] {
    return loadBacktestPool(getDb(), limit ?? poolLimit());
  },

  // -------------------------------------------------------------------------
  // 自选股（M4）
  // -------------------------------------------------------------------------

  /**
   * 自选股列表：JOIN 库内最新一根 K 线，带浮动盈亏。
   *
   * 盈亏只给**比例**（pnlPct）不给金额：成本 × 数量 = 本金，股数是用户的持仓信息，
   * 本软件不连券商、也没有股数概念，编个金额出来只会是假精确。
   */
  listWatchlist(): WatchlistRow[] {
    const d = getDb();
    const rows = d
      .prepare(
        `SELECT w.code AS code, s.name AS name, s.industry AS industry,
                w.grp AS grp, w.note AS note, w.cost_price AS costPrice, w.added_at AS addedAt,
                d.date AS date, d.close AS close, d.preClose AS preClose
           FROM watchlist w
           LEFT JOIN stocks s ON s.code = w.code
           LEFT JOIN (SELECT code, MAX(date) AS barTo FROM daily GROUP BY code) t ON t.code = w.code
           LEFT JOIN daily d ON d.code = w.code AND d.date = t.barTo
          ORDER BY w.grp, w.code`,
      )
      .all() as {
      code: string;
      name: string | null;
      industry: string | null;
      grp: string;
      note: string;
      costPrice: number | null;
      addedAt: string;
      date: string | null;
      close: number | null;
      preClose: number | null;
    }[];
    return rows.map((r) => {
      const close = r.close === null ? null : Number(r.close);
      const pre = r.preClose === null ? null : Number(r.preClose);
      const cost = r.costPrice === null ? null : Number(r.costPrice);
      return {
        code: r.code,
        name: r.name ?? '',
        industry: r.industry ?? '',
        group: r.grp,
        note: r.note ?? '',
        addedAt: r.addedAt,
        costPrice: cost,
        date: r.date,
        close,
        preClose: pre,
        changePct: close !== null && pre !== null && pre > 0 ? +(((close - pre) / pre) * 100).toFixed(2) : null,
        pnlPct: close !== null && cost !== null && cost > 0 ? +(((close - cost) / cost) * 100).toFixed(2) : null,
        hit: null, // 信号命中断言由渲染层用当前选股结果联查（主进程不持有选股态）
      };
    });
  },

  /** 按 code upsert 自选股（新增或更新分组/备注/成本价） */
  upsertWatch(input: WatchUpsert): { ok: boolean; error?: string | null } {
    const code = (input.code ?? '').trim();
    if (code === '') return { ok: false, error: 'code 不能为空' };
    const d = getDb();
    const grp = (input.group ?? '观察').trim() || '观察';
    const note = (input.note ?? '').trim();
    const cost =
      input.costPrice === null || input.costPrice === undefined
        ? null
        : Number.isFinite(Number(input.costPrice)) && Number(input.costPrice) > 0
          ? Number(input.costPrice)
          : null;
    d.prepare(
      `INSERT INTO watchlist(code, grp, note, cost_price, added_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET grp=excluded.grp, note=excluded.note, cost_price=excluded.cost_price`,
    ).run(code, grp, note, cost, new Date().toISOString());
    return { ok: true };
  },

  removeWatch(code: string): { ok: boolean } {
    getDb().prepare('DELETE FROM watchlist WHERE code = ?').run(code);
    return { ok: true };
  },

  hasWatch(code: string): boolean {
    const row = getDb().prepare('SELECT 1 AS x FROM watchlist WHERE code = ?').get(code) as
      | { x: number }
      | undefined;
    return row !== undefined;
  },

  /** 自选股 code 列表（供「仅扫自选池」把范围传给 Worker） */
  watchlistCodes(): string[] {
    return (getDb().prepare('SELECT code FROM watchlist ORDER BY code').all() as { code: string }[]).map(
      (r) => r.code,
    );
  },

  /**
   * 自选池取 K 线：给「仅对自选池选股」用。
   * 只对自选 code 取（每只最近 recentBars 根，升序），空表返回空数组。
   */
  getWatchlistPool(recentBars: number): StockSeries[] {
    const codes = this.watchlistCodes();
    if (codes.length === 0) return [];
    const d = getDb();
    const out: StockSeries[] = [];
    const barStmt = d.prepare(
      `SELECT date,open,high,low,close,volume,amount,preClose
         FROM daily WHERE code=? ORDER BY date DESC LIMIT ?`,
    );
    const metaStmt = d.prepare('SELECT code,name,industry,market FROM stocks WHERE code=?');
    for (const code of codes) {
      const meta = metaStmt.get(code) as StockMeta | undefined;
      if (!meta) continue; // 自选里有库里没行情的票（没回填到）→ 跳过，不塞空 meta 污染信号
      const bars = barStmt.all(code, recentBars) as DailyBar[];
      if (bars.length === 0) continue;
      // DESC 查出来 → 反转成升序（策略要求 bars 升序）
      out.push({ meta, bars: bars.slice().reverse() });
    }
    return out;
  },

  // -------------------------------------------------------------------------
  // 板块 / 行业（M2）
  // -------------------------------------------------------------------------

  /** 全量替换板块列表（刷新时 upsert，删除源里已消失的板块） */
  replaceSectors(sectors: import('./providers/types').SectorItem[]): void {
    const d = getDb();
    const now = new Date().toISOString();
    const up = d.prepare(
      `INSERT INTO sectors(id,name,stock_count,change_pct,amount,leader_code,leader_name,leader_change_pct,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, stock_count=excluded.stock_count,
         change_pct=excluded.change_pct, amount=excluded.amount, leader_code=excluded.leader_code,
         leader_name=excluded.leader_name, leader_change_pct=excluded.leader_change_pct, updated_at=excluded.updated_at`,
    );
    const del = d.prepare('DELETE FROM sectors WHERE id = ?');
    const keep: string[] = [];
    for (const s of sectors) {
      up.run(s.id, s.name, s.stockCount, s.changePct, s.amount, s.leaderCode, s.leaderName, s.leaderChangePct, now);
      keep.push(s.id);
    }
    // 清理源里已消失的板块（否则板块页会一直显示幽灵板块）
    const all = d.prepare('SELECT id FROM sectors').all() as { id: string }[];
    for (const row of all) if (!keep.includes(row.id)) del.run(row.id);
  },

  /** 全量替换某板块成分股；返回写入条数 */
  replaceSectorMembers(sectorId: string, members: import('./providers/types').UniverseItem[]): number {
    const d = getDb();
    d.prepare('DELETE FROM sector_members WHERE sector_id = ?').run(sectorId);
    const ins = d.prepare(
      'INSERT OR REPLACE INTO sector_members(sector_id,code,name) VALUES(?,?,?)',
    );
    let n = 0;
    for (const m of members) {
      ins.run(sectorId, m.code, m.name);
      n++;
    }
    return n;
  },

  /** 板块列表（memberCount = 库内有行情的成分数，LEFT JOIN daily 统计） */
  listSectors(sort: 'changePct' | 'amount' = 'changePct'): SectorRow[] {
    const d = getDb();
    const orderBy = sort === 'amount' ? 's.amount DESC' : 's.change_pct DESC';
    const rows = d
      .prepare(
        `SELECT s.id AS id, s.name AS name, s.stock_count AS stockCount, s.change_pct AS changePct,
                s.amount AS amount, s.leader_code AS leaderCode, s.leader_name AS leaderName,
                s.leader_change_pct AS leaderChangePct, s.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM sector_members m
                   WHERE m.sector_id = s.id
                     AND m.code IN (SELECT DISTINCT code FROM daily)) AS memberCount
           FROM sectors s ORDER BY ${orderBy}`,
      )
      .all() as SectorRow[];
    return rows;
  },

  /** 某板块成分股 + 库内最新行情（库外成分 inLibrary=false） */
  listSectorMembers(sectorId: string): (SectorMemberRow & { hit?: boolean | null })[] {
    const d = getDb();
    const rows = d
      .prepare(
        `SELECT m.code AS code, m.name AS name,
                d.close AS close, d.preClose AS preClose,
                (d.code IS NOT NULL) AS inLibrary
           FROM sector_members m
           LEFT JOIN (SELECT code, MAX(date) AS barTo FROM daily GROUP BY code) t ON t.code = m.code
           LEFT JOIN daily d ON d.code = m.code AND d.date = t.barTo
          WHERE m.sector_id = ?
          ORDER BY inLibrary DESC, (d.close / d.preClose - 1) DESC NULLS LAST, m.code`,
      )
      .all(sectorId) as {
      code: string; name: string; close: number | null; preClose: number | null; inLibrary: number;
    }[];
    return rows.map((r) => {
      const close = r.close === null ? null : Number(r.close);
      const pre = r.preClose === null ? null : Number(r.preClose);
      return {
        code: r.code,
        name: r.name,
        inLibrary: Number(r.inLibrary) === 1,
        close,
        changePct: close !== null && pre !== null && pre > 0 ? +(((close - pre) / pre) * 100).toFixed(2) : null,
        hit: null,
      };
    });
  },

  /** 个股所属板块 id（给评分 sector 因子用；一只票可能属多板块，取第一个） */
  sectorIdOfStock(code: string): string | null {
    const row = getDb().prepare('SELECT sector_id FROM sector_members WHERE code = ? LIMIT 1').get(code) as
      | { sector_id: string }
      | undefined;
    return row?.sector_id ?? null;
  },

  getSeries(code: string): StockSeries | null {
    const d = getDb();
    const meta = d
      .prepare('SELECT code,name,industry,market FROM stocks WHERE code=?')
      .get(code) as StockMeta | undefined;
    if (!meta) return null;
    const bars = d
      .prepare('SELECT date,open,high,low,close,volume,amount,preClose FROM daily WHERE code=? ORDER BY date ASC')
      .all(code) as DailyBar[];
    return { meta, bars };
  },
};

// ---------------------------------------------------------------------------
// Python 桥接：baostock 仅在 Python 可用时启用
//
// ⚠️ 两条血泪教训（2026-10-01 实测）：
// 1) **不能用裸命令 `python` 判断是否装了 baostock**。本机 PATH 里第一个 python
//    往往是没装 baostock 的解释器（WorkBuddy 受管 Python / msys64），
//    而用户 `pip install baostock` 装的是另一个（如 D:\python310）。
//    只测裸命令 → 误判「未安装」→ 静默回退 mock，用户以为全量回填失败。
// 2) **必须用异步 exec，不能用 spawnSync**。同步版本在受限环境会直接
//    `spawnSync cmd.exe EBUSY`，导致所有探测静默失败。异步 exec 稳定可用。
// ---------------------------------------------------------------------------

/** 执行命令，返回 { ok, stdout }。
 * ⚠️ ok 必须依据**退出码**判定，不能用「输出是否为空」——
 * 解释器不存在/import 失败时 stdout 同样为空，会被误判为成功（曾导致
 * 明明没装 baostock 的 anaconda 被当成可用解释器）。
 */
function execCapture(
  cmd: string,
  timeoutMs = 6000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      exec(
        cmd,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            stdout: `${stdout ?? ''}${stderr ?? ''}`,
          });
        },
      );
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

/** 生成候选 Python 解释器路径（按优先级）。
 * 穷举：环境变量 → py launcher 注册表 → where 枚举 PATH → 常见安装位置。
 */
async function pythonCandidates(): Promise<string[]> {
  const out: string[] = [];
  const push = (v?: string | null): void => {
    if (v && !out.includes(v)) out.push(v);
  };

  // 1) 用户显式指定优先
  push(process.env.QUANTPILOT_PYTHON);

  // 2) py launcher：列出所有已注册版本（最可靠，绕开 PATH 顺序）
  const pyList = await execCapture('py -0p');
  for (const line of pyList.stdout.split(/\r?\n/)) {
    const m = line.match(/([A-Za-z]:\\[^\s]+python\.exe)/i);
    if (m) push(m[1]);
  }

  // 3) where 枚举 PATH 中全部 python（含被遮蔽的）
  for (const name of ['python.exe', 'python3.exe']) {
    const w = await execCapture(`where ${name}`);
    for (const line of w.stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (t && /python[\d.]*\.exe$/i.test(t)) push(t);
    }
  }

  // 4) 裸命令兜底（若上面都没结果，至少还能试 PATH 首个）
  push('python');
  push('python3');

  // 5) 常见安装位置兜底
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const localApp = process.env.LOCALAPPDATA ?? '';
  const progFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  for (const base of [
    'C:\\python313', 'C:\\python312', 'C:\\python311', 'C:\\python310',
    'D:\\python313', 'D:\\python312', 'D:\\python311', 'D:\\python310',
    'E:\\python313', 'E:\\python312', 'E:\\python311', 'E:\\python310',
    'C:\\Python313', 'C:\\Python312', 'C:\\Python311', 'C:\\Python310',
    'D:\\anaconda3', 'C:\\anaconda3', 'D:\\miniconda3', 'C:\\miniconda3',
    path.join(progFiles, 'Python313'), path.join(progFiles, 'Python312'),
    path.join(progFiles, 'Python311'), path.join(progFiles, 'Python310'),
    path.join(home, 'anaconda3'), path.join(home, 'miniconda3'),
    path.join(localApp, 'Programs', 'Python', 'Python313'),
    path.join(localApp, 'Programs', 'Python', 'Python312'),
    path.join(localApp, 'Programs', 'Python', 'Python311'),
    path.join(localApp, 'Programs', 'Python', 'Python310'),
  ].filter(Boolean)) {
    push(path.join(base, 'python.exe'));
  }

  return out;
}

/** 测试单个解释器能否 import baostock（依据退出码，异步 exec） */
async function probeBaostock(cmd: string): Promise<boolean> {
  const q = /\s/.test(cmd) ? `"${cmd}"` : cmd;
  const r = await execCapture(`${q} -c "import baostock"`, 8000);
  return r.ok; // exec 无 err（退出码 0）才算真的 import 成功
}

let cachedPython: string | null | undefined;
let detectLog: string[] = [];

/**
 * 查找**能 import baostock** 的 Python 解释器（结果缓存，避免每次拉取都全量探测）。
 * 返回 null 表示系统内确实没有可用的 baostock 环境。
 */
async function findPython(): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython;
  const cands = await pythonCandidates();
  const tried: string[] = [];
  log.info(`[dataService] 探测 ${cands.length} 个 Python 候选解释器…`);
  for (const cmd of cands) {
    tried.push(cmd);
    if (await probeBaostock(cmd)) {
      log.info(`[dataService] ✅ 命中可用 baostock 解释器: ${cmd}（第 ${tried.length} 个候选）`);
      detectLog = tried;
      cachedPython = cmd;
      return cmd;
    }
  }
  detectLog = tried;
  log.warn(`[dataService] ${cands.length} 个候选均无 baostock，回退内置演示数据`);
  cachedPython = null;
  return null;
}

/** 供设置页/诊断用：返回当前探测结果、候选清单与实际尝试过的路径 */
export async function detectPython(): Promise<{
  found: string | null;
  candidates: string[];
  tried: string[];
}> {
  const found = await findPython();
  return { found, candidates: await pythonCandidates(), tried: detectLog };
}

/** 单向推送抓取进度（没有窗口时静默忽略） */
function emitProgress(p: PullProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC_EVENT.PULL_PROGRESS, p);
  }
}

/**
 * 当前生效的拉取引擎（双轨开关）。
 * - 'node'（默认）：纯 Node Provider，零依赖、不需要用户装 Python/baostock；
 * - 'python'：旧 baostock 路径，仅当用户显式选择时才走（实验项）。
 * 开关存 meta.pullEngine，UI 在 P4/P5 提供；读不到一律按 node（向后兼容老库）。
 */
function pullEngine(): 'node' | 'python' {
  return getMeta('pullEngine') === 'python' ? 'python' : 'node';
}

/** 设置拉取引擎（供设置页 UI 调用） */
export function setPullEngine(engine: 'node' | 'python'): void {
  setMeta('pullEngine', engine);
  log.info(`[dataService] 拉取引擎已切换为 ${engine}`);
}

/**
 * 把 meta.providerPref.* 回灌进 registry（P4）。
 * 偏好存 meta 而不是主进程全局变量：用户换机器 / 清缓存重装后，选择仍然在库里。
 * 单条失效（例如给名单层存了个 tdx）只丢这一条，不影响其它层。
 */
function applyProviderPreference(): void {
  bootstrapDefaultProviders();
  const caps: Capability[] = ['universe', 'snapshot', 'dailyBars'];
  for (const cap of caps) {
    const raw = getMeta(`providerPref.${cap}`);
    if (raw === null) continue;
    try {
      setPreferred(cap, raw as ProviderId);
    } catch (e) {
      log.warn(`[dataService] 忽略失效的数据源偏好 providerPref.${cap}=${raw}：${String(e)}`);
    }
  }
}

/**
 * 【Python/baostock 旧路径】用户显式选择才走。
 * 保留全部原有 R1 守卫：真库上一律不回退 mock（seedMockData 是 DELETE FROM daily 全量重灌）。
 */
async function runPythonPath(
  mode: 'full' | 'incremental' | 'fill-missing',
  universe: number,
  lookbackYears: number,
): Promise<PullResult> {
  const python = await findPython();

  // 【R1 守卫】seedMockData() 会清空整张 daily，在真实行情库上跑一次 369 万根当场消失。
  // 判据看库里实打实的行数（见 services/mockGuard.ts），而不是 meta.dataSource ——
  // 后者会被写入层改写，换源 / 降级 / 改 schema 都会让它失效。
  const gate0 = canSeedMock(barCountNow(), getMeta('dataSource') as string | null);
  if (!gate0.allowed) {
    log.warn(`[dataService] 拒绝写入演示数据：${gate0.reason}`);
    if (!python) {
      // 真库在、数据源又拉不到 → 保留原数据 + 明确回传原因，别让用户空等一轮还以为软件坏了
      return {
        inserted: 0,
        updated: 0,
        error: seedRefusalMessage(gate0),
        source: realSourceLabel(getMeta('dataSource') as string | null),
      };
    }
    log.warn('[dataService] 演示数据被拒，转由 Python/baostock 路径继续');
  }

  if (python) {
    const res = await runPython(python, { mode, universe, lookbackYears });
    // 只要脚本成功执行（无 error）就采信其结果——即使 inserted=0（数据已最新）
    // 也不要回退 mock，否则会把真实行情库覆盖成演示数据。
    if (!res.error) {
      // 选股池跟随本次选择的范围；fill-missing 是「补名单」不是「改范围」，不动 poolLimit
      if (mode !== 'fill-missing') setMeta('poolLimit', String(universe));
      return { ...res, source: 'baostock' };
    }
    log.warn('[dataService] baostock 拉取失败:', res.error);

    const gate1 = canSeedMock(barCountNow(), getMeta('dataSource') as string | null);
    if (!gate1.allowed) {
      log.warn('[dataService] 保留本地已有的真实行情数据，不覆盖为演示数据');
      return {
        inserted: 0,
        updated: 0,
        error: seedRefusalMessage(gate1, res.error),
        source: realSourceLabel(getMeta('dataSource') as string | null),
      };
    }
    log.warn('[dataService] 本地无真实数据，回退内置演示数据以保证应用可用');
    return { ...seedMockData(), source: 'mock', error: res.error };
  }

  // 用户显式选了 Python 却没装 → 报明确原因，不要偷偷灌演示数据
  const msg =
    '已选择 Python/baostock 数据源，但本机未检测到可用的 Python + baostock 环境。' +
    '请在「设置 → 数据源」切回「Node 内置源（推荐）」，或自行安装 Python 与 baostock 后重试。';
  log.warn('[dataService]', msg);
  const gate = canSeedMock(barCountNow(), getMeta('dataSource') as string | null);
  if (!gate.allowed) {
    return {
      inserted: 0,
      updated: 0,
      error: msg,
      source: realSourceLabel(getMeta('dataSource') as string | null),
    };
  }
  return { ...seedMockData(), source: 'mock', error: msg };
}

/**
 * 【Node Provider 路径】默认引擎。
 * 三条来自 P2 实测的硬约束（见 docs/DATA_LAYER_MIGRATION.md §0.5）：
 *  ① 只续拉不重灌 —— 换源会改写 37.54% 的行，故 `date < 库内最后一根` 一律跳过；
 *  ② amount 换源后无源（腾讯 K 线只有 6 字段），只补当日、历史留 0，由 meta.amountCoverage 如实暴露；
 *  ③ 拿不到 qfq 的票（实测约 2%）跳过并保留库内原数据，绝不擦除；
 *     注：早期归因「近期大比例除权股专属」已由 2026-10-06 实测证伪（qfqday 一直在），名单见 meta.knownAdjustBias。
 */
async function runNodePath(
  mode: 'full' | 'incremental' | 'fill-missing',
  universe: number,
  lookbackYears: number,
): Promise<PullResult> {
  bootstrapDefaultProviders(); // 幂等：重复注册同 id 会被忽略

  // 244 个交易日/年；腾讯 fqkline 单次上限约 800 根，clamp 防越界
  const years = Math.min(10, Math.max(1, lookbackYears || 3));
  const barsPerCode = Math.min(800, Math.max(60, Math.round(years * 244)));
  const before = barCountNow();

  const stats = await runNodePull(
    {
      db: getDb(),
      onProgress: emitProgress,
      log: (level, msg): void => {
        if (level === 'error') log.error('[pullRunner]', msg);
        else if (level === 'warn') log.warn('[pullRunner]', msg);
        else log.info('[pullRunner]', msg);
      },
    },
    {
      mode,
      universe,
      barsPerCode,
      concurrency: Number(process.env.QUANTPILOT_PULL_CONCURRENCY ?? 5) || 5,
      adjust: 'qfq', // 与存量库口径一致；改这个会污染 369 万根
    },
  );

  // 只 INSERT/UPDATE，行数不该下降；真下降说明写入层出 bug，必须留痕
  const after = barCountNow();
  if (after < before) {
    log.error(`[dataService] K 线总数从 ${before} 降到 ${after}，写入层异常！`);
  }

  const total = stats.codes;
  const usable = total - stats.failed - stats.noAdjust;
  const allFailed = total > 0 && usable <= 0;
  // meta.dataSource 写实际命中的源（通常是 tencent），前端 `isMock` 判据是 === 'mock'，不受影响
  const source: DataSourceId = (stats.providers[0] as DataSourceId | undefined) ?? 'tencent';

  if (!allFailed) {
    setMeta('lastUpdate', new Date().toISOString());
    setMeta('dataSource', source);
    setMeta('provider', source);
    setMeta('adjust', 'qfq');
    if (mode !== 'fill-missing') setMeta('poolLimit', String(universe));
    if (stats.universeSize !== null) setMeta('universeSize', String(stats.universeSize));
    // 成交额覆盖率如实落库：换源后新行 amount=0，这个数会缓慢下降，前端可据此提示
    setMeta('amountCoverage', amountCoverage(getDb()).toFixed(4));
  }

  const error = allFailed
    ? `全部 ${total} 只标的拉取失败${stats.failures[0] ? `（${stats.failures[0]}）` : ''}`
    : null;
  return {
    inserted: stats.inserted,
    updated: stats.updated,
    error,
    source,
    codes: total,
    failed: stats.failed + stats.noAdjust,
    universeSize: stats.universeSize ?? undefined,
  };
}

function runPython(
  cmd: string,
  opts: { mode: 'full' | 'incremental' | 'fill-missing'; universe: number; lookbackYears: number },
): Promise<PullResult> {
  return new Promise<PullResult>((resolve) => {
    const modeArgs =
      opts.mode === 'fill-missing'
        ? // 补拉缺失标的（v0.9.2）：Python 侧目标 = universe − 库内已有，不清理
          ['--fill-missing']
        : [
            opts.mode === 'full' ? '--full' : '--incremental',
            // 增量模式语义 = 只更新库内已有标的（加 --local-only，不受 --limit 截断）
            // 全量：universe=0 → `--limit 0`，Python 侧 0=不截断，直接走全市场标的集合。
            ...(opts.mode === 'full' ? ['--limit', String(opts.universe)] : ['--local-only']),
          ];
    const args = [
      PY_SCRIPT,
      '--db', DB_PATH(),
      ...modeArgs,
      '--lookback-years', String(opts.lookbackYears),
    ];
    log.info(`[dataService] 启动 baostock 抓取：${cmd} ${args.slice(1).join(' ')}`);
    emitProgress({
      phase: 'code-list',
      done: 0,
      total: 0,
      bars: 0,
      message:
        opts.mode === 'fill-missing'
          ? '正在对照全市场名单，补拉缺失标的…'
          : opts.mode === 'full'
            ? '正在获取股票列表并清理旧数据…'
            : '正在续拉库内已有标的…',
    });
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let lastProgress = '';
    // 看门狗：baostock 服务端繁忙时 query_history_k_data_plus 会**长时间静默挂起**。
    // 用「空闲超时」而非「总超时」——只要还在出 progress 就说明在推进，
    // 但连续 IDLE_MS 无任何输出就判定卡死并终止，避免用户干等 20 分钟。
    const IDLE_MS = Number(process.env.QUANTPILOT_IDLE_TIMEOUT_MS ?? 180_000);
    let killTimer: NodeJS.Timeout;
    let killedByIdle = false;
    const armWatchdog = (): void => {
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        killedByIdle = true;
        log.error(
          `[baostock] 连续 ${Math.round(IDLE_MS / 1000)}s 无进度输出，判定服务端无响应，终止抓取`,
        );
        p.kill();
      }, IDLE_MS);
    };
    armWatchdog();
    p.stdout.on('data', (b) => {
      out += b.toString();
      armWatchdog();
    });
    p.stderr.on('data', (b) => {
      const chunk = b.toString();
      armWatchdog();
      for (const raw of chunk.split(/\r?\n/)) {
        const s = raw.trim();
        if (!s) continue;
        const m = s.match(/progress\s+(\d+)\/(\d+)/);
        if (m) {
          const bars = Number(s.match(/bars=(\d+)/)?.[1] ?? 0);
          lastProgress = `${m[1]}/${m[2]}`;
          emitProgress({
            phase: 'fetch',
            done: Number(m[1]),
            total: Number(m[2]),
            bars,
            message: s,
          });
          log.info('[baostock]', s);
        } else if (s.startsWith('info:') || s.includes('info:')) {
          emitProgress({ phase: 'code-list', done: 0, total: 0, bars: 0, message: s });
          log.info('[baostock]', s);
        } else {
          log.warn('[baostock]', s);
        }
      }
    });
    p.on('close', (code) => {
      clearTimeout(killTimer);
      try {
        const line = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('{'))
          .pop();
        const r = line ? (JSON.parse(line) as Record<string, unknown>) : {};
        // 脚本自身报错（如 baostock 未安装 / 登录失败）以 JSON error 字段返回，
        // 此时退出码仍可能是 0 —— 必须优先采纳 error，否则会被误判为成功。
        if (typeof r.error === 'string' && r.error) {
          emitProgress({ phase: 'error', done: 0, total: 0, bars: 0, message: r.error });
          resolve({ inserted: 0, updated: 0, error: r.error });
          return;
        }
        if (code !== 0) {
          const msg = killedByIdle
            ? `baostock 服务端无响应（连续 ${Math.round(IDLE_MS / 1000)} 秒无数据返回），已中止。请稍后重试，或改用增量更新`
            : `Python 退出码 ${code}`;
          emitProgress({ phase: 'error', done: 0, total: 0, bars: 0, message: msg });
          resolve({ inserted: 0, updated: 0, error: msg });
          return;
        }
        if (!line) {
          const msg = `Python 无输出（脚本可能启动失败）${lastProgress ? `，最后进度 ${lastProgress}` : ''}`;
          emitProgress({ phase: 'error', done: 0, total: 0, bars: 0, message: msg });
          resolve({ inserted: 0, updated: 0, error: msg });
          return;
        }
        // 只有真正写入成功才标记 lastUpdate / dataSource
        setMeta('lastUpdate', new Date().toISOString());
        setMeta('dataSource', 'baostock');
        const inserted = Number(r.inserted ?? 0);
        const updated = Number(r.updated ?? 0);
        const codes = Number(r.codes ?? 0);
        const failed = Number(r.failed ?? 0);
        const universeSize = Number(r.universeSize ?? 0);
        if (universeSize > 0) setMeta('universeSize', String(universeSize));
        emitProgress({
          phase: 'done',
          done: codes,
          total: codes,
          bars: inserted,
          message: `完成 · 目标 ${codes} 只 / 新增 ${inserted} 根 / 更新 ${updated} 根${
            failed > 0 ? ` / ${failed} 只未取到` : ''
          }`,
        });
        resolve({ inserted, updated, error: null, codes, failed, universeSize });
      } catch (e) {
        const msg = `Python 输出解析失败：${String(e)}`;
        emitProgress({ phase: 'error', done: 0, total: 0, bars: 0, message: msg });
        resolve({ inserted: 0, updated: 0, error: msg });
      }
    });
    p.on('error', (e) => resolve({ inserted: 0, updated: 0, error: String(e) }));
  });
}

// ---------------------------------------------------------------------------
// Mock 兜底：生成演示数据写入 SQLite
// ---------------------------------------------------------------------------

/**
 * 库内 K 线总行数。
 * 【R1】这是 mock 守卫生效的权威判据来源：`meta.dataSource` 是**会被写入层改写的可变状态**
 * （换源、降级、改 schema 都会动它），而 daily 表的行数不会。宁可多付一次 COUNT(*)。
 */
function barCountNow(): number {
  const row = getDb().prepare('SELECT COUNT(*) c FROM daily').get() as { c: number };
  return row.c;
}

function seedMockData(): PullResult {
  // 【R1 二次闸】即使调用方绕过了 pullHistory 的守卫，也不允许在真库上跑全量重灌。
  // 这里的判据同样只看行数 —— meta.dataSource 换源后会过期，行数不会。
  const gate = canSeedMock(barCountNow(), getMeta('dataSource') as string | null);
  if (!gate.allowed) {
    log.warn(`[dataService] seedMockData 被守卫拦截：${gate.reason}`);
    return { inserted: 0, updated: 0, error: seedRefusalMessage(gate), codes: 0 };
  }
  const d = getDb();
  const pool = generateMockPool();
  const insStock = d.prepare(
    'INSERT OR REPLACE INTO stocks(code,name,industry,market) VALUES(@code,@name,@industry,@market)',
  );
  const insBar = d.prepare(
    `INSERT OR REPLACE INTO daily(code,date,open,high,low,close,volume,amount,preClose)
     VALUES(@code,@date,@open,@high,@low,@close,@volume,@amount,@preClose)`,
  );
  const tx = d.transaction(() => {
    // mock 是全量重灌：先清空，避免日期平移后旧日期行残留成脏 K 线
    // （INSERT OR REPLACE 以 (code,date) 为键，旧日期不会被覆盖）
    d.prepare('DELETE FROM daily').run();
    let inserted = 0;
    for (const s of pool) {
      insStock.run(s.meta);
      for (const b of s.bars) {
        insBar.run({ code: s.meta.code, ...b });
        inserted++;
      }
    }
    return inserted;
  });
  let inserted = 0;
  try {
    inserted = tx();
  } catch (e) {
    // 与 Python 抓取器抢写锁时，宁可明确报失败让用户稍后再试，
    // 也不要留下一半删一半写的脏 K 线（DELETE 已生效、INSERT 还没跑完）。
    const msg = isBusyError(e)
      ? '数据库正被数据抓取任务占用，请等回填完成后重试'
      : `写入演示数据失败：${String(e)}`;
    log.warn(`[dataService] ${msg}`);
    return { inserted: 0, updated: 0, error: msg, codes: 0 };
  }
  setMeta('lastUpdate', new Date().toISOString());
  setMeta('dataSource', 'mock');
  log.info(`[dataService] mock 数据已写入 ${pool.length} 只 / ${inserted} 根K线`);
  return { inserted, updated: 0, error: null, codes: pool.length };
}
