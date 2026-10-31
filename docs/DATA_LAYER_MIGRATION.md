# QuantPilot 数据层迁移教学方案：从 baostock + Python 到纯 Node.js/TypeScript

> 本文只提供**教学方案与集成示例**，最终选型由主子决定。
> 文中所有「本机实测」数字均来自 2026-10-05 在 `quantpilot` 项目机上的真实探测，非文档推断。

---

## 0. 结论速览（先看这一节）

### 0.1 现状：baostock 已经不是慢，是**断**

```
baostock.com:10030        TCP 连接 5s 超时，不可达
push2.eastmoney.com       HTTP 200，但 body 为空（出口 IP 被拒）
push2his.eastmoney.com    HTTP 200，但 body 为空
qt.gtimg.cn               200 / 0.26s 正常
web.ifzq.gtimg.cn fqkline 200 / 0.2s 正常，qfq/hfq/不复权三档齐全
hq.sinajs.cn              200 / 0.23s 正常
通达信 7709（6 个服务器）3 个 20~63ms 可达
```

> **东财系接口返回 HTTP 200 但 body 是空的**，这是最阴的一类故障：
> 只要代码里按「HTTP 状态码」或「请求没抛异常」判定成功，就会**静默拿到 0 行数据还当成拉取成功**。
> 本项目 `dataService.runPython` 里已有 `if (typeof r.error === 'string')` 的 JSON 解析路径兜底，
> 但新 Provider 必须把「解析出空数组」也判成失败（见 §6 坑 6）。

### 0.2 实测吞吐（决定选型的核心数字）

| 实测项 | 结果 |
|---|---|
| 腾讯 fqkline qfq 逐只拉（旧端点 `web.ifzq.gtimg.cn`，200 只 / 并发 6） | 3.1s，成功 200 / 失败 0，单只峰值 217ms |
| 腾讯 fqkline qfq 逐只拉（**新端点 `proxy.finance.qq.com/ifzqgtimg`**，63 只 / 并发 6） | 1396ms，成功 62 / 失败 1，单只中位数 123ms / 峰值 189ms |
| **外推全市场 5571 只 qfq 历史回填** | **≈ 1.4 ~ 2.0 分钟**（旧端点取 1.4，新端点取 2.0） |
| stock-sdk `batch.cn` 全市场快照 | **5571 只 / 735ms** |
| stock-sdk 的 close 与存量库对拍 | **5223 / 5223 完全一致** |
| stock-sdk 的 prevClose 与存量库对拍 | 5213 / 5223 一致，10 只不一致（除权日最大偏 26%） |
| stock-sdk `kline.cn` 与存量库对拍 | **口径偏 0.05% ~ 1.37%，不可用** |
| TDX `getKline` 单只 / `getQuote` 2 只 | 25ms / 25ms；`connect()` 99ms（自动选最快服务器） |

### 0.3 推荐组合（不是单一方案，是分层用）

| 用途 | 推荐源 | 理由 |
|---|---|---|
| **历史 K 线回填**（daily 表） | 腾讯 `proxy.finance.qq.com/ifzqgtimg` fqkline，**qfq** | 与存量库逐字段零偏差；⚠️ 旧端点已被 WAF 拦，必须走 proxy 前缀 |
| **全市场快照 / 实时行情 / 涨停价** | `stock-sdk.batch.cn()` 或 **新浪 Market_Center** | 5571 只 0.7 秒；TDX 也可但需长连接 |
| **盘中实时低延迟**（后续批次） | `node-tdx-market`（7709） | 25ms，自带五档、lastClose |
| **WorkBuddy MCP 取数** | `a-share-mcp`（npx sidecar）或 `stock-sdk mcp` | 二者都是 MCP 服务，不是库 |

> ⚠️ **两个不可用的坑**：`stock-sdk.kline.cn` 口径偏移（不能用它回填）、
> `stock-sdk.batch.cn().prevClose` 是**复权前的原始昨收**（除权日会偏，不能写 `daily.preClose`）。

### 0.4 Provider 层落地后的 4 个实测增量（v0.9.4 新增）

代码已落到 `src/main/services/providers/`，跑 `_smoke/test_providers.ts` 时又打出来 4 个 P0 没暴露的事实：

| # | 发现 | 影响 | 处理 |
|---|---|---|---|
| ① | **旧端点 `web.ifzq.gtimg.cn` 已被腾讯 WAF 拦**（HTTP 501 + 跳 `waf.tencent.com` 挑战页），换 `proxy.finance.qq.com/ifzqgtimg` 前缀才 200 | 照抄旧端点代码 = 全量拉取全挂 | `FQ_URL` 已改，见 §3.4 |
| ② | 新浪 `node=hs_a` **混进北交所 920xxx**（实测首两条是 `bj.920000` / `bj.920001`），与存量库 `sh.6/sz.0/sz.3` 口径不符 | 不过滤会往库里塞 ~900 只北交所票，选股池/回测池口径全乱 | `sinaProvider` 已按前缀硬过滤 |
| ③ | **腾讯 K 线只有 6 个字段**（date/open/close/high/low/volume），**不返回成交额** → `daily.amount` 新数据只能是 0 | 冷切换后 amount 全丢，VWMA（`indicators.ts:343`）与涨停池排序（`limitup.ts:104`）会退化 | 见下方「amount 缺口方案」，**禁止**用 `volume×close` 估算 |
| ④ | 单只请求**偶发失败率约 1.6%**（63 只挂 1 只，超时/WAF 抖动） | 全市场 1.4 分钟里会静默少 ~90 只 | `registry` 已加单只重试（2 次 + 120~300ms 随机抖动） |

**amount 缺口方案（建议，需 P3/P4 落地）**

1. 写入层：新源 `amount === 0` 时 **UPSERT 不覆盖**旧值（SQLite 用 `COALESCE`，见 §4.4）；
2. 存量库 369 万根的 baostock 成交额继续用，历史不丢；
3. `indicators.ts` 的 VWMA 对 `amount <= 0` 的 bar 跳过加权（防除零 → NaN 污染信号）；
4. UI `fmtAmount(0)` 本来就返回 `—`，天然兼容；
5. meta 记 `amountCoverage`，让用户在状态里看到「成交额覆盖率」。

---

### 0.5 P2 对拍结论（200 只 × 250 根 = 49,217 行，决定「要不要重灌」）

脚本：`_smoke/p2/export_baseline.py` → `reconcile.ts`（只读，绝不写库）。

**先说结论：换源要做「增量写入」，不要全量重灌。** 理由在下面三条实测。

#### ① 存量库**确实是前复权**，但和腾讯不是同一份 qfq 实现

三口径对照（`sh.603939`，同日三列），这是全部推理的支点：

| 日期 | 存量库 close | 腾讯 qfq | 腾讯 `day`（不复权） |
|---|---|---|---|
| 2026-09-30（最新根） | 23.31 | 23.31 | 23.31 |
| 2026-09-29 | 22.70999562 | 22.710 | 23.010 |
| 2026-09-23 | 21.80199058 | 21.790 | 22.090 |

- 最新根三口径**完全一致** → 库是 qfq（不是不复权、也不是后复权），`ADJUST="2"` 的注释是错的但结果对；
- `day - qfq = 0.30` 且**恒定** → 这是该股每股现金分红额，反过来证明腾讯 `day` 字段确实是不复权；
- 库 − qfq 的差从 0.0008（09-29）涨到 0.012（09-23），**越往历史越大**（另一只 `sz.300095` 到 2026-01-12 已达 0.0567，相对 0.44%）。

→ 所以差异的性质是 **baostock 与腾讯的分红累积因子/基准日不同造成的校准差**，不是脏数据、也不是单位错。

#### ② 换源 qfq 的影响面（实测数字）

| close 偏移 | 行数 | 占比 |
|---|---|---|
| 完全一致（Δ=0） | 21,889 | 45.06% |
| Δ ≤ 0.01 | 8,453 | 17.40% |
| 0.01 < Δ < 0.5 | 18,020 | 37.09% |
| Δ ≥ 0.5（除权级） | 219 | 0.45% |
| **会被改写合计** | **18,239** | **37.54%（133/200 只票）** |

即「换源零重灌」这个早期判断**不成立**：约 37.5% 的行 close 会变，但**绝大多数偏移 < 0.5 元、相对幅度 < 0.6%**。

#### ③ 三条硬性限制（这才是不能重灌的原因）

| 限制 | 实测 | 后果 |
|---|---|---|
| **部分票腾讯拿不到 qfq** | 200 只里 **5 只**（2.5%）返回体只有 `day`、没有 `qfqday`，多集中在**近期大比例除权股**（`sh.601091` @2026-09-21 腰斩、`sz.301686` @2026-09-23） | 若全量重灌，这些票的**历史会被整段丢掉** —— 不可逆损失，代价远大于 0.15 元的偏移 |
| **腾讯 K 线不返回成交额** | 48,386/48,581 行 amount 缺口 | 重灌必然把 369 万根的 amount 抹成 0（除非 UPSERT 保留） |
| **科创板 volume 单位是「股」** | 见 §0.5 footnote | 不修会虚增 100 倍，已在 provider 修好 |

> **footnote（P2 修掉的真 bug）**：腾讯 fqkline 对**科创板 688** 返回的 volume 单位是「股」，
> 对沪主板 60 / 深主板 00 / 创业板 30 返回「手」。provider 原先一律 ×100，
> 导致 `sh.688496` 等票成交量虚增 100 倍。修法按 code 前缀判定（`tencentProvider.ts`），已注释留证据。

#### 采纳方案

```text
日 K 用腾讯 qfq，UPSSERT 增量写入，不重灌历史：
  · 老行 = baostock qfq（自洽），新行 = 腾讯 qfq（自洽）
  · 衔接处有且仅有一处 ≤0.15 元的跳变 —— 比"整段丢历史"或"全库重建"都划算
  · amount 用 COALESCE 保留旧值
  · 拿不到 qfq 的票（约 2.5%）跳过，保留库内原有数据，绝不擦除
  · 后续若真要统一口径，再单独安排一次「全量重灌」专项，并先解决 2.5% 缺源问题
```

---

### 0.6 P3 落地：Node 写入路径已接通并验证（60 只真实写入，12 条断言全绿）

新增 `src/main/services/pullRunner.ts`（依赖注入：不 import electron、不 import 原生模块），
`dataService.pullHistory` 改为**双轨分发**：默认走 Node，`meta.pullEngine === 'python'` 才走旧 baostock 路径。

写入语义（`writeOne`）只有三条，全部由 P2 结论倒逼出来：

| 该行日期 vs 库内最后一根 | 动作 | 为什么 |
|---|---|---|
| `<` 锚点 | **跳过，不覆盖** | P2 实测换源会改写 37.54% 的行，重灌=自找麻烦 |
| `==` 锚点 | UPSERT（amount 保留旧值） | 当日可能未收盘，需要修正 |
| `>` 锚点 | INSERT（真正的续拉） | — |

**验证方式**（`_smoke/p3/`，真实库全程只读，只在 200 只子集副本库上写）：
`make_subset.py` 造副本 → `test_pull.ts` 跑三个场景 → 12 条断言。

| 场景 | 断言要点 | 结果 |
|---|---|---|
| A 幂等 | 除「每只最后一根」外，历史行**逐字段零改写**；新行日期全部晚于原 max(date) | ✅（17,882 行按"已有"跳过） |
| B 断尾续拉 | 删最后 3 根后能补回 171/180（9 根属 3 只 no-data 票，正确保留）；更早历史仍零改写；preClose 自算自洽 | ✅ |
| C amount 诚实 | 老行 amount 真值未被覆盖；新行 amount=0，**不写 `volume×close` 估算** | ✅ |

**P3 新发现的四条**（P0~P2 都没暴露）：

1. **`no-data` 必须和「故障」分开统计**。约 2.5% 的票（近期大比例除权股）腾讯响应里只有 `day`、没有 `qfqday`。
   这是确定性事实不是故障，重试一万次也一样。故 `ProviderErrorKind` 新增 `'no-data'`：
   不重试、不记熔断、不计入 failed，单列进 `stats.noAdjust`。改之前成功率被误报成 95%，改后 **failed=0 / noAdjust=3**。
2. **真实库在不少票上落后 6 个交易日**（部分票停在 09-21，腾讯已到 09-30）。
   第一次跑 Node 增量就会自动补上——这是换源的第一个实际收益，也说明 baostock 时代的数据本就不完整。
3. **存量库的 `preClose` 在除权日不自洽（14 行）**：baostock 的 preClose 是**未复权**昨收，而 close 是 qfq。
   全库 368.9 万行里 99.995% 自洽，但那 0.005% 错得离谱：
   `sz.301489` 2023-10-25 自算昨收 70.15、库 preClose 35.50 —— 当日涨跌幅用库值算是 **+14.8%，真实是 −41.9%**。
   换源自算后新行会自动修复；老行建议在 P4 冷切换时用一条 `UPDATE ... SET preClose = lag(close)` 统一重算（仅动 14 行）。
4. **成交额缺口会影响涨停池排序**：`limitup.ts:104` 按 `amount desc` 排序，新行 amount=0 会让当日涨停排序退化。
   补救：`pullRunner` 用腾讯快照（字段 `[37]`，单位万元）回填**当日**那根；历史行的 amount 保持 0，
   由 `meta.amountCoverage` 如实暴露给前端。**不要用 `volume×close` 估算**。

---

### 0.7 P4 冷切换：用户可在设置页自选接口（v0.9.4 新增）

P3 打通了写入路径，P4 解决的是**「用户在界面上能自己选拉哪个源」**这件事（对应用户最初那条诉求：
最终用户不需要装 Python/baostock，而且接口要能自选）。

