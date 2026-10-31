#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.9.2 数据健康防线单测（不联网、不依赖 baostock）。

运行：受管 python python/test_data_health.py
覆盖：universe_ok 下限校验 / purge_non_targets 80% 防护 / fill-missing 目标集合计算。
"""
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from baostock_fetcher import SCHEMA, local_codes, purge_non_targets, universe_ok

pass_n = 0
fail_n = 0


def ok(cond, msg):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  ✅ {msg}")
    else:
        fail_n += 1
        print(f"  ❌ {msg}")


def mem_db():
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    return conn


print("--- universe_ok 下限校验 ---")
ok(universe_ok(5400, 4500, 0) is True, "全市场 5400 ≥ 4500 → 放行")
ok(universe_ok(4284, 4500, 0) is False, "全市场 4284 < 4500 → 拒绝（防截断名单）")
ok(universe_ok(4284, 4500, 500) is True, "--limit 500 截断属合法 → 不校验")
ok(universe_ok(100, 0, 0) is False, "min_u=0 走默认 4500 → 仍拒绝")
ok(universe_ok(4500, 4500, 0) is True, "恰好 4500 → 放行")

print("--- purge_non_targets 80% 防护 ---")
conn = mem_db()
conn.executemany(
    "INSERT INTO stocks(code,name,industry,market) VALUES(?,?,?,?)",
    [(f"sh.60{i:04d}", f"股{i}", "", "sh") for i in range(100)],
)
conn.executemany(
    "INSERT INTO daily(code,date,close) VALUES(?,?,?)",
    [(f"sh.60{i:04d}", "2026-09-30", 10.0) for i in range(100)],
)
conn.commit()
r = purge_non_targets(conn, [f"sh.60{i:04d}" for i in range(50)])
ok(r is None, "目标 50 << 库内 100（<80%）→ 拒绝清理（返回 None）")
ok(conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0] == 100, "stocks 未被删除")
ok(conn.execute("SELECT COUNT(*) FROM daily").fetchone()[0] == 100, "daily 未被删除")
r2 = purge_non_targets(conn, [f"sh.60{i:04d}" for i in range(95)])
ok(r2 is not None and r2[0] == 5, "目标 95 ≥ 80% → 正常清理 5 只")
ok(conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0] == 95, "stocks 剩 95")
# 空库不触发防护（existing=0）
conn2 = mem_db()
r3 = purge_non_targets(conn2, [f"sh.60{i:04d}" for i in range(10)])
ok(r3 is not None and r3[0] == 0, "空库 existing=0 → 不触发防护")

print("--- fill-missing 目标集合计算 ---")
uni = [f"sh.60{i:04d}" for i in range(100)] + [f"sz.30{i:04d}" for i in range(50)]
have = set(local_codes(conn))
targets = [c for c in uni if c not in have]
ok(len(targets) == 55, f"universe 150 − 本地 95 = 待补 55（实际 {len(targets)}）")
ok(all(c not in have for c in targets), "待补集合与本地无交集")
ok(len(set(targets)) == len(targets), "待补集合无重复")

conn.close()
conn2.close()
print(f"\n结果：{pass_n} 通过 / {fail_n} 失败")
if fail_n > 0:
    sys.exit(1)
