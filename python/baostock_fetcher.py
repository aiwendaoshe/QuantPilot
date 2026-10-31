#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QuantPilot 数据抓取器：使用 baostock 拉取 A 股日 K（后复权）写入 SQLite。

被 Electron 主进程通过子进程调用：
    python baostock_fetcher.py --db <path> (--full | --incremental)
        [--limit N] [--codes a,b,c] [--local-only] [--lookback-years N]

语义约定
--------
* --incremental + --local-only : 只更新「库里已有」的标的（不新增标的），
  单只从「本地最后一根 K 线 + 1 天」续拉 → 快且不会偏离用户既有股票池。
* --full                      : 全量重建。以本次目标集合为准，清掉不在目标内的
  旧 stocks / daily 行（否则「股票数」会虚高，曾出现回填 200 只却显示 201 只）。
  逐只重拉时先删该只旧 K 线，保证回看窗口精确（避免更早窗口的残留行）。

输出：最后一行打印 JSON 汇总 {"inserted":N,"updated":M,...}，便于主进程解析。
进度：stderr 打印 `progress i/total pct=P bars=N phase=fetch`，主进程据此喂看门狗 + 前端进度条。
"""
import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta

SCHEMA = """
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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_daily_code ON daily(code);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily(date);
"""

FIELDS = "date,open,high,low,close,volume,amount,preclose"
ADJUST = "2"  # 后复权

# 只保留沪深 A 股（主板 / 中小 / 创业 / 科创），排除 B 股、指数、基金
A_PREFIXES = ("sh.6", "sz.0", "sz.3")

# 与 Node 侧 dataService 的 busy_timeout 保持一致（毫秒）
BUSY_TIMEOUT_MS = 15000


def init_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    # 与 Node 侧（dataService.getDb）争写锁时的统一退让时长（毫秒）。
    # 不设的话，Node 正在读/写时会直接抛 "database is locked" 把 UI 打崩。
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    conn.executescript(SCHEMA)
    return conn


def market_universe(bs):
    """一次性拉取全市场标的：返回 (codes, name_map)。

    ⚠️ 不要用 bs.query_all_stock()：实测在当前数据服务端会**随机挂起或返回 0 行**
    （不带 day 参数返 0 行；带 day=最近交易日则长时间无响应）。
    改用 bs.query_stock_basic()，稳定返回约 9000 条，字段：
        code, code_name, ipoDate, outDate, type, status
    其中 type: 1=股票 2=指数 3=其它；status: 1=上市 0=退市。
    这里只保留 type=1 且 status=1 的沪深 A 股。
    同时缓存 code -> 中文名，避免再发一次同样的请求（服务端不稳定，请求越少越好）。
    """
    codes = []
    names = {}
    try:
        rs = bs.query_stock_basic()
        while rs.error_code == "0" and rs.next():
            d = rs.get_row_data()
            if not d or not d[0]:
                continue
            code = d[0]
            nm = (d[1] or "").strip()
            if nm:
                names[code] = nm
            typ = d[4] if len(d) > 4 else "1"
            status = d[5] if len(d) > 5 else "1"
            if typ != "1" or status != "1":
                continue
            if not code.startswith(A_PREFIXES):
                continue
            codes.append(code)
    except Exception as e:
        sys.stderr.write(f"warn: query_stock_basic 异常 {e}\n")
    return codes, names


def universe_ok(count: int, min_u: int, limit: int) -> bool:
    """全市场口径（limit=0）时 universe 名单数量下限校验。

    --limit N 截断属合法行为不校验；数量骤减 = query_stock_basic 流中断返回半截名单，
    绝不能继续（v0.9.2 新增，防 purge 删库）。min_u<=0 时用默认 4500。
    """
    if min_u <= 0:
        min_u = 4500
    return not (limit == 0 and count < min_u)


def local_codes(conn) -> list:
    """库中已有标的（升序）。"""
    return [r[0] for r in conn.execute("SELECT code FROM stocks ORDER BY code").fetchall()]


def purge_non_targets(conn, targets: list):
    """全量重建：清掉不在本次目标集合内的旧行。

    只删「非目标」的行，不整表清空 —— 即使本次抓取中途被杀（服务端无响应），
    已存在的其它标的也不会被一次性抹掉。
    防护（v0.9.2）：目标数量骤减（< 库内 80%）视为名单截断，拒绝清理——
    历史上曾按残缺名单 purge 永久删掉 ~1100 只（创业板缺 850+）。
    返回 (removed_stocks, removed_bars)；拒绝时返回 None。
    """
    existing = conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0]
    if existing > 0 and len(targets) < existing * 0.8:
        sys.stderr.write(
            f"warn: 目标 {len(targets)} 只 << 库内 {existing} 只（<80%），疑似名单截断，跳过清理（宁勿删）\n"
        )
        return None
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS _targets(code TEXT PRIMARY KEY)")
    conn.execute("DELETE FROM _targets")
    conn.executemany("INSERT OR IGNORE INTO _targets(code) VALUES(?)", [(c,) for c in targets])
    removed_bars = conn.execute(
        "DELETE FROM daily WHERE code NOT IN (SELECT code FROM _targets)"
    ).rowcount
    removed_stocks = conn.execute(
        "DELETE FROM stocks WHERE code NOT IN (SELECT code FROM _targets)"
    ).rowcount
    conn.execute("DROP TABLE _targets")
    conn.commit()
    return removed_stocks, removed_bars


def last_date(conn, code: str):
    cur = conn.execute("SELECT MAX(date) FROM daily WHERE code=?", (code,))
    return cur.fetchone()[0]


def fetch_history(bs, code: str, start: str, end: str) -> list:
    """拉取单只历史 K 线。

    ⚠️ baostock 的 query_history_k_data_plus 在服务端繁忙/限流时**会长时间无响应**
    （实测同一请求先成功后挂起）。此处不做单只超时（Python 层无法安全中断
    socket 阻塞），由上层 Electron 主进程统一喂「空闲看门狗」兜底；另外通过
    --lookback-years 限制回看窗口，把单只耗时压到可接受范围。
    """
    rs = bs.query_history_k_data_plus(
        code, FIELDS, start_date=start, end_date=end, frequency="d", adjustflag=ADJUST
    )
    rows = []
    while rs.error_code == "0" and rs.next():
        d = rs.get_row_data()
        try:
            rows.append(
                (
                    code,
                    d[0],
                    float(d[1]), float(d[2]), float(d[3]), float(d[4]),
                    float(d[5]), float(d[6]), float(d[7]),
                )
            )
        except (ValueError, IndexError):
            continue
    return rows


def fetch_one_name(bs, code: str) -> str:
    """单只补查中文名，查不到返回空串。"""
    try:
        rs = bs.query_stock_basic(code=code)
        while rs.error_code == "0" and rs.next():
            d = rs.get_row_data()
            if d and d[0] == code:
                return (d[1] or "").strip()
    except Exception:
        pass
    return ""


def upsert_name(conn, code: str, name: str) -> int:
    """写入/补全股票中文名；已存在真实名称时不覆盖，避免被代码值污染。"""
    market = code.split(".")[0]
    row = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO stocks(code,name,industry,market) VALUES(?,?,?,?)",
            (code, name, "", market),
        )
        return 1
    if (row[0] in ("", code)) and name and name != code:
        conn.execute("UPDATE stocks SET name=? WHERE code=?", (name, code))
        return 1
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--full", action="store_true", help="全量重建（以目标集合为准，清掉非目标旧行）")
    ap.add_argument("--incremental", action="store_true", help="仅补齐缺失日期")
    ap.add_argument("--limit", type=int, default=0, help="最多抓取标的数（0=全市场）")
    ap.add_argument("--codes", default="", help="逗号分隔的指定代码列表")
    ap.add_argument(
        "--local-only",
        action="store_true",
        help="增量语义：目标=库内已有标的（不新增标的、不受 --limit 截断）",
    )
    ap.add_argument(
        "--lookback-years",
        type=int,
        default=3,
        help="新股回看年数（0=不限，从 2000 年起）。默认 3 年，兼顾策略样本量与抓取速度",
    )
    ap.add_argument(
        "--fill-missing",
        action="store_true",
        help="补拉缺失标的：目标=universe 全集 − 库内已有，只拉缺的（不清理既有数据）",
    )
    ap.add_argument(
        "--min-universe",
        type=int,
        default=0,
        help="全市场 universe 数量下限（0=默认 4500）；低于此值视为名单截断，拒绝写库",
    )
    args = ap.parse_args()

    try:
        import baostock as bs
    except ImportError:
        print(json.dumps({"inserted": 0, "updated": 0, "error": "baostock 未安装"}))
        return

    conn = init_db(args.db)
    lg = bs.login()
    if lg.error_code != "0":
        print(json.dumps({"inserted": 0, "updated": 0, "error": "baostock 登录失败"}))
        return

    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    names = {}
    uni_total = 0  # 本次拉到的全市场名单总数（写 meta.universeSize 供前端覆盖度提示）
    min_u = args.min_universe if args.min_universe > 0 else 4500

    if args.fill_missing:
        # 补拉缺失标的（v0.9.2）：只新增、不清理、不重拉已有
        uni, uni_names = market_universe(bs)
        names.update(uni_names)
        uni_total = len(uni)
        if not universe_ok(uni_total, min_u, args.limit):
            sys.stderr.write(
                f"error: universe 名单仅 {uni_total} 只 < 下限 {min_u}，疑似接口截断；"
                "拒绝继续以保护本地数据（可用 --min-universe 调整）\n"
            )
            conn.close()
            bs.logout()
            print(json.dumps({"inserted": 0, "updated": 0, "error": f"universe 名单截断（{uni_total} 只 < {min_u}）"}))
            return
        have = set(local_codes(conn))
        targets = [c for c in uni if c not in have]
        sys.stderr.write(
            f"info: 全市场 {uni_total} 只，本地已有 {len(have)} 只，待补拉 {len(targets)} 只\n"
        )
    elif args.local_only:
        # 增量：只更新库里已有的标的，不新增
        targets = local_codes(conn)
        if not targets:
            sys.stderr.write("info: 本地库为空，退化为按 --limit 拉取新标的\n")
            targets, names = market_universe(bs)
            if args.limit > 0:
                targets = targets[: args.limit]
    elif codes:
        targets = codes[: args.limit] if args.limit > 0 else codes
    else:
        targets, names = market_universe(bs)
        uni_total = len(targets)
        if not universe_ok(uni_total, min_u, args.limit):
            sys.stderr.write(
                f"error: universe 名单仅 {uni_total} 只 < 下限 {min_u}，疑似接口截断；"
                "拒绝继续以保护本地数据（可用 --min-universe 调整）\n"
            )
            conn.close()
            bs.logout()
            print(json.dumps({"inserted": 0, "updated": 0, "error": f"universe 名单截断（{uni_total} 只 < {min_u}）"}))
            return
        if args.limit > 0:
            targets = targets[: args.limit]
        if not targets:
            conn.close()
            bs.logout()
            print(json.dumps({"inserted": 0, "updated": 0, "error": "无法获取股票列表（baostock 无响应）"}))
            return

    total = len(targets)
    if total == 0:
        conn.close()
        bs.logout()
        print(json.dumps({"inserted": 0, "updated": 0, "error": "目标标的为空"}))
        return

    # 全量重建：先清理非目标残留，保证「股票数」与实际标的严格一致
    if args.full and not codes:
        purged = purge_non_targets(conn, targets)
        if purged is None:
            sys.stderr.write("info: 本次全量不做清理，仅按名单写入/更新\n")
        else:
            rm_stocks, rm_bars = purged
            sys.stderr.write(f"info: 全量重建，清理非目标旧数据 {rm_stocks} 只 / {rm_bars} 行\n")

    today = datetime.now().strftime("%Y-%m-%d")
    window_start = (
        "2000-01-01"
        if args.lookback_years <= 0
        else (datetime.now() - timedelta(days=365 * args.lookback_years)).strftime("%Y-%m-%d")
    )
    sys.stderr.write(
        f"info: 目标 {total} 只，模式={'补拉缺失' if args.fill_missing else ('全量' if args.full else '增量')}"
        f"{'（仅库内标的）' if args.local_only else ''}，新股回看自 {window_start}\n"
    )
    # 每只都能推进就逐只回报（便于看门狗与进度条），标的很多时降频
    step = 1 if total <= 400 else 5

    inserted = 0
    updated = 0
    named = 0
    skipped = 0
    failed = []
    # 必须用 cursor：conn.execute() 对带占位符的 SQL 会立即校验参数个数，
    # 后续 executemany(rows) 才传参 → 会抛 "Incorrect number of bindings"。
    ins = conn.cursor()
    ins_sql = (
        "INSERT OR REPLACE INTO daily(code,date,open,high,low,close,volume,amount,preClose) "
        "VALUES(?,?,?,?,?,?,?,?,?)"
    )

    for i, code in enumerate(targets):
        ld = last_date(conn, code)
        if args.full and ld == today:
            # 全量重建：清非目标残留照样生效（股票数仍准确），
            # 但对「本地已含最新交易日」的标的跳过请求——
            # 否则每次重跑全市场都要白白请求 5400 次（先拉过 2000 只再转全市场时尤其省时间）。
            skipped += 1
            if (i + 1) % step == 0 or (i + 1) == total:
                pct = (i + 1) * 100 // max(total, 1)
                sys.stderr.write(
                    f"progress {i+1}/{total} pct={pct} bars={inserted} phase=fetch\n"
                )
            continue
        if args.full:
            start = window_start
        else:
            # 增量：从本地最后一根 K 线次日续拉；新股才用回看窗口起点
            # （曾经写成「早于窗口就抬到窗口起点」→ 每只都从头重拉，白等几千根）
            start = (
                (datetime.strptime(ld, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
                if ld
                else window_start
            )

        if start > today:
            skipped += 1
            if (i + 1) % step == 0 or (i + 1) == total:
                pct = (i + 1) * 100 // max(total, 1)
                sys.stderr.write(
                    f"progress {i+1}/{total} pct={pct} bars={inserted} phase=fetch\n"
                )
        else:
            try:
                rows = fetch_history(bs, code, start, today)
            except Exception as e:  # 单只失败不拖垮整体
                sys.stderr.write(f"warn: {code} 拉取异常 {e}\n")
                rows = []
            if rows:
                cur = conn.cursor()
                # 统计「新增 vs 更新」：同区间已有行数即被覆盖的数量
                existed = cur.execute(
                    "SELECT COUNT(*) FROM daily WHERE code=? AND date>=? AND date<=?",
                    (code, start, today),
                ).fetchone()[0]
                updated += min(existed, len(rows))
                inserted += max(0, len(rows) - existed)
                if args.full:
                    # 全量：先删该只旧 K 线，保证回看窗口精确、无更早窗口残留
                    conn.execute("DELETE FROM daily WHERE code=?", (code,))
                ins.executemany(ins_sql, rows)
            else:
                failed.append(code)
            if (i + 1) % step == 0 or (i + 1) == total:
                pct = (i + 1) * 100 // max(total, 1)
                sys.stderr.write(
                    f"progress {i+1}/{total} pct={pct} bars={inserted} phase=fetch\n"
                )
                conn.commit()

        # 中文名：库里已有真实名（≠代码）就不发网络请求
        row = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
        cur_name = row[0] if row else None
        if cur_name is not None and cur_name not in ("", code):
            continue
        nm = names.get(code) or fetch_one_name(bs, code) or code
        named += upsert_name(conn, code, nm)

    conn.commit()
    try:
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('lastUpdate',?)", (datetime.now().isoformat(),))
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('dataSource',?)", ("baostock",))
        if uni_total > 0:
            # 全市场名单总数：前端覆盖度提示（本地 X / 全市场 Y）用
            conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('universeSize',?)", (str(uni_total),))
        conn.commit()  # ⚠️ 必须再 commit 一次，否则 meta 写入随 close() 丢失
    except sqlite3.OperationalError as e:
        # meta 只是「显示用状态」，被 Node 侧抢锁时降级即可，不能让整次回填失败
        if "locked" in str(e) or "busy" in str(e):
            sys.stderr.write(f"warn meta 写入被占用（{e}），不影响数据本身\n")
        else:
            raise
    conn.close()
    bs.logout()
    if failed:
        sys.stderr.write(f"warn: {len(failed)} 只未取到数据（服务端波动）：{','.join(failed[:10])}\n")
    print(
        json.dumps(
            {
                "inserted": inserted,
                "updated": updated,
                "named": named,
                "skipped": skipped,
                "failed": len(failed),
                "codes": total,
                "universeSize": uni_total,
            }
        )
    )


if __name__ == "__main__":
    main()