#### 0.7.1 四件落地

| 项 | 落点 | 说明 |
|---|---|---|
| **① 选源偏好** | `registry.setPreferred(cap, id)` + `meta.providerPref.<cap>` | UI 选的源**排序加权**排最前，但不硬绑：首选源正在熔断时照样回退次源，否则一次限流就卡死整批 5400 只 |
| **② IPC + UI** | `data:sourceConfig` / `data:setSourcePreference` / `data:setPullEngine`；`Settings.vue`「数据源」区块 | 名单层 / 快照层各一个下拉 + 状态灯；**日 K 层锁死只读** |
| **③ preClose 重算** | `_smoke/p4/fix_preclose.py`（默认 dry-run，落库前自动备份 573MB 库） | 全库 369.5 万行扫描，偏差 >5% 的异常 **3 行**（不是 §0.6 估的 14 行） |
| **④ 看门狗** | `pullRunner.ts` 空闲看门狗 30s（`QUANTPILOT_IDLE_TIMEOUT_MS`，0=关）+ 快照回填独立超时 20s | 只覆盖 K 线阶段 |

#### 0.7.2 UI 的三层结构（对应拍板 ①②）

```
数据源
├─ 名单（全市场标的清单）  下拉：新浪财经（当前唯一候选）
├─ 快照（实时/最新价）    下拉：腾讯财经 / 新浪财经 / 通达信 TDX（未装可选依赖 → 置灰+说明）
└─ 日 K（历史 K 线）       只读：腾讯财经 · 前复权（qfq）—— 接口固定，不可切换
拉取引擎：Node 内置源（默认，零依赖）| Python / baostock（实验，本机未检测到环境）
成交额覆盖率：xx.xx% —— 诚实缺口，不用 volume×close 编造
```

状态灯三种色：正常 / 熔断（红）/ 需装依赖（灰）。

#### 0.7.3 preClose 实测（比预估少得多，但每行都是真的）

`_smoke/p4/fix_preclose.py` 按「|preClose − 自算昨收| / 自算昨收 > 5%」扫全库，命中 **3 行**：

| code | date | 自算昨收 | 库 preClose | 库里算出的涨幅 | 修好后的涨幅 |
|---|---|---|---|---|---|
| `sz.301489` | 2023-10-25 | 70.15 | 35.4974 | **+14.85%** | −41.88% |
| `sh.688808` | 2026-04-27 | 799.00 | 539.8659 | **+10.14%** | −25.58% |
| `sh.688720` | 2023-12-08 | 58.50 | 41.7956 | **+2.72%** | −26.61% |

修法：`preClose := 上一根的 close`（前/后复权序列里，除权日的"昨收"就是同序列的上一根，
不是 baostock 给的未复权昨收）。`--apply` 落库前自动备份到
`%APPDATA%\quantpilot\backup\quantpilot.db.bak-<时间戳>`，落库后复验剩余异常 0 行。

> ⚠️ 阈值 5% 是**有意保守**：普通分红引发的偏差通常 <1%，那些行改了反而会跟行情软件的
> 显示口径打架（且会影响几千行）。只修「错得离谱、能让涨停池算出假信号」的那几行。

#### 0.7.4 P4 新踩的四条（都是真跑出来的，不是推测）

1. **看门狗必须配 `Promise.race`，用 `Promise.all` 会把正常批次吊死。**
   看门狗正常时永远 pending，写成 `await Promise.all([workers, watchdog])` 后，
   「K 线 1 秒拉完」的批次要空挂到 30s 超时才放行（P3 回归直接被自己杀了）。
   → `race`：正常走完就往下走，超时才中断。
2. **回填阶段不能共用看门狗。** K 线全拉完、只差补当日成交额时，快照源慢了几秒，
   整批就被判成"失败"—— 用户眼看该补的都补上了却弹红字。
   → 回填独立超时 20s（`QUANTPILOT_SNAPSHOT_TIMEOUT_MS`），超时只 warn 少补几行 amount。
3. **探针代码别自己造数据。** 第一次探快照用时 `sh.60 + "01"`（上证**指数**代码）当股票代码，
   返回 60 条畸形数据差点被当成 provider bug。股票代码是 6 位：`sh.600519 / sz.000001 / sz.300001`。
4. **测试库会被"被中断的运行"污染。** 上面第 1 条那次误杀其实已经往子集库里写了 171 行，
   下一次回归的 `A2` 断言（用「amount=0 ⇒ 新行」识别）就误判了。
   → 修了 A2 判据（排除本次运行前就存在的零额老缺口）+ 重建 `subset.db`；
   **跑写入类回归前，`_smoke/p3/work/subset.db` 可能被上一次中断的运行改过，要重建。**

#### 0.7.5 验收

| 检查 | 结果 |
|---|---|
| typecheck（`tsconfig.json` / `tsconfig.node.json` / `tsconfig.web.json`） | 三份全绿 |
| `_smoke/p4/test_sources.ts`（选源偏好 / 锁死层 / 非法切换拒绝） | **9 条断言全通过** |
| `_smoke/p3/test_pull.ts`（在重建的子集库上重跑） | **12 条断言全通过**（看门狗不再误伤） |
| `fix_preclose.py --apply` | 修 3 行，复验剩余 0 行，备份已落盘 |

---

### 0.8 P5 打包收口 + 已知口径偏差名单（v0.9.4）

P4 让用户在界面上「能选源」，P5 干两件事：**把新通道真正装进安装包并冷启动验证**，
以及**给存量库那几行口径偏差留一份可查的档案**。

#### 0.8.1 通道收编：新三条不再硬编码字符串

`src/shared/constants/channels.ts` 原本没有这三条，router 里直接写了 `'data:sourceConfig'` 字面量，
违反项目自己定的「禁止在业务中硬编码通道名」铁律。P5 统一收编：

```
IPC.SOURCE_CONFIG          = 'data:sourceConfig'
IPC.SET_SOURCE_PREFERENCE  = 'data:setSourcePreference'
IPC.SET_PULL_ENGINE        = 'data:setPullEngine'
```

`ipc-router/index.ts` 与 `stockStore.ts` 改用常量。`preload.ts` 本就是通用 `invoke<C extends IpcChannel>`，
通道名由 `IpcChannel = keyof IpcRequestMap` 静态约束 —— **无需改白名单**，这也是当初设计它而非
逐通道摊开的好处。

#### 0.8.2 已知口径偏差名单（用户点名要的）

**为什么是「名单留档」而不是「每次扫描现算」**（P4 直接教训）：

> P4 扫出 3 行、修完复验归零。修完**再扫一次一个都扫不出来了** —— 偏差消失了，
> 但「这库曾经有过这类坑、坑长什么样、怎么修的」如果只写在文档里，下次换源重灌还会重蹈覆辙。

名单结构 `meta.knownAdjustBias`（JSON 数组），4 条：

| code | date | kind | status | 内容 |
|---|---|---|---|---|
| `sz.301489` | 2023-10-25 | preClose-unadjusted | fixed | 库里涨跌幅算成 +14.85%，真实 −41.88% |
| `sh.688808` | 2026-04-27 | preClose-unadjusted | fixed | 错算 +10.14%，真实 −25.58% |
| `sh.688720` | 2023-12-08 | preClose-unadjusted | fixed | 错算 +2.72%，真实 −26.61% |
| `*` | — | missing-qfq | **retained** | 一条「已证伪」留档，见下文 |

写入脚本 `_smoke/p5/seed_adjust_bias.py`（默认 dry-run，`--apply` 才落库，幂等）。
读取逻辑抽到 `src/main/services/adjustBias.ts`（**顶层不 import electron**，才能在 `_smoke` 下脱离主进程跑断言），
三档回落：

1. `meta.knownAdjustBias` 有 → 用库内存档（最权威）；
2. 没有 + `meta.dataSource === 'baostock'` → 回落内置基线 `KNOWN_BASELINE`（描述「baostock 存量库迁移时必然带的那几行」）；
3. 其余（全新库 / 已重灌）→ **空数组**，UI 就不显示这块 —— **绝不为让界面好看去编一条**。

设置页在「数据源」区块底部如实列出（黄框、注明「留档，非实时检测结果」）。

#### 0.8.3 ★ 一条过期结论被推翻（P5 实测）

`providers/types.ts` 里 `no-data` 的注释原本写着：

> 实测集中在近期大比例除权股，约 2.5%，腾讯响应里只有 `day` 没有 `qfqday`。

**2026-10-06 实测：这条已不复现。** 对 `sz.301489` / `sh.688808` / `sh.688720`
（3 只历史命中过的除权票）加 `sh.600519` / `sz.000001` 两只对照，用「近 6 根 /
`from=2023-10-01` / `from=2024-01-01`」三种打法打腾讯 fqkline：

```
[qfq] keys=qfqday/qt/mx_price/prec/version
      qfqday:320行 2025-06-12~2026-09-30 列数=6      ← qfqday 一直在
[none] keys=day/qt/mx_price/prec/version
      day:320行 2025-06-12~2026-09-30 列数=6
```

`qfqday` **始终存在**，且 close 与存量库逐位一致（`sz.301489` 2026-09-30 = 108.41）。
另外发现腾讯**忽略 `from` 参数**：三种打法返回同一段（末 320 根），所以「跨除权日窗口」也不是触发条件。

根因是 fqkline 换过端点（老 `web.ifzq.gtimg.cn` 被 WAF 拦，现在走 `proxy.finance.qq.com`），
P2/P3 的口径观测是在**老端点**上做的。

→ `no-data` 分类逻辑**保留**（响应里缺该复权口径时确实该判它、不重试、保留库内原数据），
但不再是「除权股专属症状」；注释、错误信息文案、名单留档三处都已同步。
那种「2.5% 的票拉不到」造成的库缺口，实际只影响那 3 只票的**老行**（保留原数据，符合 P2/P3 结论）。

#### 0.8.4 P5 新踩的四条

1. **`electron-builder` 不会帮你跑 `vite build`。**
   只敲 `npx electron-builder --win` 也能出包成功，但打进去的是**上一次构建的老产物**
   （本项目 10:08 构建过、10:25 又改了源码 → 旧代码被打进 0.9.4）。
   → 必须用 `npm run dist:win`（`build && electron-builder`），或至少「改完源码先 build 再 package」。
2. **沙箱里 `spawnSync` 一律 `EBUSY`。** 想用子进程（node -e / python -c）读真实库验证 meta，
   两种写法都是 `spawnSync xxx EBUSY`。
   → 正解：Node 22 内置 **`node:sqlite`**（`new DatabaseSync(path,{readOnly:true})`），
   零原生模块、零子进程，实测直接读得到 600MB 真实库。
   > 顺带两条死路别绕：项目 `node_modules` 里的 better-sqlite3 是编译给 Electron 的 **ABI 125**，
   > Node 22 是 **127**，本进程加载直接报 `NODE_MODULE_VERSION` 不一致（P3 也踩过）。
3. **`no-data` 的旧注释会误导后来人。** 见 §0.8.3 —— 注释里写「实测集中在除权股」，
   后来照着这个结论去怀疑数据源、去给数据源打补丁，全是白费（真因是端点换过）。
   → **观测结论必须写进代码注释并标日期，接口形状变了要回头改注释。**
4. **版本号改完记得 `package-lock.json` 也要改。** 本次 `0.9.3 → 0.9.4`，两者根与
   `packages[""]` 四处都要同步，漏一处 `npm ci` 就会装回旧版。

#### 0.8.5 验收

| 检查 | 结果 |
|---|---|
| typecheck（`tsconfig.node` / `tsconfig.worker` / `tsconfig.web`） | 三份全绿 |
| `_smoke/p5/test_adjust_bias.ts`（解析 / 回落 / 基线内容 / 真实库回读） | **23 条断言全通过** |
| `_smoke/p4/test_sources.ts` 回归 | 9 条全通过（未受影响） |
| `seed_adjust_bias.py --apply` | 回读 4 条，复跑不覆盖（幂等） |
| 产物 | `release/QuantPilot-Setup-0.9.4.exe` + blockmap |

---

### 0.9 v0.9.5：设置页改成左侧边栏 + 彻底移出 Python 桥

#### 0.9.1 设置页：顶部「定时任务」→「设置」，页内左栏分两页

原先顶部导航最后一项直接叫「定时任务」，点进去是一个**上下叠放**的长页面
（上半「定时任务与推送」，下半「数据源」，要滚很久才能看到换源的地方）。v0.9.5 改成：

```
顶部导航：… 回测 | 设置 | 个股
└─ /settings（meta.title 同步改「设置」）
   ├─ 左侧边栏 w-36：数据源（默认选中） / 定时任务
   └─ 右侧内容：v-if tab==='scheduler' 显示定时任务表单
                 v-else           显示数据源三层 + 拉取引擎 + 偏差名单
```

动线按使用顺序排：**先进「数据源」（行情从哪来），再看「定时任务」（几点跑）**。
改名同步 4 处：`App.vue` 导航、`routers/index.ts` 的 `meta.title`、`menu.ts` 菜单项、`tray.ts`「打开 设置」。
`onMounted` 仍同时预加载调度器与源配置，切页即时显示、不会闪「正在读取…」。

#### 0.9.2 打包不再带 Python 桥（extraResources 清空）

`electron-builder.yml` 里 `extraResources` 原本有一条 `from: python → to: python`（57 KB）。
**v0.9.5 直接删掉**（托盘图标 `assets/icon` 那条保留，它是运行期要用的）：

```yaml
extraResources:
  # 托盘图标（运行期 resources/icon/tray.png，缺失时 tray.ts 回退内置 base64 图标）
  - from: assets/icon
    to: icon
```

