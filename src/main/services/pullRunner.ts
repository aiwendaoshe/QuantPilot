/**
 * Node 侧数据拉取编排器 —— 替代 python/baostock_fetcher.py 的写入路径（P3）。
 *
 * 设计前提（三条硬约束，来自 P2 对拍实测，改动前先看 docs/DATA_LAYER_MIGRATION.md §0.5）：
 *
 * ① **绝不重灌**：存量库是 baostock 的 qfq，腾讯是另一套 qfq，两者分红累积因子不同。
 *    实测 200 只 ×250 根：换源会让 37.54% 的行 close 改写。全量重灌既没必要又危险
 *    （2.5% 的票腾讯根本拿不到 qfq，重灌会把它们的历史整段抹掉）。
 *    → 故本文件只做「续拉」：`date < 库内最后一根` 的行**一律跳过不覆盖**。
 *
 * ② **amount 无源是既成事实**：腾讯 fqkline 只返回 6 字段（date/open/close/high/low/volume），
 *    没有成交额。新行 amount 写 0，再用腾讯快照（含当日成交额，单位万元）回填**当日**那根。
 *    → 绝不写 `volume × close` 估算：那是造假，违反「数据诚实化」铁律。
 *    → 历史行的 amount 保持 0，由 meta.amountCoverage 如实暴露给前端。
 *
 * ③ **可脱离 Electron 单测**：本文件不 import electron、不 import 原生模块（better-sqlite3），
 *    DB 与日志全部依赖注入。这样 P3 能在**副本库**上真跑 200 只写入验证，而不是靠语法检查交差。
 */
import {
  bootstrapDefaultProviders,
  fetchDailyBars,
  fetchSnapshot,
  fetchUniverse,
} from './providers/registry';
import type { AdjustMode, ProviderBar, ProviderId, ProviderResult, QuoteItem } from './providers/types';
import type { PullProgress } from '@shared/types/ipc';

/** better-sqlite3 的最小子集 —— 只为让本文件不依赖原生模块类型 */
export interface SqliteLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): unknown;
}

export interface SqliteStatementLike {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): { changes: number };
}

export type PullMode = 'full' | 'incremental' | 'fill-missing';

export interface NodePullOptions {
  mode: PullMode;
  /** 目标标的数量；0 = 不截断（全市场） */
  universe: number;
  /**
   * 显式指定标的，跳过 resolveCodes 的名单/库内推导。
   * 用途：① 只更新自选股；② 离线验证（固定样本，可复现）。
   * 传了它时 mode 只影响 poolLimit 是否更新，不影响标的集合。
   */
  codes?: readonly string[];
  /** 单只回溯根数 */
  barsPerCode?: number;
  /** 拉取并发（实测腾讯 4~6 饱和） */
  concurrency?: number;
  /** 复权口径；默认 qfq（与存量库口径一致，改错会污染 369 万根） */
  adjust?: AdjustMode;
  /** 只统计不写库 */
  dryRun?: boolean;
  /** 是否用快照回填当日成交额（默认 true） */
  backfillAmount?: boolean;
}

export interface NodePullStats {
  /** 新插入的行数 */
  inserted: number;
  /** 更新（覆盖当日未完成那根）的行数 */
  updated: number;
  /** 因「库内已有该日期」而跳过的行数 —— P2 结论：不重灌，这是预期行为不是失败 */
  skippedExisting: number;
  /** 拉失败的标的数 */
  failed: number;
  /** 拿不到 qfq（响应只有 day 没有 qfqday）被跳过、保留库内原数据的标的数 */
  noAdjust: number;
  /** 用快照回填了当日成交额的标的数 */
  amountBackfilled: number;
  /** 本次目标标的数 */
  codes: number;
  /** 全市场名单总数（fill-missing/full 时才有） */
  universeSize: number | null;
  /** 实际使用的 provider（按成功次数降序） */
  providers: ProviderId[];
  /** 失败明细（最多 20 条，供日志） */
  failures: string[];
}