> ⚠️ 实测体积账要说实话：这条只省下约 **57 KB**（`python/` 本身太小），**不是「几十 MB」**。
> 删它的价值不在瘦身，而在**把「最终用户不需要 Python」这条承诺落死**——
> 包里不再有任何 baostock 痕迹，用户拆包也找不到。

配套三处，避免「按钮还在、点了空跑」：

| 位置 | 改动 |
|---|---|
| `dataService.pythonScriptReady()` | `statSync(PY_SCRIPT).isFile()`，判定桥脚本是否真在 |
| `dataService.setEngine()` | 切 `'python'` 先查脚本 + 解释器，缺任一个就 `return { ok:false, error }`，**不写 meta** |
| `SourceConfig.pythonScriptReady` | 新增字段，`Settings.vue` 据此把「Python / baostock（实验）」按钮置灰，并注明「安装包未附带 Python 数据桥」 |

`python/` 目录**仍留在仓库里**给 dev（`app.isPackaged === false` 时读项目根），
双轨代码与 `pullEngine` 开关都保留 —— 清的是「随包发布」，不是「代码存在」。
`data:setPullEngine` 的响应类型随之扩成 `{ ok, error? }`，被拒时 UI 如实弹原因（不静默）。

#### 0.9.3 本轮新踩的两条

1. **只删 `extraResources` 会让设置页留一个假按钮。**
   `detectPython()` 只探「本机有没有 Python 解释器」，跟包里有没有桥脚本**是两回事**；
   dev 机上按钮亮着很正常，打包后照样亮着，用户点了只会跑出一个 ENOENT 的抓取。
   → 必须再补一层「脚本在不在位」的判定（`pythonScriptReady`），两条件合起来才放行。
2. **`<template v-if/v-else>` 包面板后，整段要 +4 缩进。**
   用一次性脚本按首尾标记批量加空格（跳过空行，免留尾随空白），跑完即删；
   之后用「标签开闭配平 + `vue-tsc` 模板编译」两道自检确认没包坏。

#### 0.9.4 验收

| 检查 | 结果 |
|---|---|
| typecheck（`tsconfig.node` / `tsconfig.worker` / `tsconfig.web`） | 三份全绿 |
| 设置页模板 | `vue-tsc` 编译通过（v-if / v-else 配对正确） |
| 版本 | `package.json` + `package-lock.json` = **0.9.5**（根与 `packages[""]` 均已核对） |
| 产物 | `release/QuantPilot-Setup-0.9.5.exe` + blockmap |
| 包内容 | 解包 asar 已确认不含 `python/`，`resources/python` 缺失 → UI 置灰 + 拒绝切换 |

---

### 0.10 v0.9.6：把界面上残留的「baostock 逐只拉取」清干净

#### 0.10.1 主子眼见的问题

点「增量更新数据」时，仪表盘进度条右侧挂着一行 **`baostock 逐只拉取，可先去「A股行情」页面查看已有数据`**。
但那份日志里跑的明明是 Node 路径：

```
[2026-10-06 11:00:33] [pullRunner] K 线阶段结束（done=5224/5224），摘掉看门狗
[2026-10-06 11:00:34] [pullRunner] 完成 inserted=0 updated=5125 skipped=3684142 failed=0 noAdjust=99 amountBackfilled=0
```

`failed=0` 且日志前缀是 `[pullRunner]`（`runNodePath` 的唯一入口日志）→ **这次增量更新全程没碰 Python**。
所以那行字是**纯文案 bug**：历史遗留的写死字符串，与真实引擎脱钩，会让人以为迁移没做完。

#### 0.10.2 改法：引擎字段下沉到 `data:status`，文案按引擎分叉

| 文件 | 改动 |
|---|---|
| `shared/types/ipc.ts` | `DbStatus` 增字段 `engine: PullEngine`（默认 `'node'`） |
| `main/services/dataService.ts` | `getStatus()` 的**内联返回类型**补 `engine: PullEngine`（缺这行会直接报 TS2353），返回值补 `engine: pullEngine()` |
| `renderer/stores/stockStore.ts` | `dbStatus` 初值补 `engine: 'node'`；`pullHistory` 的两条兜底文案去掉 baostock 字样 |
| `renderer/views/Dashboard.vue` | 进度条右侧改为 `{{ progressHint }}`（computed 按 `dbStatus.engine` 分叉）；「真实行情」徽标 title 改为显示 `provider · adjust`；「检测环境」按钮改名「Python 环境（旧）」并注明默认不走 |
| `renderer/views/LimitUp.vue` | 空态提示改为「点『增量更新数据』用内置接口回填」 |
| `main/services/pullRunner.ts` | 修掉旧注释里「no-data = 近期大比例除权股专属」的错误归因（P5 已证伪） |

进度文案现在如实分叉：

- `engine === 'node'` → 「Node 内置源批量拉取（腾讯财经 · 前复权 qfq），可先去「A股行情」页面查看已有数据」
- `engine === 'python'` → 「Python / baostock 逐只拉取（旧实验路径），…」

#### 0.10.3 本轮新踩的两条

1. **给 `DbStatus` 加字段会同时打三处，缺一处就红。**
   类型（`ipc.ts`）、主进程 `getStatus()` 的**内联返回类型注解**（不是对象字面量！漏了报 TS2353）、
   以及 store 里的初值对象，三处少一个都过不了 typecheck。
   → 加 DbStatus 字段的 checklist：类型 → `getStatus` 签名 → `getStatus` 返回值 → store 初值 → UI 消费点。
2. **「改文案」和「改归因」要一起改，不能只刷界面。**
   `pullRunner.ts` 里那句「no-data ≈ 近期大比例除权股，实测 2.5%」是 P2 时期写死的归因，
   P5 已经实测证伪（新端点一直返回 qfqday），但没人回来改注释——注释比事实更持久地骗人。
   → 凡是「P5 证伪」动过结论的地方，`providers/types.ts`、`pullRunner.ts`、`dataService.ts` 三处同源注释要一起校。

#### 0.10.4 验收

| 检查 | 结果 |
|---|---|
| typecheck 三份（`node` / `worker` / `web`） | 全绿 |
| 调试残留自检 `QP_SMOKE\|smoke\|fromCharCode` | 0 命中 |
| 版本 | `package.json` + `package-lock.json` = **0.9.6** |
| 产物 | `release/QuantPilot-Setup-0.9.6.exe` |

---

### 0.11 v0.9.7：选股从「事件驱动」改成「失效驱动」（指纹缓存）

#### 0.11.1 主子眼见的问题

> 「启动后首页就是仪表盘，会开始选股；如果切换到其他菜单后，再次点击仪表盘，又会自动选股，我觉得这个不妥。」

查出来的不是手滑，是**三条选股路径共用「跑一遍」语义、谁都没有「结果版本」概念**：

| # | 位置 | 问题 |
|---|---|---|
| 1 | `Dashboard.vue:65-69` | `onMounted` 里**无条件** `await store.runScreener()` |
| 2 | `routers/index.ts` + `App.vue:46` | `<RouterView />` 外**没有 `<KeepAlive>`** → 切走 unmount、切回 remount，每次进首页都重新触发 |
| 3 | `strategyService.ts:141` | `screenTask` 并发锁只挡得住「同时」，挡不住「串行重入」——切走再切回时锁早释放了，等于第三次全池扫描（5400 只 × 320 根 ≈ 173 万根） |
| 4 | `stockStore.ts:191` | `pullHistory()` 末尾又无条件 `runScreener()`，与 ③ 叠加 |
| 5 | `schedulerService.ts:57` | 定时任务已是第二条选股路径（定时跑 + 桌面通知 + 飞书），与首页这条互相打架 |

#### 0.11.2 解法（主子拍板三条）

选股本质是 `f(数据 × 策略)` 的**纯函数** —— 输入没变，结果在数学上不可能变。
所以正确姿势是**失效驱动（invalidation-driven）**，不是事件驱动（onMounted 里喊一嗓子）。

1. **指纹命中就不算**：主进程按 `sha1(barTo + barCount + poolLimit + asOf + 启用策略id/参数)` 算 16 位指纹，命中即复用缓存。
2. **落 meta，冷启动也秒开**：`meta.screenCache` 存 `{key, signals, computedAt, dataDate}`，换进程也认；代价是必须防「旧结果冒充新结果」——所以每条缓存都带 `computedAt` / `dataDate`，UI 如实显示。
3. **拉完数据自动重算**：数据变了结果本就该变，指纹里 barTo/barCount 一变就自动失效重算（不用额外写「拉完重算」的胶水）。

#### 0.11.3 落地改动

| 文件 | 改动 |
|---|---|
| `shared/types/ipc.ts` | 新增 `ScreenResult{signals,cached,computedAt,dataDate,key}`；`screener:run` 入参加 `force?`，返回改 `ScreenResult` |
| `strategyService.ts` | 新增 `screenKeyOf()` / `screenCacheHit()` / 内存缓存 / `invalidateScreenCache(reason)`；`runScreener` 顺序改成 **并发锁 → 指纹缓存 → 真算**；算完入内存 + meta 双级缓存 |
| `dataService.ts` | 新增 `saveScreenCache/readScreenCache/clearScreenCache`（走 meta 表，写失败只 warn 不炸链路） |
| `ipc-router/index.ts` | 五处显式失效：`data:pullHistory`、`strategy:configSave`、`strategy:applyPreset`、切数据源、切引擎 |
| `schedulerService.ts` | 走同一出口，指纹命中就复用（定时任务与仪表盘拿到的是同一份结果） |
| `stockStore.ts` | 新增 `screenMeta` / `screening`（与 `loading` 分离，命中缓存不闪「正在运行策略引擎…」） |
| `Dashboard.vue` | 副标题改显「结果基于 X 数据 · 计算于 … · 缓存命中（未重算）」；新增黄框「用新数据重算」；「重新选股」走 `force` |

#### 0.11.4 指纹实证（8/8，真实库 `barTo=2026-09-30 barCount=3694767 poolLimit=0`）

脚本 `_smoke/p7/test_screen_fingerprint.mjs`（Node 22 内置 `node:sqlite` 只读开真实库）：

| 断言 | 结果 |
|---|---|
| ① 同输入两次 → 同指纹 | PASS `ce58ddc5ba793d98` |
| ② barTo 变（拉到新数据）→ 变 | PASS `→ c31884ef…` |
| ③ barCount+1（补历史/修 preClose）→ 变 | PASS `→ b0928306…` |
| ④ poolLimit 0→500 → 变 | PASS `→ 9ad9fbb6…` |
| ⑤ 策略参数变 → 变 | PASS `→ 38bdd7a2…` |
| ⑥ asOf 变 → 变 | PASS `→ 58460677…` |
| ⑦ 指纹形态 | PASS 16 位、只由五项输入决定（**不含 dbPath / 时间戳**，否则换目录或重启就白算） |
| ⑧ 缓存落盘解析 | SKIP（首次选股后才落盘） |

#### 0.11.5 本轮新踩的三条

1. **「并发锁 + 缓存」的顺序不能反**：原来 `screenTask` 锁在前面是对的，但加缓存时很容易把缓存判定提前——那样连点「重新选股」会绕开并发锁各开一个 Worker（几千倍开销）。先锁后缓存。
2. **`cache key` 里绝不能放 dbPath 和 `Date.now()`**：dbPath 随安装目录漂移（换目录白算一次），时间戳会让缓存永远命不中（等于没缓存）。key 只能由「结果本身决定结果」的输入构成。
3. **指纹挡不住「历史数据被就地修正」**：补 `preClose`、改 `amount` 这类操作可能 barTo / barCount 都不变 → 指纹不变 → 必须靠 `invalidateScreenCache()` 显式作废。所以代码里是「指纹自动失效 + 显式失效双保险」，缺一不可。

#### 0.11.6 验收

| 检查 | 结果 |
|---|---|
| typecheck 三份（`node` / `worker` / `web`） | 全绿 |
| 指纹实证 | 8/8（`_smoke/p7/`） |
| 调试残留自检 `QP_SMOKE\|smoke\|fromCharCode` | 0 命中 |
| 版本 | `package.json` + `package-lock.json` = **0.9.7** |

---

### 0.12 v0.9.8：关于窗改成「按内容实测高度自适应」（彻底去滚动条）

**现象**：关于对话框右侧出现滚动条、免责声明末行被截（主子截图 `QuantPilot.exe_20261006_120553.png`）。

**根因：`BrowserWindow` 的 `width/height` 是外框尺寸，不是内容区。**
`about.ts` 原先写 `width:480, height:340`，注释还写着「实测内容实需 ≈309px，340 留约 30px 余量」——
但这个 340 是**外框高**，减掉 Win11 标题栏 32 + 边框后，**内容区只有 ≈306px**；
而 headless 实测内容实需 **330px**（宽度 464 时）→ **溢出 24px → 滚动条**。
那条「实测」注释本身就是外框/内容区混用的产物（→ §6.4 坑 30）。

**选型：两个备选里选了自定义窗口**
- ❌ 原生 About（`app.showAboutPanel`）：Windows 上是**浅色系统风格**，与本项目全深色 UI 割裂；
  且它排不下主子硬要求保留的免责声明全文。
- ✅ 自定义窗口 + **内容实测驱动**：渲染层量出 `[data-about-root]` 的 `scrollHeight` →
  IPC 上报 → 主进程 `setContentSize(宽, 该高度)`。**不再猜高度**，换字体 / DPI / 系统缩放都自动适配。

**改动清单**

| 文件 | 改动 |
|---|---|
| `src/main/about.ts` | 新增 `fitAboutWindow(senderId, height)`：校验 sender → `setContentSize` → `recenter()`；`ready-to-show` **与**首帧上报都就绪才 `show`（不出现「先弹小窗再跳大」）；硬编码高度降级为 `ABOUT_FALLBACK_HEIGHT` 兜底；`resizable:false`（尺寸由内容驱动，可拖只会制造滚动条） |
| `src/main/ipc-router/index.ts` | 注册 `[IPC.FIT_WINDOW]`（守住「唯一 ipcMain.handle 入口」铁律） |
| `channels.ts` / `ipc.ts` / `preload.ts` / `quant-api.d.ts` | 新通道 `window:fitContent` 全链路类型 + `fitWindowHeight(height)` |
| `src/renderer/src/views/About.vue` | 根节点**去掉 `h-full`**（撑满视口时 `scrollHeight` 恒等于窗口高 → 自指死循环）、加 `data-about-root` 锚点；`ResizeObserver` + `rAF` 合并上报；`document.fonts.ready` 后补报一次 |

**验收：12/12 全绿（对着真实 dist 页面实测）**

脚本 `_smoke/p8/probe_about_cdp.mjs` —— CDP 驱动 headless Chrome 加载真实 `dist/index.html#/about`，
注入等价于 preload 的 `quantApi` stub，记录每次 `fitWindowHeight` 上报值：

| 检查 | 结果 |
|---|---|
| 旧几何 464×306（= 外框 480×340） | 内容实需 **330px**，**复现滚动条** ✅ |
| 上报序列 | `[330]`，稳定、等于实需值 ✅ |
| 按上报高度设窗口后 | **无滚动条**（容器内外都无）、内容零裁剪 ✅ |
| 文本完整性 | 免责声明标题 + 关键句 + 版权主体 + 版本号全在位，无错误行 ✅ |

对照图：`_smoke/p8/about_before_old.png`（有滚动条）/ `_smoke/p8/about_after.png`（干净、无空白）。

> ⚠️ 沙箱边界：本机**沙箱里 Electron GUI 进程起不来**（脚本一行都执行不到、零日志零副作用），
> 因此「主进程 `setContentSize` 那一步」没在 Electron 里实跑（逻辑仅一行 + typecheck 覆盖）。
> 想要 Electron 真链路验证，可在**本机**执行：
> ```bash
> npx esbuild src/main/about.ts --bundle --platform=node --format=cjs \
>   --external:electron --outfile=dist-electron/_smoke_about.cjs
> env -u ELECTRON_RUN_AS_NODE npx electron _smoke/p8/verify_about_fit.cjs
> ```
> （脚本走真实 `about.ts` 代码；用完记得删 `dist-electron/_smoke_about.cjs`，否则会被打进 asar）

---

### 0.13 v0.9.9：关于窗加宽到 500 + 右上角挂公众号二维码

**需求（主子）**：窗口加宽到 500px；右上角加 AI问道社公众号二维码，二维码下方文字「AI问道社」。

**改动清单**

| 文件 | 改动 |
|---|---|
| `src/renderer/src/assets/aiwendao-qr.jpg` | **新增**：二维码原图（258×258，27KB；源 `D:\科普自媒体项目\03封面&配图素材\AI问道社公众号二维码.jpg`） |
| `src/renderer/src/assets.d.ts` | **新增**：`*.jpg / *.png / *.svg` 模块声明（渲染层 `types: []`，刻意不引 `vite/client`） |
| `src/renderer/src/views/About.vue` | 顶部行右侧加 `<figure>`：`<img>` 84×84 + `<figcaption>AI问道社</figcaption>`；`alt="AI问道社 公众号二维码"` |
| `src/main/about.ts` | `ABOUT_WIDTH` 480 → **500**；`minWidth` 440 → 470 |

**加宽带来的直接收益：免责声明换行 3 行 → 2 行**
内容实需高度随之从 **330px 降到 312px**，而且窗口**自动跟着缩**（0.12 的自适应改造红利）——
不写死高度，加宽后不会留下一条空白，也不会因为少一行而溢出错位。
「风险自担。」不再被拆到下一行（真机截图里是 `风险自 / 担。`）。

**为什么用 `import` 而不是丢 `public/`**
`vite.config.ts` 未显式设 `base`，但产出 `dist/index.html` 里的引用是 `./assets/...`（相对 base），
说明 `file://` 下相对解析成立。用 `import qrUrl from '../assets/aiwendao-qr.jpg'` 让 Vite 负责
路径与 hash（产物 `aiwendao-qr-du6xCZl2.jpg`），比在代码里硬写 `./qr.jpg` 稳——文件名/目录一变也不会 404。

**验收：19/19 全绿**（同一个 CDP 探针，新增 7 条）

| 检查 | 实测 |
|---|---|
| 宽度已生效 | `viewportW = 484`（= 外框 500 − 边框 2×8） ✅ |
| 加宽确实减少换行 | 免责声明 **3 行 → 2 行**（旧 330px / 新 312px） ✅ |
| 免责声明末行不再被拆 | 末 5 字「风险自担。」占 1 行 ✅ |
| 二维码 `<img>` 在位 | `src = aiwendao-qr-du6xCZl2.jpg`，`alt = "AI问道社 公众号二维码"` ✅ |
| 二维码**真的解码成功** | `naturalWidth = 258`（> 0），渲染 84×84，不是破图 ✅ |
| 位置正确（右上角） | 贴根节点上沿 + 靠右（left 超过根宽 60%） ✅ |
| 下方文字 | `figcaption = "AI问道社"` ✅ |
| 无滚动条 / 零裁剪 | root `scrollH 312 ≤ clientH 312` ✅ |

对照图：`_smoke/p8/about_before_old.png`（旧宽 464 → 3 行 + 右侧滚动条）
/ `_smoke/p8/about_after.png`（新宽 484 + 右上角二维码 + 2 行免责声明）。

**这轮新踩的 3 条坑（→ §6.4 坑 34–36）**：注入脚本里的 `\s` 被模板字符串吃掉、
断言写成「过去的错误状态必须复现」导致假失败、`types: []` 下 import 静态资源要自带 d.ts。

### 0.14 v0.9.12：日 K 真正的韧性 = 腾讯 **host 级 failover**（不放 LOCKED）

**背景（M6 剩余项，受子指示「放开 LOCKED 降级 sina/tdx + amount 回填」）**

动手前先做了 live probe，结论推翻了字面计划——**日 K 没有第二个 qfq 源**：

| 事实 | 证据（2026-10 实测） |
|---|---|
| tencent 是**唯一** `capabilities.dailyBars=true` 的源 | sina / tdx 均为 false，`supportedAdjust` 只有 `none`（不复权） |
| sina 日 K 无复权参数 | `CN_MarketData` 返回字段仅 `day/open/high/low/close/volume` |
| amount **结构性缺失** | 腾讯 fqkline 每根 K 线**只有 6 字段**（`date/open/close/high/low/volume`），第 7 字段不存在；sina 日 K 也无 |
| 备选源都不可用 | 网易 163 `chddata/fqkline` 本机 **502 Bad Gateway**；东财 push2his 空响应（早已被封） |

→ 所以「降级 sina/tdx」不成立：日 K 锁 qfq 时腾讯挂了就是**无 qfq 候选**（`fetchDailyBars`
直接报"没有可用数据源"），放不开放 LOCKED 都一样，**强行开只会造出空候选 bug、不会真降级**；
「amount 回填」则是**源头不吐该字段**，不是代码没做。两者都如实放弃，不硬凑。

**但 probe 挖到一条真冗余（这才是 M6 的正确解）**

代码注释里记着「腾讯老 host `web.ifzq.gtimg.cn` 已被 WAF 拦（501）」——**实测已过时**：

- 老 host **已恢复可用**（HTTP 200），且与主 host `proxy.finance.qq.com` 返回的 qfq
  **逐字节一致**（茅台近 10 日对拍完全相同）——同一腾讯后端的两个入口；
- → **host 级 failover** = 同源同口径的冗余，**不碰 LOCKED、不改复权口径、不污染 qfq 库**。

**改动清单**

| 文件 | 改动 |
|---|---|
| `providers/tencentProvider.ts` | `FQ_URL` 单常量 → `FQ_HOSTS[]`（主 + 老 host）；`getDailyBars` 顺序 failover；`TencentProviderOptions` 加 `fqHosts?` 注入点（仅测试/换 host 用） |

**降级触发条件（关键设计——只在传输层失败时才切 host）**

- **切**：`连接被拒 / 超时 / 5xx / 403 / 429`（传输层，真故障）；
- **不切**：拿到 200 响应后解析出 `no-data` / `param error`——那是**host 无关的确定结论**
  （同一后端两个 host 行为一致，对拍验证过），切了也是白切一遍；
- **WAF 软封单独处理**：WAF 会返回 **200 + HTML 挑战页**（body 非 JSON），`JSON.parse` 会抛 →
  已 try/catch 成 host 级失败再切下一个，否则整个 `getDailyBars` 炸掉、**根本轮不到备用 host**。

**功能测试 PASS 4/4**（真网络 + 故障注入，esbuild 打包跑）

| 场景 | 结果 |
|---|---|
| ① 主 host 正常 | 直通不浪费 fallback，`lastClose=1258.62` |
| ② 主 host 死（连不上） | 切备用 host 成功，`lastClose=1258.62`（与基线**同数据**） |
| ③ WAF 软封（200+HTML） | 检出并切走，备用 host 恰好命中 **1 次** |
| ④ 全部 host 死 | 干净报 `network`，非崩溃/非空 |

②③ 返回的 close 与正常基线**完全一致**＝**降级保真**（同口径铁律）。
真实双 host 回归：`sh600519 vol=3833100`（手×100）/ `sh688496 vol=11410204`（**科创板未被×100**，规则保住）/ `amount=0` 保持诚实。三套 typecheck 全绿。

---

## 1. 现状诊断：baostock + Python 方案的 6 类问题

### 1.1 Python 环境探测脆弱（已在本项目踩过）
`dataService.ts:366-451` 为了保证「能 import baostock 的 Python」做了 4 层穷举
（环境变量 `QUANTPILOT_PYTHON` → `py -0p` 注册表现枚举 → `where python.exe` → 常见安装路径兜底）。
代码注释本身就写着两条血泪：

> 1) **不能用裸命令 `python` 判断**：PATH 里第一个往往是 WorkBuddy 受管 Python / msys64，
>    而用户 `pip install baostock` 装的是另一个解释器。
> 2) **必须用异步 `exec`**，同步 `spawnSync` 在受限环境会直接 `EBUSY`。

即便如此，探测链依然**每机器都可能失败一次**（用户看到"回退演示数据"却不知道为什么）。

### 1.2 单点故障且不可观测
`baostock.com:10030` 现在 TCP 超时。而 Python 侧 `fetch_history()`（`baostock_fetcher.py:150-175`）
在 socket 阻塞时**无法安全中断**，只能靠 Node 侧的「空闲看门狗」（`dataService.ts:510`，默认 180s）兜底。
用户体感：点「增量更新」，等 3 分钟，报「服务端无响应」。

### 1.3 分发负担
- `electron-builder.yml:21-25` 把 `python/` 整个目录 `extraResources` 释放到 `resources/python`；
- 用户机器**必须预先装 Python + `pip install baostock`**，否则永远走 mock 演示数据；
- 打包体积、卸载残留、杀软误报面同时变大。

### 1.4 数据口径写在注释里，且注释是错的（最危险）
```python
ADJUST = "2"  # 后复权        ← baostock 约定：2 = 前复权。
                                 实际上库内存的是「前复权(qfq)」
```
代码 `docstring` 与注释都写「后复权」，实测 `daily.close` 与腾讯 `qfqday` 逐字段一致
（茅台 1258.62 / 平安 11.57 / 宁德 291.11），是**前复权**。
→ **口径结论只能由实盘价格反查得出，不能信注释**（详见 §6 坑 1）。

### 1.5 单位与格式三套口径
| 项 | 存量库 | 腾讯 fqkline | TDX | stock-sdk |
|---|---|---|---|---|
| volume | **股**（3833098） | **手**（38331） | 手（38330） | 手（38331） |
| amount | 元 | 不返回（用 qt 快照补） | 元×1000 | **万元**（479725） |
| 价格 | 元（qfq） | 元（qfq） | **厘**（元×1000） | 元 |
| code | `sh.600519` | `sh600519` | `sh600519` | `600519` + marketId |
| preClose | 有 | **不返回** | 五档有 `lastClose` | 有，但是**复权前** |

### 1.6 preClose 强依赖但所有 K 线源都不给
`strategy/limitup.ts:86` 与 `strategy/indicators.ts:251` 用 `preClose` 判涨停/跌停；
`indicators.ts:251` 遇 `preClose<=0` 直接 `return false`（涨停股会静默消失）。
新源必须**自算「前一根 qfq close」**，且首根置 null —— 这不引入未来函数，安全。

---

## 2. 五套方案横向对比