export interface NodePullDeps {
  db: SqliteLike;
  onProgress?: (p: PullProgress) => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const DEF = {
  barsPerCode: 320,
  concurrency: 5,
  adjust: 'qfq' as AdjustMode,
};

/**
 * 空闲看门狗（P4）：连续这么多秒没有任何「进度 / 日志 / 完成一只」的活动就判定数据源挂死。
 *
 * ⚠️ 为什么必须自己配看门狗：Node 的 fetch 在 TCP 半开（对端不回 FIN、也不回数据）时
 * **不会**触发超时，会一直挂着 —— 实测腾讯 fqkline 就有约 1.6% 的单只请求能进入这个状态，
 * 不设兜底的话整批 5400 只就永远停在 3% 进度上，用户只能干等或强杀。
 * 这里用「空闲」而不是「总时长」作判据：全市场拉取本来就可能跑几十分钟，只有**卡死**才该中止。
 *
 * 取值：默认 30s（15~30s 这个量级实测足够区分「网络抖动」和「真挂了」，
 * 单只正常耗时 40~700ms）；设成 0 或负数可关闭（自动化回归测试用）。
 */
function idleTimeoutMs(): number {
  const raw = Number(process.env.QUANTPILOT_IDLE_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

const NOOP_LOG: NonNullable<NodePullDeps['log']> = () => undefined;

function rowCount(v: unknown): number {
  if (v && typeof v === 'object' && 'c' in v) return Number((v as { c: unknown }).c) || 0;
  return 0;
}

/**
 * 单只票的写入。
 *
 * 只看「库内最后一根」这个锚点，语义三条：
 *   date <  锚点 → 跳过（历史不覆盖，P2 结论）
 *   date == 锚点 → UPSERT（当日可能未收盘，需要修正；amount 保留旧值）
 *   date >  锚点 → INSERT（这才是真正的"续拉"）
 */
function writeOne(
  db: SqliteLike,
  code: string,
  bars: ProviderBar[],
  dryRun: boolean,
): { inserted: number; updated: number; skipped: number } {
  const out = { inserted: 0, updated: 0, skipped: 0 };
  if (bars.length === 0) return out;

  const anchor = db
    .prepare('SELECT date AS date, close AS close, preClose AS preClose FROM daily WHERE code=? ORDER BY date DESC LIMIT 1')
    .get(code) as { date: string; close: number; preClose: number } | undefined;

  const upsert = db.prepare(
    `INSERT INTO daily(code,date,open,high,low,close,volume,amount,preClose)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code,date) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
       volume=excluded.volume, preClose=excluded.preClose,
       -- amount 换源后无源：已有真值就保留，绝不覆盖成 0
       amount=CASE WHEN daily.amount > 0 THEN daily.amount ELSE excluded.amount END`,
  );
  const exists = db.prepare('SELECT 1 AS x FROM daily WHERE code=? AND date=?');

  // 库内最后一根的 close 是衔接基准：新行的 preClose 从它推导，保证与老序列自洽
  let prev = anchor ? Number(anchor.close) || 0 : 0;
  const asc = bars.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const b of asc) {
    if (anchor && b.date < anchor.date) {
      out.skipped += 1;
      continue;
    }
    const isAnchor = anchor !== undefined && b.date === anchor.date;
    // 锚点行的前收保持库内原值（不该被改写）；新行的前收取上一根 close
    const preClose = isAnchor ? Number(anchor?.preClose) || 0 : prev > 0 ? prev : b.preClose;

    if (!dryRun) {
      if (!isAnchor) {
        upsert.run(code, b.date, b.open, b.high, b.low, b.close, b.volume, b.amount, preClose);
        out.inserted += 1;
      } else {
        // 先判存，才能把 inserted / updated 分开统计（better-sqlite3 的 changes 不区分）
        if (exists.get(code, b.date)) {
          upsert.run(code, b.date, b.open, b.high, b.low, b.close, b.volume, b.amount, preClose);
          out.updated += 1;
        } else {
          upsert.run(code, b.date, b.open, b.high, b.low, b.close, b.volume, b.amount, preClose);
          out.inserted += 1;
        }
      }
    } else {
      // dry-run：靠 exists 判定归属，不写库
      if (exists.get(code, b.date)) out.updated += 1;
      else out.inserted += 1;
    }
    prev = b.close;
  }
  return out;
}

/** 给任意 Promise 套一个硬超时（不取消底层请求，只看结果等不等得起） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject): void => {
    const timer = setTimeout((): void => {
      reject(new Error(`${label}超时（${ms}ms 未返回）`));
    }, ms);
    p.then(
      (v): void => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown): void => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 目标标的清单：incremental = 库内已有；full / fill-missing = 全市场名单 */
async function resolveCodes(
  db: SqliteLike,
  mode: PullMode,
  universe: number,
  progress: (p: PullProgress) => void,
  log: NonNullable<NodePullDeps['log']>,
): Promise<{ codes: string[]; universeSize: number | null; names: Map<string, string> }> {
  const names = new Map<string, string>();
  if (mode === 'incremental') {
    const rows = db
      .prepare(
        'SELECT code AS code FROM daily GROUP BY code ORDER BY code' +
          (universe > 0 ? ' LIMIT ?' : ''),
      )
      .all(...(universe > 0 ? [universe] : [])) as { code: string }[];
    log('info', `[pullRunner] 增量模式：库内已有 ${rows.length} 只标的`);
    return { codes: rows.map((r) => r.code), universeSize: null, names };
  }

  progress({
    phase: 'code-list',
    done: 0,
    total: 0,
    bars: 0,
    message: '正在获取全市场名单…',
  });
  const u = await fetchUniverse(universe > 0 ? universe : undefined);
  if (!u.ok) {
    // 名单拿不到 = 本次无法定位目标，宁可空手返回也不要拿库内旧名单凑合（旧名单可能已退市）
    log('error', `[pullRunner] 全市场名单获取失败：${u.failure.kind} ${u.failure.message}`);
    return { codes: [], universeSize: null, names };
  }
  for (const it of u.value) names.set(it.code, it.name);

  let codes = u.value.map((it) => it.code);
  if (mode === 'fill-missing') {
    // 补名单：目标 = 全市场 − 库内已有
    const have = new Set(
      (db.prepare('SELECT code AS code FROM daily GROUP BY code').all() as { code: string }[]).map(
        (r) => r.code,
      ),
    );
    codes = codes.filter((c) => !have.has(c));
    log('info', `[pullRunner] 补名单：全市场 ${u.value.length} − 库内 ${have.size} = 待补 ${codes.length}`);
  }
  return { codes, universeSize: u.value.length, names };
}

/** 顺带维护 stocks 表：新标的要登记，否则选股池 JOIN 不到 */
function ensureStock(
  db: SqliteLike,
  code: string,
  name: string,
  dryRun: boolean,
): void {
  if (dryRun || name === '') return;
  const market = code.startsWith('sh.') ? 'sh' : code.startsWith('sz.') ? 'sz' : 'bj';
  db.prepare(
    `INSERT INTO stocks(code,name,industry,market) VALUES(?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name`,
  ).run(code, name, '', market);
}

/**
 * 用腾讯快照回填**当日**成交额。
 * 只补当日：快照没有历史成交额，历史行的 amount 只能保持 0（诚实缺口，见文件头约束②）。
 */
async function backfillTodayAmount(
  db: SqliteLike,
  latestDates: Map<string, string>,
  dryRun: boolean,
  log: NonNullable<NodePullDeps['log']>,
  timeoutMs: number,
): Promise<number> {
  if (dryRun || latestDates.size === 0) return 0;
  const codes = [...latestDates.keys()];
  let snap: ProviderResult<QuoteItem[]>;
  try {
    // 超时兜底：快照用的是和 K 线同一个 fetch（默认无超时），TCP 半开时会无限挂着
    snap = await withTimeout(fetchSnapshot(codes), timeoutMs, '快照回填');
  } catch (e) {
    const why = timeoutMs <= 0 ? String(e) : `${String(e)}（${timeoutMs}ms）`;
    log('warn', `[pullRunner] 快照回填放弃，当日成交额不补：${why}`);
    return 0;
  }
  if (!snap.ok) {
    log('warn', `[pullRunner] 快照获取失败，当日成交额不回填：${snap.failure.message}`);
    return 0;
  }
  const upd = db.prepare(
    'UPDATE daily SET amount=? WHERE code=? AND date=? AND (amount IS NULL OR amount<=0)',
  );
  let n = 0;
  for (const q of snap.value) {
    const d = latestDates.get(q.code);
    if (d === undefined) continue;
    if (q.amount <= 0) continue;
    // 只回填本次写入的最新那根，避免拿实时快照去覆盖任意历史日
    const r = upd.run(q.amount, q.code, d);
    n += r.changes;
  }
  return n;
}

/**
 * 执行 Node 路径拉取。
 *
 * 单只失败**不影响整批**（全市场 5000+ 只里有几只挂掉是常态），
 * 但失败数会如实进 stats.failed，由上层决定要不要告警。
 */
export async function runNodePull(
  deps: NodePullDeps,
  opts: NodePullOptions,
): Promise<NodePullStats> {
  const { db } = deps;
  const progress = deps.onProgress ?? ((): void => undefined);
  const log = deps.log ?? NOOP_LOG;
  const barsPerCode = opts.barsPerCode ?? DEF.barsPerCode;
  const concurrency = Math.max(1, opts.concurrency ?? DEF.concurrency);
  const adjust = opts.adjust ?? DEF.adjust;
  const dryRun = opts.dryRun === true;
  const doBackfill = opts.backfillAmount !== false;

  const stats: NodePullStats = {
    inserted: 0,
    updated: 0,
    skippedExisting: 0,
    failed: 0,
    noAdjust: 0,
    amountBackfilled: 0,
    codes: 0,
    universeSize: null,
    providers: [],
    failures: [],
  };

  // 自包含：registry 的 providers 初始为空，不装配会导致 fetchDailyBars 直接 'exhausted'。
  // 幂等（重复注册同 id 会被忽略），调用方忘了装配也不会静默全失败。
  bootstrapDefaultProviders();

  const resolved =
    opts.codes !== undefined
      ? { codes: [...opts.codes], universeSize: null, names: new Map<string, string>() }
      : await resolveCodes(db, opts.mode, opts.universe, progress, log);
  const { codes, universeSize, names } = resolved;
  stats.codes = codes.length;
  stats.universeSize = universeSize;
  if (codes.length === 0) {
    progress({ phase: 'error', done: 0, total: 0, bars: 0, message: '未取到目标标的清单' });
    return stats;
  }

  progress({
    phase: 'fetch',
    done: 0,
    total: codes.length,
    bars: 0,
    message: `开始拉取 ${codes.length} 只标的的日 K（${adjust}）…`,
  });

  const hitCount = new Map<ProviderId, number>();
  const latestDates = new Map<string, string>();
  let done = 0;

  // 并发拉取；每只内部自带跨源重试，这里只负责收口与进度
  const pending = codes.map((code) => async (): Promise<void> => {
    const r = await fetchDailyBars(code, { limit: barsPerCode, adjust });
    if (!r.ok) {
      // no-data ≠ 故障：该源确实没有这只票的这个复权口径。
      // ⚠️ 旧注释写「近期大比例除权股专属」已被 2026-10-06 实测证伪（见 providers/types.ts 与
      // meta.knownAdjustBias 名单）：新端点（proxy.finance.qq.com）一直返回 qfqday，只是那几只票
      // 另有原因落到这里，不再按「除权股」归因。
      // 单列统计，不拉低「成功率」，也不写进 failures（它不是错误，是事实）。
      if (r.failure.kind === 'no-data') {
        stats.noAdjust += 1;
        return;
      }
      stats.failed += 1;
      if (stats.failures.length < 20) {
        stats.failures.push(`${code}: ${r.failure.kind} ${r.failure.message}`);
      }
      return;
    }
    hitCount.set(r.provider, (hitCount.get(r.provider) ?? 0) + 1);

    const bars = r.value;
    if (bars.length === 0) {
      // 拿不到 qfq（响应里只有 day 没有 qfqday）的票：跳过并保留库内原数据，绝不擦除
      stats.noAdjust += 1;
      if (stats.failures.length < 20) stats.failures.push(`${code}: 无 ${adjust} 数据，保留库内原值`);
      return;
    }

    const w = writeOne(db, code, bars, dryRun);
    stats.inserted += w.inserted;
    stats.updated += w.updated;
    stats.skippedExisting += w.skipped;

    const last = bars.reduce((m, b) => (b.date > m ? b.date : m), bars[0]?.date ?? '');
    if (last !== '') latestDates.set(code, last);
    ensureStock(db, code, names.get(code) ?? '', dryRun);
  });

  // ------------------------------------------------------------------
  // 空闲看门狗：只要有任何活动（进度 / 日志 / 完成一只）就重置计时
  // ------------------------------------------------------------------
  const idleMs = idleTimeoutMs();
  let lastActivity = Date.now();
  let watchdogReject: ((e: Error) => void) | null = null;
  const watchdog = new Promise<never>((_resolve, reject): void => {
    watchdogReject = reject;
  });
  const touch = (): void => {
    lastActivity = Date.now();
  };
  const watchdogTimer =
    idleMs > 0
      ? setInterval((): void => {
          const idle = Date.now() - lastActivity;
          if (idle <= idleMs) return;
          const sec = Math.round(idle / 1000);
          const msg = `数据源无响应：已 ${sec}s 无任何进度输出（阈值 ${Math.round(idleMs / 1000)}s）`;
          log('error', `[pullRunner] ${msg}，本次拉取已中止（可用 QUANTPILOT_IDLE_TIMEOUT_MS=0 关闭看门狗）`);
          progress({ phase: 'error', done, total: codes.length, bars: stats.inserted + stats.updated, message: msg });
          if (watchdogReject) watchdogReject(new Error(msg));
        }, 5_000)
      : null;

  try {
    // 自带并发上限的调度（不引三方库，与 providers/http.ts 的 mapLimit 同思路）
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= pending.length) return;
        await (pending[i] as () => Promise<void>)();
        done += 1;
        touch();
        const ts = new Date().toISOString().slice(11, 19);
        if (done % 20 === 0 || done === codes.length) {
          progress({
            phase: 'fetch',
            done,
            total: codes.length,
            bars: stats.inserted + stats.updated,
            message: `已拉取 ${done}/${codes.length} 只，新增 ${stats.inserted} 根（${ts}）`,
          });
        }
      }
    });
    // ⚠️ 必须是 race 不是 all：watchdog 正常时永远 pending，
    // 用 all 会把「K 线 1 秒拉完」的批次硬生生挂到 30s 超时才放行（P4 实测踩过）。
    // race 下：正常走完就往下走，看门狗先超时则中断整批，
    // 已进入的请求由 fetch 自身超时收尾，不会再拖着进程。
    await Promise.race([Promise.all(workers), watchdog]);
  } finally {
    log('info', `[pullRunner] K 线阶段结束（done=${done}/${codes.length}），摘掉看门狗`);
    // K 线阶段结束 → 立刻摘掉看门狗。
    // ⚠️ 回填阶段绝不共用它：回填只是「补当日成交额」的可选优化，
    // 快照源慢/挂只该少补几行 amount，不该把已经拉完的整批结果一起判死（P4 实测踩过：60 只全拉完
    // 却因为回填卡住 30s，被看门狗连同抛出，用户眼看「什么都补上了却报失败」）。
    if (watchdogTimer !== null) clearInterval(watchdogTimer);
  }

  if (doBackfill) {
    // 独立超时（默认 20s，0=不限制）：快照源挂了就少补几行 amount 并 warn，
    // 绝不因此让「K 线已经全拉完」的整批结果变成一次失败。
    const snapMs = Number(process.env.QUANTPILOT_SNAPSHOT_TIMEOUT_MS ?? 20_000) || 0;
    stats.amountBackfilled = await backfillTodayAmount(
      db,
      latestDates,
      dryRun,
      log,
      snapMs > 0 ? snapMs : Infinity,
    );
  }

  stats.providers = [...hitCount.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  progress({
    phase: 'done',
    done: codes.length,
    total: codes.length,
    bars: stats.inserted + stats.updated,
    message: `完成：新增 ${stats.inserted} 根 / 更新 ${stats.updated} 根 / 失败 ${stats.failed} 只`,
  });
  log(
    'info',
    `[pullRunner] 完成 inserted=${stats.inserted} updated=${stats.updated} skipped=${stats.skippedExisting} failed=${stats.failed} noAdjust=${stats.noAdjust} amountBackfilled=${stats.amountBackfilled}`,
  );
  return stats;
}

/** 库内 K 线总根数（供上层写 meta / 断言 barCount 不下降） */
export function barCount(db: SqliteLike): number {
  return rowCount(db.prepare('SELECT COUNT(*) c FROM daily').get());
}

/** 成交额覆盖率：真实有 amount 的行占比（换源后这个数会缓慢下降，如实暴露给前端） */
export function amountCoverage(db: SqliteLike): number {
  const total = rowCount(db.prepare('SELECT COUNT(*) c FROM daily').get());
  if (total === 0) return 0;
  const withAmount = rowCount(
    db.prepare('SELECT COUNT(*) c FROM daily WHERE amount IS NOT NULL AND amount > 0').get(),
  );
  return withAmount / total;
}