| 对比维度 | A. `stock-sdk` | B. `node-tdx-market` | C. `cn-stock-api` | D. 自建腾讯/TDX Provider | E. `a-share-mcp` |
|---|---|---|---|---|---|
| 安装方式 | `npm i stock-sdk` | `npm i node-tdx-market` | `npm i cn-stock-api` | 零依赖（Node 18+ 内置） | `npx -y a-share-mcp`（不进依赖树） |
| 是否需要 Python | 否 | 否 | 否 | 否 | 否 |
| 版本 / 维护 | 2.4.6，v1→v2 破坏性重构，活跃 | 0.2.1，2026-06 起 3 个版本 | 0.1.3，2026-06 停更 | 自己维护 | 1.0.1，2026-08 起 |
| 许可 | ISC | MIT（协议移植自 injoyai/tdx） | MIT | — | MIT |
| 数据源 | 腾讯 / 东财（降级新浪） | 通达信 TCP 直连 | 东财 / 新浪 / 雪球 | 腾讯 + 通达信 | 新浪 / 腾讯 / 东财 push2 |
| 运行时依赖 | **零依赖**（运行时） | `iconv-lite` | `axios`（0.1.3 起已清空） | 无 | `@modelcontextprotocol/sdk`、`zod` |
| ESM/CJS | ESM + CJS 双端 | CJS + ESM | **ESM-only**（CJS 需动态 import） | 随项目（本项目 CJS 产物） | ESM（`type: module`，engines>=20） |
| TypeScript 类型 | 完整（自带 .d.ts，含 subpath 类型） | 完整（自带 .d.ts） | 完整（自带 .d.ts） | 自己写 | 无（只是 MCP 服务） |
| 实时行情 | ✅ `quotes.cnSimple` | ✅ **最快**（25ms 2 只） | ✅ `sina.getRealtime` | ✅ | ✅ |
| 全市场批量 | ✅ `sdk.batch.cn()` **5571 只 / 735ms** | ✅ `getStockList` 自动分页（SH 27534 / SZ 24327 条，需自行过滤） | ⚠️ 需手动循环 | ✅ 自写分页 | ❌（逐个工具调用） |
| 历史 K 线 | ⚠️ `kline.cn` 可用但**口径偏 0.05~1.4%** | ✅ 多周期，**但不复权** | ✅ 东财（本机空）/ 新浪 | ✅ 腾讯 fqkline **qfq 零偏差** | ✅ |
| 内置缓存机制 | 有 `stock-sdk/cache`（MemoryCacheStore + cacheThrough） | 无 | 无 | 无（用 SQLite 自己缓存） | 无 |
| 连接方式 | HTTP(s) | **TCP 长连接**（7709 / 7727） | HTTP(s) | HTTP(s) + TCP | stdio（MCP 子进程） |
| 内置容灾 | ✅ provider 级重试/限流/熔断 + kline 源降级 | 自动测速选最快服务器 + 重连 | ❌ | 自己写 | ❌ |
| 内置 MCP | ✅ `stock-sdk mcp`（92 工具 + 7 Skills） | ❌ | ❌ | 自己包一层 | ✅ |
| **本机可用性** | 快照 ✅ / K线 ❌（口径不符） | ✅（不复权） | 东财 ❌ / 新浪 ✅ | ✅✅ | 部分 |
| 适合场景 | 通用首选（快照/榜单/MCP） | 盘中高频实时 | 轻量统一封装、不想自己解析 | **长链路、口径严格、零供应链风险** | 给 AI 工具接数 |

### 2.1 一句话结论
- 要**开发效率 + 全市场批量快照 + 顺带 MCP**：选 **A `stock-sdk`**，但**只用它做快照，别用它的 K 线回填**。
- 要**盘中低延迟五档/分时**：选 **B `node-tdx-market`**，注意它不复权、价格是厘。
- 要**最小体积、最少依赖、口径完全可控**：选 **D 自建 Provider**（本项目最终落地方案）。
- 只是**想在 WorkBuddy 里让 AI 顺手查行情**：选 **E `a-share-mcp`**（`npx` sidecar，不进打包产物）。

---

## 3. 五套最小集成示例（可直接抄进 Electron 主进程）

> 通用约定：所有示例都基于 **Node 18+（本项目 Electron 31 = Node 20）** 与 TypeScript strict（禁 `any`）。
> 每个示例都带错误处理；顶层 `catch` 统一转成 `{ ok:false, error }` 形状，避免主进程崩。

### 3.1 方案 A：`stock-sdk`

```bash
npm i stock-sdk
```

```ts
// src/main/services/providers/stockSdkProvider.ts
import { StockSDK } from 'stock-sdk';
import { SdkError, getSdkErrorCode } from 'stock-sdk/errors';
import type { RawDailyBar, UniverseItem } from './types';

export interface SdkQuote {
  code: string; name: string; price: number; changePercent: number;
  volume: number /* 手 */; amount: number /* 万元，×1e4 得元 */;
}

export interface SdkResult<T> { ok: true; data: T } | { ok: false; error: string }

type Result<T> = SdkResult<T>;

const sdk = new StockSDK({
  retry: { maxRetries: 2, baseDelay: 500 },
  providerPolicies: {
    eastmoney: { timeout: 8000, rateLimit: { requestsPerSecond: 3, maxBurst: 3 } },
  },
});

/** 单只实时行情。腾讯源，毫秒级。 */
export async function quoteOne(symbol: string): Promise<Result<SdkQuote>> {
  try {
    const rows = await sdk.quotes.cnSimple([symbol]);
    const q = rows[0] as SdkQuote | undefined;
    if (!q) return { ok: false, error: `${symbol} 无返回` };
    return { ok: true, data: q };
  } catch (e) {
    // v2 统一只抛 SdkError
    const code = getSdkErrorCode(e);
    return { ok: false, error: `stock-sdk 查询失败(${code}): ${(e as Error).message}` };
  }
}

/** 历史 K 线（⚠️ 口径偏移 0.05~1.4%，禁止用于 qfq 库回填，只做展示/回测验证） */
export async function klineForDisplay(symbol: string, limit = 250): Promise<Result<RawDailyBar[]>> {
  try {
    const raw = await sdk.kline.cn(symbol, { period: 'daily', limit });
    const arr: RawDailyBar[] = Array.isArray(raw) ? raw : (raw as { bars: RawDailyBar[] }).bars;
    return { ok: true, data: arr };
  } catch (e) {
    return { ok: false, error: `K线失败: ${(e as Error).message}` };
  }
}

/** 全市场快照（实测 5571 只 / 735ms），只取「现价」字段，别用它的 prevClose */
export async function marketSnapshot(): Promise<Result<SdkQuote[]>> {
  try {
    const all = await sdk.batch.cn({ concurrency: 5 });
    return { ok: true, data: all as unknown as SdkQuote[] };
  } catch (e) {
    if (e instanceof SdkError) return { ok: false, error: `批量失败(${e.code}): ${e.message}` };
    return { ok: false, error: `批量失败: ${(e as Error).message}` };
  }
}

/** 全市场名单（用于覆盖度核对 / universeSize） */
export async function universe(): Promise<Result<UniverseItem[]>> {
  try {
    const list = await sdk.codes.cn();
    return { ok: true, data: list as unknown as UniverseItem[] };
  } catch (e) {
    return { ok: false, error: `名单失败: ${(e as Error).message}` };
  }
}
```

> **在 `src/main/services/` 中封装的建议**
> 1. 把 SDK 当**无状态工具**用：模块级单例即可，不要放进 `dataService` 里当字段（热重载会泄漏实例）。
> 2. `batch.cn` 的 `concurrency` 给 4~6（实测 5 已经能跑到 735ms 全市场）。
> 3. 所有返回**统一包成 `Result<T>` 判别联合**，让上层用 `if (!r.ok)` 收口，永远不要 `throw` 到 IPC 边界。
> 4. `stock-sdk/errors` 的 subpath 只带错误体系，不拖网络层，适合在 provider 里单独 import。

### 3.2 方案 B：`node-tdx-market`

```bash
npm i node-tdx-market
```

```ts
// src/main/services/providers/tdxProvider.ts
import { TdxClient, KlineCategory, Exchange } from 'node-tdx-market';
import type { RawDailyBar } from './types';

/**
 * TDX 长连接管理。
 * ⚠️ 铁律 1：**必须监听 'error'**，否则 socket 异常会让整个主进程崩溃。
 * ⚠️ 铁律 2：价格是「厘」（元×1000），必须除以 1000；amount 是「元×1000」。
 * ⚠️ 铁律 3：TDX 日 K **不复权**，adjust='none'，绝不能进 qfq 库的降级链。
 */
export class TdxProvider {
  private client: TdxClient | null = null;
  private connected = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly host?: string) {
    this.heartbeat = setInterval(() => void this.ping(), 15_000); // 心跳保活
    this.heartbeat.unref?.(); // 别拖住 Electron 退出
  }

  /** 不传 host 时库会自动测速选最快服务器（实测 pick 到 124.71.187.122 用 99ms） */
  async connect(): Promise<void> {
    if (this.connected) return;
    const c = new TdxClient({ autoReconnect: true, host: this.host });
    c.on('error', (err: Error) => console.error('[tdx] socket error:', err.message));
    c.on('disconnected', () => { this.connected = false; });
    c.on('reconnecting', (addr: string) => console.warn('[tdx] reconnecting ->', addr));
    await c.connect();
    this.client = c;
    this.connected = true;
  }

  private async ping(): Promise<void> {
    if (!this.connected || !this.client) return;
    try {
      const q = await this.client.getQuote(['sh600519']);
      if (q.length === 0) throw new Error('heartbeat 空返回');
    } catch {
      // 心跳失败不强退，交给 'reconnecting' / autoReconnect 处理
      console.warn('[tdx] heartbeat 失败，等待自动重连');
    }
  }

  /** 单只日 K（不复权）。返回「元」为单位、volume 归一到「股」 */
  async kline(code: string, count = 320): Promise<RawDailyBar[]> {
    if (!this.client) await this.connect();
    if (!this.client) throw new Error('TDX 未连接');
    const res = await this.client.getKline({ code, category: KlineCategory.Day, start: 0, count });
    const raw = (res && res.bars) || [];
    // TDX 时间字段是 Date 对象，统一格式化成 YYYY-MM-DD
    return raw.map((b) => ({
      date: toYmd(new Date(b.time)),
      open: b.open / 1000, high: b.high / 1000, low: b.low / 1000, close: b.close / 1000,
      volume: b.volume * 100,      // 手 → 股
      amount: (b.amount ?? 0) / 1000, // 元×1000 → 元
    }));
  }

  /** 五档盘口（批量，一次 80 只内） */
  async quote(codes: readonly string[]): Promise<unknown[]> {
    if (!this.client) await this.connect();
    if (!this.client) throw new Error('TDX 未连接');
    return this.client.getQuote(codes as string[]);
  }

  /** 证券列表（自动分页；SH 27534 / SZ 24327 条，需按 6/0/3 前缀自行过滤） */
  async stockList(exchange: number): Promise<{ code: string; name: string }[]> {
    if (!this.client) await this.connect();
    if (!this.client) throw new Error('TDX 未连接');
    const list = await this.client.getStockList(exchange as 0 | 1 | 2);
    return list.map((i) => ({ code: i.fullCode, name: i.name }));
  }

  /** 主进程 before-quit 必须调，否则 socket 句柄泄漏、进程退不掉 */
  dispose(): void {
    clearInterval(this.heartbeat);
    try { this.client?.disconnect(); } catch { /* 已断开忽略 */ }
    this.client = null;
    this.connected = false;
  }

  private toYmd(d: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
}
```

```ts
// 主进程退出时统一释放
// src/main/main.ts
import { app } from 'electron';
const tdx = new TdxProvider();
app.on('before-quit', () => tdx.dispose());
```

> **Electron 主进程中维护长连接的建议**
> 1. **单例 + 懒连接**：只在第一次真正要拉盘口时 `connect()`，别在主进程启动就连。
> 2. **`error` 监听是强制项**，写成 class 构造函数的第一步。
> 3. `unref()` 心跳定时器，否则心跳会阻止 Electron 退出。
> 4. `dispose()` 挂 `app.on('before-quit')`，并在拉取任务的 `finally` 里也调一次。
> 5. 拉取被用户中断时，不要立刻 `disconnect()`（下轮还想复用），改为「空闲 60s 后自动断」。
> 6. TDX 的 `getStockList` 返回**含指数/基金/债券**（SH 27534 条），必须按 `sh.6` / `sz.0` / `sz.3` 过滤后再当 universe。

### 3.3 方案 C：`cn-stock-api`

```bash
npm i cn-stock-api
```

> ⚠️ **ESM-only**（`package.json` 里 `"type": "module"` 且 `exports` 只有 `import`）。
> 本项目主进程产物是 CJS（`dist-electron/main.js`），**必须用动态 `import()`**：

```ts
// src/main/services/providers/cnStockProvider.ts
import type { RawDailyBar } from './types';

type CnStockModule = {
  eastmoney: { getKline(o: EastmoneyKlineOptions): Promise<RawDailyBarLike[]> };
  sina: { getRealtime(symbols: string | string[]): Promise<Record<string, unknown>>; getKline(o: SinaKlineOptions): Promise<RawDailyBarLike[]> };
  FinanceError: new (...args: unknown[]) => Error;
};
type RawDailyBarLike = { date: string; open: number; close: number; high: number; low: number; volume: number };
interface EastmoneyKlineOptions { symbol: string; market: number; beg: string; end: string; klt?: number; fqt?: number; limit?: number }
interface SinaKlineOptions { symbol: string; scale?: number; datalen?: number; ma?: string }

/** 懒加载，避免启动期就解析 ESM 模块图 */
let mod: Promise<CnStockModule> | null = null;
const load = (): Promise<CnStockModule> => {
  mod ??= import('cn-stock-api') as unknown as Promise<CnStockModule>;
  return mod;
};

/** 东财 K 线（⚠️ 本机 HTTP 200 空 body，会拿到 0 行 —— 必须判空） */
export async function eastmoneyKline(code: string, beg: string, end: string): Promise<RawDailyBar[]> {
  const m = await load();
  try {
    const rows = await m.eastmoney.getKline({ symbol: code, market: code.startsWith('6') ? 1 : 0, beg, end });
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('东财返回空数组（出口 IP 疑似被限）');
    return rows.map(dedupeSinaFields);
  } catch (e) {
    if (e instanceof m.FinanceError) throw new Error(`cn-stock-api 失败(${e.source}/${e.status}): ${e.message}`);
    throw e;
  }
}

/** 新浪实时（需 GBK 已在包内解码；返回对象或数组两种形态都要兼容） */
export async function sinaRealtime(codes: readonly string[]): Promise<Record<string, unknown>> {
  const m = await load();
  const out = await m.sina.getRealtime(codes.map((c) => c.replace('.', '')).join(','));
  return (out ?? {}) as Record<string, unknown>;
}

/** 统一返回字段：东财/新浪/雪球字段名不一致，收敛成我们自己那一套 */
function dedupeSinaFields(r: RawDailyBarLike): RawDailyBar {
  return {
    date: r.date, open: r.open, high: r.high, low: r.low, close: r.close,
    volume: r.volume * 100, // 新浪/东财多为「手」，按项目口径统一到「股」
    amount: 0,              // 该源不一定给额，留 0 由上层补
  };
}
```

> **统一返回字段说明**：`cn-stock-api` 把东财/新浪/雪球收敛成
> `{ date, open, close, high, low, volume, amount, amplitude, changePct, changeAmount, turnoverRate }`。
> 落地时建议**再收敛一层**到本项目的 `RawDailyBar`：
> `volume` 统一「股」、`amount` 统一「元」、`close` 统一「元（qfq）」。
> 雪球源还需先 `xueqiu.setAuth({ xqat, u })`（抓包得来的 cookie），否则取不到数。

### 3.4 方案 D：自建腾讯 Provider（本项目落地方案，零三方依赖）

```ts
// src/main/services/providers/tencentProvider.ts
import type { RawDailyBar, UniverseItem } from './types';

/** 腾讯 fqkline：唯一在本机能同时拿到「复权 + 与存量库逐字段一致」的现成源 */
// ⚠️ 本机能用的只有 proxy.finance 前缀：老端点 web.ifzq.gtimg.cn 已 501（WAF）
const FQ_URL = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get';
const QT_URL = 'https://qt.gtimg.cn/q=';

/** code 必须是 sh600519 这种「不带点」形式，带点会 return {"msg":"param error"} */
function normalize(code: string): string {
  return code.replace('.', '');
}

/** GBK → UTF-8：Node 18+ 内置 TextDecoder 已带 full-icu，无需 iconv-lite */
function gbkToUtf8(buf: ArrayBuffer): string {
  return new TextDecoder('gbk').decode(buf);
}

export interface FetchBarsOptions {
  /** 最近 N 根（增量续拉时给 5~10 就够） */
  limit?: number;
  /** 起始日期（含），用于精确续拉 */
  from?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 单只 qfq 日 K。返回顺序：project 口径 [date, open, close, high, low, volume] */
export async function fetchBars(code: string, opts: FetchBarsOptions = {}): Promise<RawDailyBar[]> {
  const cd = normalize(code);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    // param 格式：<code>,day,[start],[end],[count],[fq]
    // 传 from 用「区间 + 数量上限」口径，不传则只给 count（取最近 N 根）
    const count = String(opts.limit ?? 320);
    const param = opts.from
      ? cd + ',day,' + opts.from + ',,' + count + ',qfq'
      : cd + ',day,,,' + count + ',qfq';
    const url = FQ_URL + '?param=' + param;
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { code: number; data?: Record<string, { qfqday?: string[][] }> };
    const rows = j.data?.[cd]?.qfqday;
    // ⚠️ 三态判定：HTTP 200 + 空 body 是「假成功」，必须判失败
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${cd} 返回空（疑似源限流/被拒）`);
    return rows.map(toRawDailyBar).filter((b) => b !== null) as RawDailyBar[];
  } finally {
    clearTimeout(timer);
  }
}

/** ⚠️ 腾讯列顺序是 [date, open, close, high, low, volume] —— 收盘在第三位，不是第四位 */
function toRawDailyBar(r: string[]): RawDailyBar | null {
  const [date, open, close, high, low, volume] = r;
  const d = Number(date);
  const o = Number(open), c = Number(close), h = Number(high), l = Number(low), v = Number(volume);
  if (!(d > 19000101) || !Number.isFinite(c) || c <= 0) return null;
  // 不等式断言：源换了/列序错位时空数据立刻暴露，而不是静默写脏库
  if (!(h >= Math.max(o, c) && l <= Math.min(o, c) && v > 0)) return null;
  return { date: fmtDate(d), open: o, close: c, high: h, low: l, volume: v * 100 /* 手→股 */ };
}

function fmtDate(n: number): string {
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 实时快照（腾讯 qt.gtimg.cn，可一次批量多只，实测 0.26s） */
export async function fetchQuotes(codes: readonly string[]): Promise<RawQuote[]> {
  const batch = codes.slice(0, 60).map(normalize).join(',');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(QT_URL + batch, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = gbkToUtf8(await res.arrayBuffer());
    return text.split(';')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('v_'))
      .map((line) => parseQtLine(line))
      .filter((q): q is RawQuote => q !== null);
  } finally {
    clearTimeout(timer);
  }
}

/** qt.gtimg.cn 字段：v_sh600519="1~名称~代码~现价~昨收~今开~..." */
function parseQtLine(line: string): RawQuote | null {
  const m = line.match(/^v_(\w+)="(.*)"/);
  if (!m) return null;
  const f = m[2].split('~');
  if (f.length < 10) return null;
  const price = Number(f[3]);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    code: m[1],
    name: f[1],
    price,
    preClose: Number(f[4]) || 0,
    open: Number(f[5]) || 0,
    volume: (Number(f[6]) || 0) * 100, // 手 → 股
    amount: Number(f[37]) || 0,
  };
}

export interface RawQuote { code: string; name: string; price: number; preClose: number; open: number; volume: number; amount: number }

/** 全市场名单：新浪 Market_Center（实测 node=hs_a 共 5571 只，且一并返回昨收） */
export async function fetchUniverse(pages = 1): Promise<UniverseItem[]> {
  const out: UniverseItem[] = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${p}&num=100&sort=symbol&asc=1&node=hs_a`;
    const res = await fetch(url, { headers: { Referer: 'https://vip.stock.finance.sina.com.cn/' } });
    const txt = await res.text();
    if (!txt.trim() || txt.trim() === 'null') break;
    const rows = JSON.parse(txt) as Array<{ symbol: string; name: string }>;
    if (rows.length === 0) break;
    out.push(...rows.map((r) => ({ code: r.symbol.replace(/^(sh|sz|bj)/, (m) => m + '.'), name: r.name })));
  }
  return out;
}
```

### 3.5 方案 E：`a-share-mcp`（MCP sidecar，给 WorkBuddy / Cursor 用）

```json
// ~/.workbuddy/mcp.json（或 Cursor 的 .cursor/mcp.json）
{
  "mcpServers": {
    "a-share": {
      "command": "npx",
      "args": ["-y", "a-share-mcp"]
    },
    "stock-sdk": {
      "command": "npx",
      "args": ["-y", "stock-sdk", "mcp"],
      "env": { "STOCK_SDK_MCP_TOOLS": "full" }
    }
  }
}
```

```ts
// 若想在 Electron 里反向调 MCP（stdio 子进程），最小形态：
import { spawn } from 'node:child_process';
const mcp = spawn('npx', ['-y', 'a-share-mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
mcp.stdout.on('data', (b) => void b); // MCP JSON-RPC 走 stdout，已由 SDK 分包处理
```

> `a-share-mcp` 提供 `get_quote` / `get_kline` / `get_fund_flow` / `get_lhb` 四个工具，
> 数据源是新浪 + 腾讯 + 东财 push2（资金流/龙虎榜）。它**是服务不是库**，别指望 `import`。
> 它 `engines: node>=20`，Electron 31 内置 Node 20 ✓。

---

## 4. Electron 数据层分层架构建议

```
Electron 主进程
├── 数据源层（可插拔，支持切换方案）
│   ├── stock-sdk Provider      ← 全市场快照 / 实时 / MCP / 名单
│   ├── TdxProvider             ← 盘中五档 / 分时（TCP 长连接）
│   ├── tencentProvider         ← qfq 历史 K 线（口径零偏差，回填主力）
│   ├── sinaProvider / cn-stock-api Provider
│   └── breaker + registry      ← 熔断 / 同口径降级 / 注册切换
├── 编排层（pullRunner）        ← 两阶段扫描 / 并发 / 断点续传 / 进度事件
├── 缓存层（SQLite / better-sqlite3，schema 与现状完全一致）
│   ├── shares、daily、meta（+ provider / adjust 两个新 meta 键）
│   └── 单 writer 约定（pullTask 单例锁）
├── IPC（ipc-router，复用现有 data:pullProgress 通道，零新增通道）
└── 渲染进程（Dashboard / Market / LimitUp / StockDetail）
```

### 4.1 为什么要放在主进程

| 理由 | 说明 |
|---|---|
| **没有 CORS** | 渲染进程走 `http://localhost:port`？不，Electron 渲染进程发 HTTPS 请求同样会被同源策略干扰；主进程 `fetch` 无限制。 |
| **原生模块安全** | better-sqlite3 是 `.node`，必须在主进程 `createRequire` 加载（现状 `dataService.ts:20-21`）。 |
| **避免 N 次 IPC** | 全市场 5224 只 × 320 根 = 167 万根 K 线，逐只 IPC 会把渲染进程打死；必须主进程读 DB、Worker 直连。 |
| **生命周期可控** | TCP 长连接、看门狗、写锁、进程退出释放句柄，都是主进程该管的事。 |
| **单例写者** | 全进程只允许一个 writer（现状 `pullTask`），放渲染进程会出现两个写者抢锁。 |

### 4.2 Provider 接口设计（本项目落地版，strict / 禁 any）

```ts
// src/main/services/providers/types.ts

/** 复权口径：只有 'qfq' 允许与存量库混写 —— 这是降级链的硬闸门 */
export type AdjustMode = 'qfq' | 'hfq' | 'none';

/** 传输形态：决定健康探针与 destroy 语义 */
export type ProviderKind = 'http' | 'tcp';

/** 单只日 K。价格=元，volume=股，amount=元，date=YYYY-MM-DD */
export interface RawDailyBar {
  date: string; open: number; high: number; low: number;
  close: number; volume: number; amount: number;
}

/** 库内 code 格式：sh.600519 */
export interface UniverseItem { code: string; name: string }

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface FetchBarsOptions {
  from: string;      // 起始日（含），调用方保证 D0 已在库内
  to?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface ProviderHealth {
  ok: boolean; latencyMs: number; consecutiveFailures: number; lastError: string | null;
}

export interface BatchProgress { done: number; total: number; bars: number; failed: readonly string[] }

export interface MarketDataProvider {
  /** provider 唯一 id，写进 meta.provider */
  readonly id: string;
  /** 铁律：代码后紧跟中文名 */
  readonly displayName: string;
  readonly kind: ProviderKind;
  /** 硬闸门：非 qfq 的 provider 永不进降级链 */
  readonly adjust: AdjustMode;
  /** 源是否自带 preClose；false = 调用方用「前一根 close」自算 */
  readonly providesPreClose: boolean;

  health(opts: { signal: AbortSignal }): Promise<Result<ProviderHealth>>;
  /** 可选：能否独立产出全市场名单 */
  listUniverse?(opts: { signal: AbortSignal }): Promise<Result<UniverseItem[]>>;
  fetchBars(code: string, opts: FetchBarsOptions): Promise<Result<RawDailyBar[]>>;
  fetchBarsBatch(
    codes: readonly string[],
    opts: FetchBarsOptions,
    onProgress?: (p: BatchProgress) => void,
  ): Promise<{ okCodes: string[]; failed: Map<string, string> }>;
  /** TCP provider 必须实现；before-quit / 拉取中断时调用 */
  dispose?(): void;
}
```

```ts
// src/main/services/providers/registry.ts
export interface ProviderRegistry {
  register(p: MarketDataProvider): void;
  /** 取同口径、未熔断的候选源（按 order 排序） */
  candidates(order: readonly string[]): MarketDataProvider[];
  get(id: string): MarketDataProvider;
}

/** 降级链硬约束：order 里出现 adjust!=='qfq' 的源会被过滤掉，
 *  避免「TDX 看着通、实际不复权」把 qfq 库污染成两个口径。 */
export function candidatesFor(reg: ProviderRegistry, order: readonly string[]): MarketDataProvider[] {
  return order
    .map((id) => reg.get(id))
    .filter((p): p is MarketDataProvider => p.adjust === 'qfq');
}
```

```ts
// src/main/services/providers/breaker.ts
const FAIL_LIMIT = 3;
const OPEN_MS = 30_000;

export class Breaker {
  private failures = 0;
  private openedAt = 0;
  get isOpen(): boolean {
    return this.openedAt !== 0 && Date.now() - this.openedAt < OPEN_MS;
  }
  recordSuccess(): void { this.failures = 0; this.openedAt = 0; }
  /** 返回是否允许再试一次（OPEN 期内只允许半开探测 1 次） */
  allow(): boolean {
    if (!this.isOpen) return true;
    // 半开：距打开超过 OPEN_MS 允许 1 次探测
    if (Date.now() - this.openedAt >= OPEN_MS) { this.openedAt = 0; return true; }
    return false;
  }
  recordFailure(): void {
    this.failures++;
    if (this.failures >= FAIL_LIMIT) this.openedAt = Date.now();
  }
}
```

### 4.4 写入层：源没给的字段**绝不覆盖**库里已有的真值

这是换源最容易「静默造假」的一处：腾讯/新浪/东财的日 K 都不给历史成交额，
如果沿用 `INSERT OR REPLACE INTO daily (... amount ...)`，新拉一天就会把那一天的
baostock 真值抹成 0，攒几天之后整列都是 0 —— 不报错、不弹窗，只是 VWMA 和涨停池排序悄悄失真。

正确写法（better-sqlite3 版，`@named` 参数）：

```ts
import type { ProviderBar } from './providers/types';

/**
 * 回写 daily。
 * - amount = 0 表示「本源未提供」，用 COALESCE 保留原值，绝不写 0；
 * - preClose = 0 同理（首根/除权日），保留真值或留空；
 * - 其余字段按 (code,date) 主键 UPSERT。
 */
export function upsertBars(code: string, bars: readonly ProviderBar[]): { inserted: number; updated: number } {
  const d = getDb();
  const tx = d.transaction((rows: readonly ProviderBar[]) => {
    const stmt = d.prepare(`
      INSERT INTO daily(code,date,open,high,low,close,volume,amount,preClose)
      VALUES(@code,@date,@open,@high,@low,@close,@volume,
             COALESCE(NULLIF(@amount,0), (SELECT amount FROM daily WHERE code=@code AND date=@date), 0),
             COALESCE(NULLIF(@preClose,0), (SELECT preClose FROM daily WHERE code=@code AND date=@date), 0))
      ON CONFLICT(code,date) DO UPDATE SET
        open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
        volume=excluded.volume,
        amount = COALESCE(NULLIF(excluded.amount,0), daily.amount, 0),
        preClose = COALESCE(NULLIF(excluded.preClose,0), daily.preClose, 0)
    `);
    for (const b of rows) {
      stmt.run({
        code, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, amount: b.amount, preClose: b.preClose,
      });
    }
  });
  return tx(bars) as { inserted: number; updated: number };
}
```

配套两条：

```sql
-- meta 里记一笔成交额覆盖率，让用户/日志能判断「多少行是真成交额」
-- （v0.9.4 换源后预期：历史≈100%，新增交易日≈0%）
INSERT OR REPLACE INTO meta(key,value) VALUES('amountCoverage', '<覆盖根数>/<总根数>');
```

- `indicators.ts:343` 的 VWMA 遇到 `amount <= 0` 的 bar **跳过加权**（否则 `Σamount/Σvolume*100` 分母为 0 → NaN → 信号全崩）；
- `limitup.ts:104` 的 `b.amount - a.amount` 排序对 0 值退化为按 code 排，属可接受降级，不必强修。

---

## 5. 性能优化建议

### 5.1 全市场扫描的两阶段策略（本项目最终形态）

```
阶段一 · 名单 + 快照（秒级）
   stock-sdk.batch.cn()        → 5571 只 / 735ms，拿现价/昨收/涨停价
   或 新浪 Market_Center       → 分页 57 次，零依赖备选
   ↓ 用快照做「硬过滤」：非 A 股前缀(sh.6/sz.0/sz.3)、停牌、价格异常 → 剔除
阶段二 · 对候选池拉 K 线（分钟级）
   腾讯 fqkline qfq，并发 6    → 外推全市场 1.4 分钟
   只对 stage1 存活的 code 拉  → 通常比全市场少 5~15%
```

> **为什么两阶段**：阶段一用「一次批量请求」打掉大部分噪音（北交所、ETF、B 股、停牌股），
> 阶段二才付网络往返成本。相比「先拉 5224 只 × 1 根再回头补 320 根」，省掉至少一次全量往返。

### 5.2 `batchSize` / `concurrency` 调优区间（实测）

| 源 | 参数 | 实测建议值 | 依据 |
|---|---|---|---|
| `sdk.batch.cn` | `concurrency` | **5** | 5 已跑到 735ms 全市场；再高收益递减且易触发腾讯频控 |
| 腾讯 fqkline（逐只） | 并发 | **4~6**，单只间隔 0，失败重试 2 次 | 旧端点 200 只并发 6 = 3.1s；新端点 63 只并发 6 = 1.4s、中位数 123ms。峰值≈RTT，并发 6 起饱和；**失败率约 1.6%，必须重试** |
| 腾讯 qt.gtimg.cn | 批量上限 | **每请求 60 只** | 一次多只比分多次快一个数量级 |
| 新浪 Market_Center | `num` | **每页 100~200** | 全市场约 57 页 |
| TDX | 连接数 | **1~2 条长连接** | 单连接已 25ms/只；`getStockList` 一次 500~800 条自动分页 |

### 5.3 TDX 长连接管理与心跳保活

1. 单例懒连接 + `autoReconnect: true`（库自带）。
2. `error` / `disconnected` / `reconnecting` 三个事件都挂日志，`error` **必须有监听者**。
3. 心跳 15s 一次轻量 `getQuote(['sh600519'])`，**空返回也算失败**（服务器假连接）。
4. 心跳定时器 `.unref()`，别阻止 Electron 退出。
5. `before-quit` + 任务 `finally` 双保险 `dispose()`。
6. 服务器自动测速（库内置）；若自己传 `host`，建议维护一份候选列表轮流切（本机 6 个里 3 个可达，必须有多候选）。

### 5.4 数据源自动容灾切换实现思路

```
每个 provider 一个 breaker（连续失败 3 → 熔断 30s → 半开探测 1 次）

code 级回退（不是整个任务失败才换源）：
   code A → provider1.fetchBars 失败/超时/空body
          → provider2.fetchBars（同口径 qfq）
          → 仍失败 → 进 failed 集合（对齐现有 PullResult.failed 语义）

任务级熔断：
   连续 N 个 code 全失败 → 触发 breaker，终止本轮并上报「源不可用」，
   避免 5224 次无效重试把看门狗烧干。

硬闸门（最关键）：
   候选源必须 adjust === 'qfq'。TDX（none）即便可达也不进降级链。
```

---

## 6. 选型决策表与迁移路线

### 6.1 决策表

| 如果优先考虑… | 首选 | 次选 | 别选 |
|---|---|---|---|
| **开发效率 + 生态完整性**（全市场批量、类型、CLI、MCP 一次到位） | **A `stock-sdk`** | D 自建 | C（ESM-only + 停更） |
| **盘中实时速度**（五档 / 分时 / 毫秒级） | **B `node-tdx-market`** | 腾讯 qt 批量 | A（延迟数十秒~数分钟） |
| **轻量零依赖 / 供应链可控** | **D 自建腾讯 Provider** | A（`stock-sdk` 运行时也零依赖） | C、B（都要装包） |
| **口径严格一致（不能污染 qfq 库）** | **D 腾讯 fqkline qfq** | — | **A.kline / B（不复权）** |
| **在 WorkBuddy 中通过 MCP 集成** | **E `a-share-mcp`**（sidecar）或 `stock-sdk mcp` | — | 内联进主进程 |
| **长期维护成本 / 可调试** | **D 自建**（自己写的看得懂） | B | A（v1→v2 破坏性，作者一人维护） |

### 6.2 决策树

```
需要什么数据？
├─ 全市场「名单 + 最新价 + 昨收 + 涨停价」 → A.batch.cn（735ms）或 新浪 Market_Center
├─ 「历史日 K 回填」（必须与现库同口径）  → D 腾讯 fqkline qfq（1.4 分钟/全市场）
├─ 「盘中五档 / 分时 / 逐笔」              → B node-tdx-market
├─ 「给 AI 工具查行情」                    → E a-share-mcp（npx sidecar）
└─ 「东财系字段（资金流/龙虎榜/板块）」    → 本机被封，需换 IP 或放弃该字段
```

### 6.3 迁移路线（本项目已执行到 P3）

> **主子拍板口径（2026-10-05）**：
> ① **保留完整 Python 双轨**，不去删 python 桥，改在设置页加**数据源开关**，默认走 Node Provider；
> ② **可切换性只放开「名单 / 快照 / 实时」三层**，日 K 回填层锁死腾讯 qfq（选错 = 复权口径污染 + 要重灌 369 万根）；
> ③ TDX 保留但默认关闭（可选依赖，不装自动 unavailable）。

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0 实测** | `%TEMP%` 装包实测吞吐与口径；补测全市场名单接口 | ✅ 完成（见 §0.2） |
| **P1 Provider 层** | `src/main/services/providers/{types,http,registry,breaker,tencentProvider,sinaProvider,tdxProvider}.ts` + `_smoke/test_providers.ts`；typecheck 三绿、断言全通过 | ✅ 完成（见 §0.4） |
| **P1.5 文档回写** | §0.4 四个实测增量 + §4.4 amount 缺失不覆盖真值 | ✅ 完成 |
| **R1 mock 守卫前置** | 新增 `src/main/services/mockGuard.ts`（纯函数三分法）；`dataService.ts` 换成 `canSeedMock(barCountNow(), meta)` 双闸（pullHistory + seedMockData）；`_smoke/test_mockGuard.ts` 17 条断言全通过 | ✅ 完成（见 §6.4 坑 10） |
| **P2 对拍** | 扩到 **200 只 ×250 根 = 49,217 行**（含 8 只除权股）；`_smoke/p2/{export_baseline.py,reconcile.ts,scan_adjust2.py}`；硬断言全通过 | ✅ 完成（见 §0.5） |
| **P3 写入路径落地** | 新增 `pullRunner.ts`（依赖注入、可脱离 Electron）；`dataService.pullHistory` 改**双轨分发**（默认 Node，`meta.pullEngine='python'` 才走旧路）；`_smoke/p3/` 子在集副本库上跑 3 场景 **12 条断言全绿**；`no-data` 语义分离 | ✅ 完成（见 §0.6） |
| **P4 冷切换** | `registry.setPreferred` 偏好选源（持久到 `meta.providerPref.<cap>`）；IPC 三通道 + `Settings.vue`「数据源」区块（名单/快照下拉 + 状态灯 + 日 K 只读）；`fix_preclose.py` 修 3 行除权日 preClose（已备份）；看门狗 30s + 回填独立超时；`_smoke/p4/test_sources.ts` 9 断言全绿；typecheck 三绿 | ✅ 完成（见 §0.7） |
| **P5 打包收口** | 三条新通道收编进 `IPC` 常量（不再硬编码）；`meta.knownAdjustBias` 已知口径偏差名单（4 条）+ 设置页如实提示；`npm run dist:win` 出 `QuantPilot-Setup-0.9.4.exe`、asar 校验新代码入包、冷启动 0.9.4 干净启动无 error；`_smoke/p5/test_adjust_bias.ts` **23 条断言全绿** | ✅ 完成（见 §0.8） |
| **v0.9.5 设置页收口 + 移出 Python 桥** | 顶部导航「定时任务」→「设置」（App.vue / 路由 meta / menu / tray 四处）；设置页改左侧边栏：默认「数据源」，点左侧「定时任务」出调度表单；`electron-builder.yml` 删掉 `extraResources` 的 python 条目（托盘图标保留），配套 `pythonScriptReady()` + `setEngine` 拒绝 + UI 置灰 + `data:setPullEngine` 回传 error；出 `QuantPilot-Setup-0.9.5.exe` | ✅ 完成（见 §0.9） |
| **P6 文档收口** | README/AUDIT 补「数据源」一节（本文档 §0.4/§0.5/§0.7/§0.8/§0.9 已回写） | ⏳ |

### 6.4 实战坑（33 条，迁移与做 UI 时每一条都会挨）

1. **注释会骗人**：`baostock_fetcher.py` 注释写「后复权」，实际 `ADJUST="2"` = 前复权。
   → 口径只能靠实盘价格反查（茅台 1258.62 / 平安 11.57 / 宁德 291.11 与腾讯 qfqday 逐字段一致）。
2. **code 两种写法**：库里 `sh.600519`，接口要 `sh600519`（带点腾讯直接 `param error`）。
   → provider 入口统一去点、出口统一加点，全都收口在一处。
3. **volume 单位三态**：库=股、腾讯 fqkline=手、TDX=手、stock-sdk=`amount` 是万元。
   → 在 provider 里定死「股 / 元」，写入前做量级断言。
4. **preClose 只能自算**：腾讯/TDX/东财 K 线都不给前收；`indicators.ts:251` 遇 `preClose<=0` 直接 return false，涨停股会静默消失。
   → 自算「前一根 qfq close」，首根置 null；d0 用「本地末根 close」接，别向新源多要一根。
5. **腾讯列序陷阱**：fqkline 行是 `[date, open, close, high, low, volume]`，**收盘在第三位**。
   按 `(open,high,low,close)` 位置映射会得到「高<低」的假数据而不报错。→ 写不等式断言兜底。
6. **HTTP 200 + 空 body = 假成功**：东财 push2/push2his 即是。**解析出空数组必须判失败**，不能写 `lastUpdate`。
7. **TDX 是「看着能用」的坑**：7709 TCP 20~63ms，极易被当成默认源；但它不复权、价格是厘。
   → 没有 `adjust='qfq'` 声明的源不许进降级链。
8. **ESM/CJS 错位**：`tsconfig.node.json` 写 `ESNext + Bundler`（类型层），产物 `dist-electron/main.js` 是 CJS。
   → 只用 Node 内置 `fetch` / `node:net`，别用 `import.meta`、别引 ESM-only 包（如 `cn-stock-api` 要动态 import）。
9. **清库保护必须等价迁移**：`universe_ok` 的 4500 下限 + purge 前 80% 门
   （`baostock_fetcher.py:100-142`）。历史教训是一次截断名单删掉 1100 只。
   名单源不可达时，宁可显示「覆盖度未知」黄条也不清理。
10. **mock 兜底守卫是最后一道闸**（✅ 已修复，见下）：`dataService.ts` 原先行 200 硬编码
    `cur === 'baostock'`，换源后失效 → `seedMockData` 的 `DELETE FROM daily` 会抹掉 369 万根真实 K 线。
    → 判据改成**看库里实打实的行数**：见 `src/main/services/mockGuard.ts`（纯函数，脱离 electron 可单测）。
    ⚠️ 注意**不是**「`barCount > 0` 一律拒」——那样会把「库本身就是演示库」也堵死，用户再也切不回演示视图。
    正确三分法：`barCount === 0`（空库）→ 放行；`dataSource === 'mock'`（演示库）→ 放行重灌；
    **其余（真库）= 一律拒绝**。另：拒绝时必须回传真实 source 而非 `'mock'`，
    否则前端 `isMock` 红标会自打耳光（守卫说没动数据、界面说你看的是假的）。

11. **照抄教程里的旧端点会直接全挂**：网上流传的腾讯 K 线地址是 `web.ifzq.gtimg.cn/...`，
    实测本机已被 WAF 拦（501 + 跳挑战页），只有 `proxy.finance.qq.com/ifzqgtimg/...` 前缀返 200。
    → 「接口地址」这类东西必须现场 `curl` 复验，不能信二手文档（本次踩坑就是先写了旧端点才测出来的）。
12. **「A 股名单」不等于「沪深 A 股」**：新浪 `node=hs_a` 实际含北交所 920xxx，
    baostock 那套前缀过滤（`sh.6 / sz.0 / sz.3`）是**业务口径**不是技术默认。
    → 名单源必须按业务前缀再过滤一次，否则选股池上限、回测池、健康度全对不上。
13. **日 K 源普遍不给成交额**：腾讯只有 6 字段、新浪只有 volume，东财被封 → `daily.amount` 无源可用。
    → 宁可 `amount=0` 并保留旧值（§4.4），也**不要**用 `volume×close` 现算 —— 那是编数据，
    会让 VWMA 和成交额排序看起来「有数」实则全错，比留空更危险。
14. **偶发失败不是异常，是常态**：实测单只 1.6% 失败（超时 / WAF 抖动），全市场就是 ~90 只静默缺失。
    → 必须有单只重试（2 次 + 随机抖动） succeeds 后再换源；只做「源级熔断」是不够的。

**P2 对拍新增三条（2026-10-05，200 只 × 250 根实测）**

15. **同一个接口的 volume 单位会按板块变**：腾讯 fqkline 对**科创板 688** 返回「股」，
    对沪主板 60 / 深主板 00 / 创业板 30 返回「手」。原 provider 一律 ×100 →
    `sh.688496` 等票成交量虚增 **100 倍**（对拍直接打出 `新=1517853000` vs `库=15178530`）。
    → 修法按 code 前缀判定（`cd.startsWith('sh688')`）。
    **教训**：单位归一不能只在 provider 声明里写"我给的是股"，必须拿 Code ≠ 同一个板块的两只票交叉验证，
    否则只有一个板块的样本永远发现不了。
16. **「有没有 qfq」是按票而变的，不是按接口变的**：同一份 fqkline，
    大部分票返 `qfqday`，部分票（实测 **2.5%**，集中在**近期大比例除权股**，
    如 `sh.601091` @2026-09-21 腰斩、`sz.301686` @2026-09-23）只返 `day`（不复权）。
    → 响应里 `qfqday` 为 undefined 时**必须判失败**，绝不能 fallback 读 `day`
    （那等于把不复权数据当 qfq 写库，除权点会算出假涨停）。
    **这条直接决定了不能全量重灌**：重灌会把这 2.5% 票的历史整段抹成"拉不到"。
17. **「两边都是 qfq」不等于「两边一个数」**：baostock 与腾讯是不同的 qfq 实现，
    现金分红累积因子/基准日不同 → 历史越远偏差越大（实测最大约 0.6%，绝对额 ≤0.15 元）。
    → 对拍的验收线不能定成「|Δ|≤0.01 占比 ≥99.9%」，那是个"永远失败"的断言；
    应该分两级：**硬断言**拦数量级/单位错（`|库/新| > 2` 或 `< 0.5` 一条不许有），
    **软报告**记录校准差异分布。详见 `_smoke/p2/reconcile.ts` 的注释。
18. **「没有数据」和「出了故障」必须分开统计**（P3）：坑 16 里那 2.5% 的票，
    一开始被算进 `failed`，成功率直接误报成 95%。但它不是故障——重试多少次响应都没有 `qfqday`。
    → `ProviderErrorKind` 加 `'no-data'`：不重试、不记熔断、不计 failed，单列 `stats.noAdjust`。
    改完 `failed=0 / noAdjust=3`。**凡是"重试也一样"的失败，都不该污染成功率指标**。
19. **存量库的 `preClose` 在除权日本身就是坏的**（P3 体检发现）：baostock 的 preClose 是未复权昨收，
    close 却是 qfq，两者在除权日对不上。全库 368.9 万行里只有 **14 行**中招（99.995% 自洽），
    但错得离谱：`sz.301489` 2023-10-25 自算昨收 70.15 / 库 preClose 35.50 →
    当日涨跌幅用库值算 **+14.8%，真实 −41.9%**。
    → 换源自算后新行自动修复；老行建议 P4 顺手用 `UPDATE ... SET preClose = lag(close)` 统一重算（只动 14 行）。
20. **验证脚本别在循环里调全表查询**（自己的坑）：`filter` 里写 `snapshot(db).get(...)`，
    13.9 万 × 13.9 万 = O(n²)，脚本假死 5 分钟毫无输出。
    → 全表快照必须先取一次存成 Map 再遍历。**另外**断言要防「全失败时恒真」：
    `inserted >= usable * 2` 在 `usable=0` 时永远通过，必须先判 `usable > 0`。

21. **看门狗要用 `race` 不能用 `all`（P4）**：永不 settled 的哨兵 promise 配 `Promise.all`，
    等于「正常完成也要等哨兵 settle」。本项目 K 线 1 秒拉完却被拖到 30s 超时才往下走。
    → `Promise.race([workers, watchdog])`。
22. **可选优化步骤别跟主流程共用看门狗（P4）**：快照回填只是补 `amount`，
    K 线已经全拉完时它慢几秒，不该把整批判成失败（UI 上就是"该补的都补了却弹红字"）。
    → 回填走独立超时，超时只 warn。
23. **「测试库」会被上一次中断的运行写脏（P4）**：`subset.db` 上跑过一次被 watchdog 中断的拉取，
    那 171 行已经落库，下一次回归的断言就会基于脏基准误判。
    → 写入类回归前重建 `_smoke/p3/work/subset.db`；且「amount=0 ⇒ 新行」这种判据要先排除
    「本次运行前就存在的老缺口」，否则库经历任何一轮写入后判据就废了。
24. **dry-run 脚本默认别写库（P4）**：`fix_preclose.py` 默认只读扫描，加 `--apply` 才落库，
    且落库前先整库备份（573MB 一次）再修 3 行。改存量数据的脚本一律这个形状。

25. **`electron-builder` 不会帮你跑 `vite build`（P5）**：只敲 `npx electron-builder --win`
    也能「成功出包」，但装的是**上一次构建的老产物** —— 本项目 10:08 构建、10:25 又改了源码，
    旧代码就那么被打包成了 0.9.4，而且看起来一切正常。
    → 一律用 `npm run dist:win`（`build && electron-builder`），或把「改完源码先 build」写进检查表。
26. **「扫描现算」查不出「过去修过什么」（P5）**：P4 靠 5% 阈值扫出 3 行修完，之后再扫一个都没有了。
    → 结论要落库成名单（`meta.knownAdjustBias`），UI 只做如实提示；别指望下一次扫描还能复现。
27. **观测结论写进代码注释会过期，必须标日期（P5）**：`providers/types.ts` 里
    「no-data 集中在除权股、约 2.5%」这条注释实际是老端点时代的观察，端点换过后已不复现，
    还写在注释里会让后来人去「修」根本没坏的数据源。
    → 凡是「实测 xxx」的注释，一律带上日期与端点/复本信息（P5 已在注释里写明 2026-10-06 复验结论）。

28. **删掉一个「随包资源」后，UI 上对应的开关会变成假按钮（v0.9.5）**：
    `pythonScriptReady()` 之前只有 `detectPython()`（探解释器），删了 `extraResources` 的 python 之后
    打包版里「Python / baostock（实验）」照样是亮的，点了只得到一个 ENOENT 的空跑。
    → 「能不能用」必须同时判**能力存在**（解释器）与**资源在位**（脚本文件）两个条件，
    缺任一个就置灰按钮 + 在主进程 `setEngine` 里拒掉（返回 `ok:false`，不写 meta）。
29. **删除类配置改动要如实算账（v0.9.5）**：清 `extraResources` 的 python 只省约 **57 KB**，
    不是「几十 MB」。删它的真实价值是把「最终用户不需要 Python」这条承诺落死（包里再无 baostock 痕迹），
    不是瘦身。→ **预估收益前先 `du -sh` 量一下**，别把「顺手清理」包装成「大幅瘦身」。

30. **`BrowserWindow` 的 `width/height` 是外框，不是内容区（v0.9.8）**：
    关于窗写死 `height: 340` 并注释「实测内容实需 309px，留 30px 余量」，看着很严谨，
    实际 340 是**外框**高 → 内容区只有 ≈306px，而内容实需 330px → 滚动条。
    → 要么 `useContentSize: true`，要么（更好）让内容驱动窗口尺寸：
    渲染层量 `scrollHeight` → 上报 → 主进程 `setContentSize`。别再手算像素。

31. **自适应窗口的测量锚点不能带 `h-full`（v0.9.8）**：
    根节点 `h-full` 会撑满视口，此时 `scrollHeight === 视口高`，
    上报值永远等于当前窗口高 → 窗口永不调整（**自指死循环**，且完全静默）。
    → 要量「内容高度」，根节点必须在高度上回归内容（不设 `height:100%`），
    并给一个显式锚点属性（本项目 `data-about-root`）。

32. **`documentElement.firstElementChild` 是 `<head>`，不是内容根（v0.9.8）**：
    想定位页面内容根元素时，靠 `firstElementChild` 猜 DOM 结构必然踩空
    （第一次探测就量到 `<head>`，`scrollHeight = 0`）。
    → 用显式锚点属性定位，别猜层级。

33. **`file://` 下 `<script type="module" crossorigin>` 会被 Chrome 当跨源拦掉（v0.9.8）**：
    Electron 里能正常跑（`loadFile`），但 headless Chrome 直接打开 `dist/index.html` 会**白屏**
    （模块脚本不执行、`#app` 为空），极易被误判成「组件坏了」。
    → 本地验证一律起个 HTTP 伺服 `dist/` 再访问（`http://127.0.0.1:PORT/#/about`）。

34. **注入浏览器的脚本是「模板字符串拼出来的」，里面 `\s` 必须双写 `\\s`（v0.9.9）**：
    CDP 探针函数体是 `.mjs` 里的模板字面量，写 `/\s/` 会被模板解析吃成 `/s/`
    （未知转义序列 → 保留字符本身），「判尾部空白」悄悄变成「判字母 s」——
    **不报错、不崩、只是结果错**，属于最难查的一类。
    → 所有注入代码里的 `\s` `\d` `\n` `\\` 一律双写；改完 grep 一遍 `\s` 再跑。

35. **别把断言写成「过去的错误状态必须复现」（v0.9.9）**：
    首版断言「旧宽度 464px 下末 5 字必然跨 2 行」，真机截图里确实是「风险自 / 担。」，
    但沙箱 headless 的字体栈与真机不同 → 断点前移一个字，断言**假失败**，
    差点被误读成「加宽没用/坏了」。
    → 断言要打在**与字体无关的客观量**上（本次改成「免责声明行数 3 → 2」，
    并保留 `discTailLines` 作为参考数据不参与判定）；字体相关的观感交给截图人工看。

36. **`types: []` 的 tsconfig 下，import 静态资源要自带 d.ts（v0.9.9）**：
    渲染层刻意不引 `vite/client`（保持类型面最小），于是
    `import qrUrl from '../assets/aiwendao-qr.jpg'` 在 `vue-tsc` 下报 TS2307。
    → 新建 `src/renderer/src/assets.d.ts`，声明 `*.jpg` / `*.png` / `*.svg` 默认导出 `string`。

---

## 7. 参考资料（来源）

| 方案 | 来源 |
|---|---|
| A `stock-sdk` | https://www.npmjs.com/package/stock-sdk · https://github.com/chengzuopeng/stock-sdk · https://stock-sdk.linkdiary.cn（ISC） |
| B `node-tdx-market` | https://www.npmjs.com/package/node-tdx-market · https://github.com/interstellarmt/node-tdx · 协议参考 `github.com/injoyai/tdx`（MIT）、`github.com/mootdx/mootdx`（MIT） |
| C `cn-stock-api` | https://www.npmjs.com/package/cn-stock-api · https://github.com/raclen/cn-stock-api（MIT） |
| E `a-share-mcp` | https://www.npmjs.com/package/a-share-mcp（MIT） |
| 腾讯行情接口 | `qt.gtimg.cn`（实时快照，GBK）/ `proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get`（**可用**）/ `web.ifzq.gtimg.cn/...`（**已 501，勿用**） |
| 新浪行情接口 | `hq.sinajs.cn` / `vip.stock.finance.sina.com.cn` Market_Center（需 Referer） |
| 通达信协议 | TDX TCP 7709（A 股）/ 7727（扩展行情） |

> 本文所有代码为教学示例，最终选型与是否落地由主子决定；示例中的网络接口可能随时调整，
> 上线前请自行复核（本项目实测数据见 §0.2，实测时间为 2026-10-05）。
