# QuantPilot · 专业 A 股短线选股桌面软件

技术栈：**Electron + Vue 3 + TypeScript(strict) + Vite + Pinia + TailwindCSS + ECharts + better-sqlite3**

> 当前版本：**v0.9.20 · 1.0 功能全部落地**（数据层去 Python 迁移 P0–P6 完成 + 四大工作台 M1–M6 完成）。
> 下方「阶段一~七」为历史交付日志，最新功能总览见下节。

## 功能总览（v0.9.20）

### 行情数据层
| 能力 | 说明 |
|---|---|
| 日 K | 腾讯财经前复权 qfq（`proxy.finance.qq.com` 主源 + `web.ifzq.gtimg.cn` 备用源，**同源 host 级 failover**） |
| 名单 / 快照 | 新浪（hs_a 全市场名单，含北交所过滤） |
| 板块 | 新浪行业板块（49 个行业，含涨幅/成交额/领涨股 + 成分股） |
| 数据诚实化 | 成交额 `amount` 源不提供即留 0 + `amountCoverage` 如实暴露，**不拿 volume×close 估算造假**；`DbStatus` 明示当前日K源与熔断降级态 |

### 选股引擎
- **7 个内置策略**：均线多头 / 趋势共振 / 断板反包 / N字反包 / 海龟突破 / 均线放量突破 / 上升跌停反包。
- **7 因子评分雷达**（趋势/量能/资金/板块/形态/波动/强度）：**板块轴接 M2 真实板块涨幅**（未刷新板块时回退价格派生代理，UI 如实标注）；回测 `score()` 刻意不注入板块数据（防未来函数）。
- **选股范围**（仪表盘切换）：全市场 / **仅自选池**。
- **指纹缓存**：数据/策略/范围未变则复用结果，切页不重扫。

### 四大工作台
| 页面 | 能力 |
|---|---|
| **仪表盘** | 选股结果（TOP20）+ 雷达图 + 引擎感知进度 + 陈旧结果提示 |
| **市场情绪** | 情绪温度计 0–100（涨停占比/涨跌比/连板高度/打板溢价固定权重）+ 30日曲线 + 连板梯队（**交易所严格涨跌停口径**） |
| **板块 / 行业** | 49 行业涨幅榜（按涨幅/成交额排序）+ 成分股详情（叠加库内行情） |
| **涨停池** | 连板高度 + N天M板（严格口径，含一字板/ST 标注） |
| **我的自选** | 加自选/移出 + 分组 + 成本价→浮动盈亏（比例，**非券商账户**）+ 信号命中联查 |
| **回测** | T+1/手续费/滑点/止损 + **报告维度**（分年/分月收益、持仓期分布、离场原因、**最大回撤区间**、单笔极值）+ **导出 Excel(.xlsx)**（5 表：摘要/分年/分月/交易明细/权益曲线） |

### 诚实性铁律（贯穿全项目）
- **无未来函数**：回测 T+1 次日成交、信号仅依赖截至当日的 K 线；实时板块涨幅**只用于实时选股**，绝不进回测。
- **数据不伪造**：源没有的字段留空并如实暴露覆盖率，不估算。
- **不虚构模块**：`fund`（资金流）无真实数据源，维持价格派生代理值并显式标注，不假装是主力净流入。

## 目录结构

```
quantpilot/
├── src/
│   ├── main/                # Electron 主进程（Node/TS）
│   │   ├── ipc-router/      # 类型安全 IPC 统一注册（禁止裸 ipcMain.on）
│   │   ├── workers/         # strategyWorker(worker_threads 计算线程) + protocol(通信协议)
│   │   ├── services/        # dataService / strategyService / schedulerService / computeService(Worker调度) / sectorService(板块)
│   │   └── main.ts
│   ├── preload/             # contextBridge 暴露 quantApi
│   ├── renderer/            # Vue3 渲染进程
│   │   └── src/
│   │       ├── views/       # Dashboard / Market(A股行情) / LimitUp(涨停池) / Sentiment(市场情绪) / Sectors(板块) / Watchlist(我的自选) / StrategyConfig / Backtest / StockDetail / Settings / About
│   │       ├── components/  # SignalTag / StockCard / KLineChart / ScoreRadar / EquityChart
│   │       ├── utils/       # market.ts（行情表纯函数：涨跌配色/格式化/排序/统计，可离线单测）
│   │       ├── stores/      # Pinia
│   │       ├── api/         # 类型安全 quantApi 封装
│   │       └── routers/
│   └── shared/              # 主/渲染进程共享（禁止 any）
│       ├── types/           # stock / signal / strategy / backtest / ipc / scheduler
│       ├── reportCore.ts    # 回测报告分析维度（纯函数，主/渲染进程共用）
│       └── constants/       # channels / strategies(STRATEGY_LABELS 全名 + STRATEGY_SHORT 中文短名)
├── strategy/                # 策略引擎（与 Electron 解耦，可独立 Node 运行）
│   ├── StrategyBase.ts      # 抽象基类：generateSignal + score + backtest
│   ├── indicators.ts        # MA/EMA/高点/低点/DMI(±DI,ADX)/量比/涨跌停/重采样
│   ├── scoring.ts           # 7 因子评分分解（板块轴支持真实板块涨幅注入）
│   ├── backtest.ts          # 通用回测器（T+1/手续费/滑点/止损/止盈，无未来函数）
│   ├── limitup.ts           # 涨停池（连板/N天M板，严格涨跌停口径）
│   ├── sentiment.ts         # 市场情绪（情绪温度/涨跌家数/连板分布，纯本地算）
│   ├── xlsx.ts              # 零依赖 xlsx 生成器（手写 ZIP+XML，供回测导出）
│   ├── MaBullish.ts         # 均线多头 + 量能确认
│   ├── TrendFollower.ts     # 策略A 趋势选股（多周期共振）
│   ├── LimitUpReversal.ts   # 策略B 断板反包
│   ├── NShapeReversal.ts    # 策略C N字反包
│   ├── TurtleBreakout.ts    # 策略D 海龟突破（20日新高+亿级成交+阳线）
│   ├── MaVolume.ts          # 策略E 均线放量突破
│   ├── UptrendLimitDown.ts  # 策略F 上升跌停反包
│   ├── registry.ts          # 策略注册表（统一返回全部策略实例）
│   ├── report.ts            # 回测报告（JSON + HTML；分析维度已抽到 shared/reportCore）
│   ├── mockData.ts          # 可复现合成数据（离线兜底，含拟真公司名池）
│   └── dbPool.ts            # Worker 直连 SQLite 流式取池（免结构化克隆整池）
├── python/
│   ├── baostock_fetcher.py  # [dev 仅保留] 旧 Python/baostock 实验引擎；安装包已不再附带，默认走 Node 内置源
│   └── requirements.txt
├── docs/
│   └── USER_GUIDE.md        # 用户使用文档（面向最终用户）
├── data/
│   ├── *.db                 # SQLite 行情库（运行时生成）
│   ├── reports/             # 回测报告（JSON + HTML，phase2-demo 产出）
│   └── preview/             # 零依赖 Dashboard 视觉预览
├── tsconfig.worker.json     # Worker 线程单独编译配置（→ dist-electron/）
└── electron-builder.yml     # 打包配置（asar/asarUnpack/extraResources/nsis/dmg）
```

## 快速开始

```bash
# 1. 安装依赖（需要 Node 18+；本机无 pnpm 用 npm 亦可）
npm install          # 或 pnpm install

# 2. 开发模式（自动先编译 Worker → Vite 热更新 + Electron）
npm run dev

# 3. 仅验证策略引擎与数据链路（无需 Electron/Python）
npm run strategy:demo

# 3b. 阶段二：6 大策略信号 + 全策略回测对比报告（产出 data/reports/）
npm run strategy:phase2

# 3c. 阶段四：Worker 线程集成测试（选股+回测双链路，真实 spawn 线程）
npm run verify:worker

# 4. 类型检查（strict）
npm run typecheck

# 5. 打包（Windows nsis / macOS dmg；产物在 release/）
npm run dist          # 全平台
npm run dist:win      # 仅 Windows：release/QuantPilot-Setup-0.9.9.exe
```

## 数据源说明

- **默认 Node 内置源（v0.9.4 起弃用 Python/baostock 主链路）**：`pullRunner.ts` 的 `runNodePath()` 经腾讯财经 `proxy.finance.qq.com` 前复权日 K 接口拉取全市场约 5400 只（沪深主板/创业板/科创板，不含北交所）写入 SQLite，**无需本机安装 Python**。安装包已不再附带 Python 数据桥（`electron-builder.yml` 的 `extraResources.python` 已删除），Python/baostock 仅作为 dev 实验引擎（`meta.pullEngine='python'`）保留在源码层，切到该引擎时设置页会如实提示「安装包未附带 Python 数据桥」。
- **三层 Provider 选源**：`MarketDataProvider` + 注册表 + 熔断（Breaker），按 `Capability='universe'|'snapshot'|'dailyBars'` 各自选源；`dailyBars` 层**锁死腾讯 qfq**（`LOCKED={dailyBars:'tencent'}`，非法切换直接 throw），用户偏好 `preferred` 持久化到 `meta.providerPref.<cap>`，某层熔断时自动回退次源。
- **写入语义（诚实、只续不重灌）**：`date < 库内最后一根` 跳过；`==` 执行 UPSERT（`amount` 用 `CASE WHEN daily.amount>0 THEN daily.amount ELSE excluded.amount` 保真）；`>` 才 INSERT；成交额缺口**如实暴露**（`meta.amountCoverage`），绝不 `volume×close` 估算；个别 `no-data`（如大比例除权股）单列统计、不重试、不计失败。
- **已知口径偏差名单** `meta.knownAdjustBias`（4 条：3 条 `preClose` 未复权已修复 + 1 条 `missing-qfq` 已证伪留档）：`adjustBias.ts` 顶层不依赖 electron，解析失败降级为空名单；设置页黄框如实列出并注明「留档，非实时检测结果」。
- **状态诚实标注**：`meta.dataSource` 区分「演示数据 / 真实行情」，状态条与 `DbStatus`（`provider/adjust/amountCoverage/engine`）显式可见，杜绝 mock 冒充真实更新时间或覆盖真实库。
- **设置页「数据源」区块**：三层卡片（日 K 显示「已锁死 · 接口固定 · 腾讯财经 · 前复权 qfq」）+ 状态灯（正常/熔断/探测中/需装依赖）+ 下拉选源 + 拉取引擎两按钮 + 底部成交额覆盖率，全部经 `data:sourceConfig` / `data:setSourcePreference` / `data:setPullEngine` 三通道驱动。
## 架构要点

1. **类型安全 IPC**：`shared/types/ipc.ts` 定义 `IpcRequestMap/IpcResponseMap`，`ipc-router` 用泛型强制 handler 签名，preload 暴露 `window.quantApi.invoke<C>(...)`，**全程禁止 any、禁止裸 `ipcMain.on`**。
2. **策略引擎与 Electron 解耦**：`strategy/` 纯 TS、只吃 `DailyBar[]`，可在 Node 用 `tsx` 直接回测，是阶段一验证数据链路的关键。
3. **零未来函数**：回测时仅把 `date <= 当日` 的 K 线喂给 `generateSignal`，信号与执行分离（T+1 次日开盘成交）。
4. **渲染进程不碰 Node**：所有系统/DB 访问经 preload + IPC。
5. **单向事件推送**：长时间拉取经 `IPC_EVENT.PULL_PROGRESS`（`data:pullProgress`）实时推进度到所有窗口，前端进度条即时刷新。

## 阶段一验证结果（strategy:demo）

- 信号生成：强趋势样本命中均线多头信号（评分 91 / 93），非趋势样本正确过滤。
- 回测：44 笔交易，胜率 100%，期末 21.4 万（10 万起始），最大回撤 0.08%，夏普 13.28（合成数据理想化，仅验证链路）。

## 阶段二交付说明（strategy:phase2）

**6 大策略全部落地**（均继承 `StrategyBase`，实现 `generateSignal` + `score`，禁止未来函数）：

| 策略       | 文件                    | 核心触发条件                                                                  |
| -------- | --------------------- | ----------------------------------------------------------------------- |
| A 趋势选股   | `TrendFollower.ts`    | 均线多头+方向；量能确认；DMI(+DI>-DI 且 ADX>25)；日/周/月多周期共振                           |
| B 断板反包   | `LimitUpReversal.ts`  | 真涨停非一字、5 日仅一板、量能>前日 1.2 倍、振幅>3%；回调守 95% 开盘价且回撤≤5%；站 MA20 向上；首板后 2-5 日反包 |
| C N字反包   | `NShapeReversal.ts`   | 涨停激活股性；调整≤3 日、幅度小；均线多头；回踩 MA5 低吸 / 反包涨停打板                               |
| D 海龟突破   | `TurtleBreakout.ts`   | 20 日新高 + 成交额过亿 + 阳线防诱多；按涨幅降序输出                                          |
| E 均线放量突破 | `MaVolume.ts`         | 均线多头且全向上 + 量能≥MA5×1.5 + 站上 MA20                                         |
| F 上升跌停反包 | `UptrendLimitDown.ts` | MA20 向上的上升趋势中现跌停，次日反包收复（阳线站回 MA20）                                      |

**回测引擎增强**：在原有 T+1 / 手续费 / 滑点 / 止损基础上，新增**止盈（takeProfitPct）**；并将持仓周期改为由回测选项权威控制（`options.holdDays`）。修复一个关键资金结算 bug——个股数据末根强制平仓（`endOfData`），避免持仓在个股无数据的后续日期被权益曲线静默丢弃。

**7 因子动态评分**：`scoring.ts` 输出 趋势/量能/资金/板块/形态/波动/相对强度 七维分解，作为信号 `breakdown` 字段（前端雷达图数据源），综合评分加权汇总。注：资金流向与板块热度为代理值（mock 无真实主力净流入/行业指数），接入真实行情后替换 proxy 即可。

**回测报告（JSON + 可视化）**：`report.ts` 生成

- `data/reports/<strategyId>.json` —— 完整回测结果（净值/成交/指标）
- `data/reports/<strategyId>.html` —— 自包含 HTML（内嵌 SVG 净值曲线 + 回撤水下图 + 买卖点标记 + 成交明细表，无外部依赖，离线可看）
- `data/reports/comparison.html` —— 6 策略横向对比表

**阶段二验证结果**（合成场景数据，10 万起始，手续费 0.03%/滑点 0.1%/止损 7%/T+1）：

| 策略       | 信号 | 交易 | 胜率   | 回撤    | 夏普    | 期末     |
| -------- | -- | -- | ---- | ----- | ----- | ------ |
| 趋势选股 A   | 2  | 47 | 100% | 0.55% | 11.63 | 27.1 万 |
| 断板反包 B   | 2  | 10 | 100% | 0.00% | 4.39  | 10.8 万 |
| N字反包 C   | 1  | 17 | 100% | 0.88% | 1.94  | 13.8 万 |
| 海龟突破 D   | 1  | 7  | 100% | 0.03% | 5.23  | 12.2 万 |
| 均线放量 E   | 2  | 71 | 100% | 0.23% | 15.03 | 39.6 万 |
| 上升跌停反包 F | 1  | 4  | 100% | 0.00% | 3.85  | 10.8 万 |

> 胜率/盈亏比均为理想化（合成数据每笔信号后均设计为正向运动），仅用于验证策略逻辑正确性与链路无未来函数；接入真实行情后指标将呈现真实分布。

## 已知限制（截至阶段二）

- 前端 Dashboard 仍只读 `MaBullish` 占位；阶段二新增的 6 策略尚未在 Vue 前端可视化（阶段三填充策略配置/回测面板/个股详情 + 雷达图）。
- 资金流向、板块热度因子为代理值，需真实数据接入后替换。
- 多标的资金分配仍为单仓顺序（一次一笔），组合层资金曲线在阶段三/四细化。
- Electron 完整构建需在具备网络/Python 的宿主机 `npm install && npm run dev` 验证（沙箱无法联网装包，运行期验证在用户机完成）。

---

## 阶段三交付说明（前端界面 + 集成）

**全部 5 个页面 + 类型安全 IPC 集成完成**，Electron 主进程 / IPC / 渲染进程三层贯通。

### 新增/改造文件

| 层    | 文件                                                            | 说明                                                         |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| 共享类型 | `shared/types/scheduler.ts`                                   | `SchedulerConfig` 定时任务配置                                   |
| 共享类型 | `shared/types/{stock,signal}.ts`                              | 新增 `StockDetail` / `SignalMark`                            |
| 共享类型 | `shared/types/ipc.ts`                                         | 新增 3 通道：`stock:detail` / `scheduler:get` / `scheduler:set` |
| 主进程  | `main/services/schedulerService.ts`                           | 每日定时选股 → electron 通知 + 飞书 webhook 推送                       |
| 主进程  | `main/services/strategyService.ts`                            | 新增 `getStockDetail`（近 240 根 K 线 + 全策略信号标记）                 |
| 主进程  | `main/ipc-router/index.ts`                                    | 注册 3 个新 handler（仍走唯一注册入口）                                  |
| 主进程  | `main/main.ts`                                                | app ready 后 `schedulerService.start()`                     |
| 图表   | `renderer/components/chartOptions.ts`                         | ECharts option 纯函数（K线/雷达/净值）                               |
| 图表   | `renderer/components/{KLineChart,ScoreRadar,EquityChart}.vue` | 三个 ECharts 组件（init/setOption/resize/dispose 防泄漏）           |
| 页面   | `renderer/views/Dashboard.vue`                                | TOP20 卡片网格（评分降序、信号标签、迷你雷达、点击进详情）                           |
| 页面   | `renderer/views/StrategyConfig.vue`                           | 按 `meta.paramSchema` 动态渲染参数 + 启停 + 保存                      |
| 页面   | `renderer/views/Backtest.vue`                                 | 选策略/区间/资金/风控 → 净值+回撤+明细表                                   |
| 页面   | `renderer/views/StockDetail.vue`                              | K 线（均线/量能/信号标记）+ 信号列表 + 筹码/龙虎榜占位                           |
| 页面   | `renderer/views/Settings.vue`                                 | 定时任务开关 + 飞书 webhook + 立即选股                                 |
| 状态   | `renderer/stores/stockStore.ts`                               | 扩展全部页面所需 state/actions                                     |
| 导航   | `renderer/App.vue` + `routers/index.ts`                       | 新增「定时任务」入口                                                 |

### 关键实现点

1. **图表用 ECharts（用户原始要求）**：K 线含 MA5/10/20 + 成交量 + 信号 `markPoint` 按类型配色；雷达渲染 7 因子 `breakdown`；回测页净值 + 回撤水下图。组件在 `onBeforeUnmount` 调 `dispose` 防内存泄漏。
2. **策略配置动态化**：前端不硬编码参数，全部从 `strategy:list` 返回的 `meta.paramSchema`（number/boolean/select 三类）渲染；保存经 electron-store 持久化，下次选股/回测自动 `setConfig` 重载。
3. **定时任务（主进程调度）**：每分钟轮询，命中 `hour:minute` 即运行 `runScreener` → 桌面 `Notification` + 飞书 `fetch` POST。配置持久化，应用启动自动 `start()`。
4. **渲染进程零 Node 访问**：所有数据经 `window.quantApi.invoke<C>()` 类型安全 IPC，无 `ipcRenderer`/`fs` 直连。

### 验证情况（如实说明）

- ✅ **策略引擎层（纯 TS）**：离线 `tsc` 严格编译零错误，阶段一/二 demo 回归全绿，`MaBullish` 补齐 `breakdown` 无破坏。
- ✅ **前后端接口一致性**：已 grep 核对——前端 9 个 `invoke` 通道全部命中 `IpcRequestMap`，响应类型与 Pinia store 字段一一对应。
- ⚠️ **Electron 渲染进程运行期验证**：沙箱 `registry.npmjs.org` 证书被代理拦截，无法 `npm install`（缺 vue/echarts/electron 类型），故 `npm run dev` / `vue-tsc` 需在你本机执行。代码已按 strict + `<script setup lang="ts">` + 类型化 IPC 编写。
- 🔎 **零依赖预览**：`data/preview/dashboard-preview.html` 用自绘 SVG 雷达 + 卡片，复用阶段二真实选股数据，双击即可在浏览器查看 Dashboard 视觉效果（无需安装任何依赖）。


### 运行命令

```bash
cd D:/workBuddySpace/quantpilot
npm install                 # 本机执行（Node18+，Python3+baostock 可选）
npm run dev                # 启动 Electron + Vue 开发环境（含 HMR）
npm run build              # vue-tsc 类型检查 + vite 打包
npm run typecheck          # 严格类型检查（含 vue-tsc）
```

### 已知限制（截至阶段三）

- 筹码分布、龙虎榜为占位实现，需接入真实数据源（东方财富/开盘啦接口）后填充。
- 资金流向、板块热度因子仍为代理值（mock 无真实主力净流入/行业指数）。
- 回测为单标的顺序成交（无组合层资金分配 / 多标的并发限制）。
- 定时任务依赖主进程常驻运行（最小化到托盘亦可）；跨日时区以本机系统时间为准。

---

## 阶段四交付说明（Worker 优化 + 打包 + 文档，v0.4.0）

### 1. 性能优化：Worker 线程计算引擎

重计算（全市场选股 / 历史回测）从主进程移入 **worker_threads 计算线程**，选股/回测期间 UI 不再卡顿：

| 文件                                     | 职责                                                 |
| -------------------------------------- | -------------------------------------------------- |
| `src/main/workers/protocol.ts`         | 通信协议（纯类型，编译期擦除）                                    |
| `src/main/workers/strategyWorker.ts`   | Worker 实体：与 Electron 完全解耦，只依赖 `strategy/` 纯 TS     |
| `src/main/services/computeService.ts`  | 调度：懒创建 Worker → 120s 超时终止 → **任何失败自动回退主进程同步计算**    |
| `src/main/services/strategyService.ts` | `runScreener/runBacktest` 改为 async，Worker 优先、主进程兜底 |

- Worker 由 `tsconfig.worker.json` 单独编译为 `dist-electron/src/main/workers/strategyWorker.js`（`npm run build:worker`，`dev`/`build` 已自动串联）。
- 环境变量 `QUANTPILOT_NO_WORKER=1` 可强制禁用 Worker（调试用）。
- 主进程读 SQLite → 结构化克隆传给 Worker → 返回信号/回测结果；数据流无共享内存依赖。

### 2. 打包适配（electron-builder v0.4.0）

- **asar 开启** + `asarUnpack: **/*.node`（better-sqlite3 原生模块必须解包）。
- **extraResources**：`python/` 释放到 `resources/python`——asar 内的路径 Python 解释器读不到，`dataService` 已按 `app.isPackaged` 自动切换 `process.resourcesPath`。
- **数据库**始终在 `userData/quantpilot.db`（打包后可写、升级不丢数据）。
- Win 产出 `release/QuantPilot-Setup-0.4.0.exe`（NSIS 可选目录 + 桌面/开始菜单快捷方式）；Mac 产出 dmg。暂不启用自动更新（`publish: null`，需要时加 generic 通道）。
- 版本号三段式递增（0.1.0 → 0.4.0），**不同名不覆盖**历史安装包。

### 3. 验证结果（沙箱离线实跑）

- ✅ Worker 编译（tsconfig.worker.json，strict）EXIT 0。
- ✅ **Worker 集成测试**（`npm run verify:worker`，真实 spawn 线程）：选股 11 只×7 策略 → 命中 2 只、评分降序正确、耗时 69ms；maBullish 回测 → 134 笔、期末 55.99 万、耗时 217ms、资金结算正确。
- ✅ 阶段一/二 demo 回归全绿（6 策略信号 + 数据链路）。
- ⚠️ electron-builder 实际打 exe 需联网 `npm install` 后在你本机执行 `npm run dist:win`（沙箱无法装包）；配置已按 better-sqlite3 原生模块 + Python 脚本释放做适配。

### 4. 文档

- `docs/USER_GUIDE.md`：面向最终用户的使用文档（安装/数据回填/选股/调参/回测/定时任务+飞书/常见问题/风险提示）。

---

## 阶段五交付说明（数据回填修复 + 中文信号 + A 股行情页，v0.5.1）

针对用户反馈的三条问题（全量回填后股票数仍显示 201 只 / K 线信号全英文且被图例遮挡 / 缺少本地行情总览页）逐项修复。

### 1. 全量回填真正重建标的池（问题①）

**根因**：旧版①`runPython` 给"全量"硬编码传 `--limit 200`（用户选的范围被丢弃）；②全量只 `DELETE FROM daily` 不清 `stocks`，残留"只登记无 K 线"的脏行 → 股票数虚高成 201。

**修复**：

| 位置                             | 改动                                                                                                                                   |   |                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | - | ------------------------------------------ |
| `python/baostock_fetcher.py`   | 新增 `market_universe()`（合并 codes+names 一次拉取）、`local_codes()`、`purge_non_targets(conn, targets)`（临时表比对后清 `stocks` **与** `daily` 的非目标行） |   |                                            |
| `python/baostock_fetcher.py`   | 新增 `--local-only`：增量＝只续拉库内已有标的，不新增、不受 `--limit` 截断；起点改为 `最后交易日 + 1 天`（旧版"早于窗口就抬到窗口起点"导致每只全窗口重拉）                                      |   |                                            |
| `python/baostock_fetcher.py`   | 进度格式 `progress i/total pct=P bars=N phase=fetch`；统计 `inserted/updated/failed/skipped` 如实返回                                           |   |                                            |
| `main/services/dataService.ts` | 全量传用户选的 `universe`；解析 stderr 进度 → `IPC_EVENT.PULL_PROGRESS` 推给所有窗口；修 `??` 与 \`                                                       |   | `优先级 bug；dev 模式 PY 路径改用`app.getAppPath()\` |
| `renderer/views/Dashboard.vue` | 「范围」下拉（200/500/1000/2000，localStorage 持久化）+ 实时进度条（% + 已写入根数）+ `poolCount` 提示；点全量回填前显示目标只数                                            |   |                                            |

### 2. K 线信号中文 + 不被遮挡（问题②）

**根因**：`label.formatter` 直接输出 `m.strategyId`（camelCase 英文）；同日多策略 pin 全部叠在 `high*1.02`，被图例压字。

**修复**（`renderer/components/chartOptions.ts`）：

- `markLabel()`：按交易日聚合多策略 → 中文短名（单策略用 `STRATEGY_SHORT`，2 个用 `a/b`，>2 个用 `信号×N`）。
- `buildMarkPoints()`：每天 ≤1 个 pin，标签 `position:'top'`、三档错位 `distance:4+(i%3)*12`、深色背景气泡防压字。
- `yAxis[0].max = v => v.max*1.07` 顶部留白、`grid[0].top=58`、`legend.top=2` 给图例与 pin 让位。
- `shared/constants/strategies.ts` 新增 `STRATEGY_SHORT` / `SIGNAL_TYPE_LABELS` / `strategyLabel()` / `strategyShort()`。
- `views/StockDetail.vue`：顶部行情条（最新价/涨跌额/涨跌幅）+ 中文信号汇总与说明。

### 3. 新增「A 股行情」页（问题③）

- 路由 `/market`，导航新增「A 股行情」入口（App.vue + routers/index.ts）。
- 面板字段：代码 / 名称 / 最新价 / 涨跌额 / 涨跌幅 / 成交额 / 成交量 / K 线根数 / 区间。
- 功能：搜索框过滤、按涨跌排序、分页加载更多（每页 200）、涨跌配色（**涨红跌绿**，A 股口径）。
- 后端 `dataService.getMarketList()` 单次 JOIN 计算涨跌幅（不再逐只回捞）；类型新增 `MarketRow`、`PullProgress`。
- 纯函数抽到 `renderer/utils/market.ts`（`pctClass/fmtPct/fmtChange/fmtAmount/fmtVolume/filterMarket/sortMarket/marketStats`），可离线单测。

### 4. 验证情况（如实说明）

- ✅ `typecheck:node` / `typecheck:web` 全绿。
- ✅ `_smoke/test_fetcher.py`：Python 抓取器双向语义（全量清非目标 / 增量只续拉 / 起点续拉）全部通过。
- ✅ `_smoke/test_marks.ts`：K 线信号聚合 + 中文标签（无 `[A-Za-z]{2,}` 泄漏）+ 错位高度断言全绿。
- ✅ `_smoke/test_market.ts`：行情页纯逻辑 16/16 通过。
- ✅ 产物自检：`app.asar` 内可匹配到 `A股行情` / `market:list` / `data:pullProgress` / `信号×` / `确认全量回填`。
- ⚠️ **GUI 运行期未截图验证**（沙箱 Electron 窗口起不来），新增页的视觉细节请你在安装后点「A 股行情」实测确认。

### 5. 打包坑位记录

- 根目录残留 `vite.config.js`（`vue-tsc -b` 时代的产物）会让 Vite 优先加载 `.js` 而忽略 `.ts`，报 `Rollup failed to resolve import "@shared/constants/channels"` → **删掉 `vite.config.js` / `vite.config.d.ts` 后重建即通过**。
- 同时在 main/preload 的 `vite.resolve.alias` 里补 `@shared` / `@renderer` 别名（新增了值导入 `@shared/constants/channels`）。

### 6. v0.5.1 追加：加「全市场」档 + 选股池放开到 5400

用户追问「全量也只拉范围数量吗」——**是的，v0.5.0 的「范围」最高只有 2000 只**，卡在三处：前端 `UNIVERSE_OPTIONS` 最大档 2000、`runPython` 全量必带 `--limit universe`、`POOL_HARD_CAP=2000`。Python 侧 `--limit 0` 本就支持全市场。

| 改动                            | 位置                                | 说明                                                                                       |
| ----------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| 新增「全市场（约 5400 只）」档            | `stores/stockStore.ts`            | `UNIVERSE_OPTIONS` 加 `value: 0`（0 = 不截断），`loadUniverse()` 可持久化 0                         |
| 选股池硬顶 2000 → 5400             | `main/services/dataService.ts`    | 全市场 5400 只 × 最近 320 根 ≈ 173 万根，对齐沪深 A 股；想缩回可用 `meta.poolLimit` / `QUANTPILOT_POOL_LIMIT` |
| `universe=0` 不再被 `\|\|` 吃成默认值 | `dataService.ts`                  | `req.universe ?? (poolLimit() > 0 ? poolLimit() : DEFAULT_UNIVERSE)`，0 是合法值              |
| Worker 超时 120s → 600s         | `computeService.ts`               | 全市场选股常态就是分钟级，120s 会误杀成「回退主进程」（更慢）；可用 `QUANTPILOT_WORKER_TIMEOUT_MS` 覆盖                   |
| 全量跳过「已最新」标的                   | `python/baostock_fetcher.py`      | 全量仍清非目标（股票数准确），但本地已含最新交易日的标的直接 skip，省掉每次重跑的几千次无效请求                                       |
| 文案去「0 只」                      | `Dashboard.vue` / `stockStore.ts` | `universeLabel` 把 0 显示成「全市场（沪深 A 股）」；「重新选股」按钮在全市场档提示耗时数分钟                                |

**口径澄清（回答「什么时候能拉全 A 股」）**：

- 全市场 = `query_stock_basic()` 里 `type=1` + `status=1` 且前缀属于 `("sh.6","sz.0","sz.3")`，即**沪深主板 / 创业板 / 科创板约 5400 只，不含北交所 `bj.`、B 股与已退市股**。
- 回看窗口默认 3 年（`QUANTPILOT_LOOKBACK_YEARS`，0 = 从 2000-01-01 起），全市场首跑约 400 万行 / 20~40 分钟 / 约 300MB。
- 「拉全」≠「全市场选股」：`getScreeningPool` 取 `ORDER BY code LIMIT 硬顶`，每只只取最近 `SCREEN_BARS=320` 根；放开硬顶后单次选股从几十秒升到**数分钟**（Worker 线程内跑，UI 不卡）。回测池仍是 `BACKTEST_POOL_CAP=500`。
- **增量回填永远不新增标的**（目标 = `local_codes()`），新上市股票只能靠全量档进库；增量只做「把已有标的续到最新」。

### 7. 升级提示

- 产物：`release/QuantPilot-Setup-0.5.0.exe`（新包名，不覆盖 0.4.x）。
- 数据库路径不变（`%APPDATA%/quantpilot/`），**升级不丢数据**。
- ⚠️ 你的库当前是旧版全量回填留下的 201 只脏数据，装完 v0.5.0 / v0.5.1 后请在首页**再点一次「全量回填」**（选好范围），新的 `purge_non_targets` 会把 201 清成目标只数并真正重拉。

---

## 阶段六交付说明（模板插值修复 + 关于菜单 + 系统托盘，v0.5.2）

### 1. 修复：全量回填按钮把 `${universeLabel}` 直接印在界面上

**现象**（用户截图）：按钮/tooltip 上出现 `title="= store.universe == 0 ? 选股池 = 全市场约 5400 只…" : ''">重新选股` 这类裸字符串。

**根因（两条，同一处 Edit 造成）**：

1. 在 `<template>` 文本里写了 JS 模板字符串 `` `确认全量回填 ${universeLabel}？` `` —— Vue 模板里 `${}` 不会被插值，只能写 `{{ universeLabel }}` 或字符串拼接。
2. `:title="..."` 三元被错放到了「重新选股」按钮的元素外面，形成悬空属性 → 属性被浏览器"吃掉"成字面文本。

**修复**（`renderer/views/Dashboard.vue`）：

| 改动                                    | 说明                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 新增 `fullTitle` / `poolTitle` computed | `:title` 里塞不下三元 + 模板串，统一抽成 computed；脚本内访问 `universeLabel.value`（ref），模板内直接用 `universeLabel`（自动解包） |
| 按钮文案改字符串拼接                            | `{{ confirmFull ? '确认全量回填 ' + universeLabel + '？' : '全量回填' }}`                                    |
| 合并重复的「重新选股」按钮                         | 一个按钮同时带 `@click` / `:disabled` / `:class` / `:title`，不再有第二个只挂 `:title` 的空壳                        |

### 2. 新增「关于」菜单（版权所有 AI问道社）

| 文件                         | 作用                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `main/appInfo.ts`          | 应用元信息唯一出口：name / version / **copyright = AI问道社** / electron / node                                  |
| `main/menu.ts`             | 自定义应用菜单：`文件`（增量/全量/重新选股/退出）、`视图`（五个页面 + 显示隐藏 + 重载 + DevTools）、`帮助`（**关于 QuantPilot** F1 / 打开本地数据目录） |
| `main/about.ts`            | 关于窗口（620×520 单例，hash 路由 `#/about`，`ready-to-show` 再 show 防白闪）                                       |
| `renderer/views/About.vue` | 关于页：Logo、版本号、版权方块「AI问道社」、技术栈、数据来源、免责声明                                                              |
| `app:info` IPC             | 新增类型安全通道（`AppInfo`），菜单/关于窗/日志抬头同源                                                                   |


### 3. 新增系统托盘

| 文件 / 改动                | 作用                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `main/tray.ts`         | 托盘单例：图标（优先 `assets/icon/tray.png` → 打包态 `resources/icon/tray.png` → 兜底内置 base64）、提示语、点击/菜单还原主窗 |
| 托盘菜单                   | 显示 QuantPilot / 增量更新数据 / 全量回填 / 重新选股 / 五个页面直达 / 关于 / 退出                                        |
| 关窗行为                   | 主窗口 `close` 事件 `preventDefault()` **退回托盘**（`onWindowClose`），只有托盘「退出」（`quitApp()`）才真退进程         |
| `window-all-closed`    | 托盘存在时进程不跟着退出                                                                                   |
| 单实例锁                   | `requestSingleInstanceLock()` + `second-instance` 聚焦，杜绝「托盘一份 + 再开一份」两组抓取打架                     |
| `app:navigate` 事件      | 主进程 → 渲染进程路由跳转（托盘/菜单点页面时），渲染侧 `App.vue` 订阅后 `router.push`                                      |
| `assets/icon/tray.png` | 32×32 透明底橙柱 + 红点自绘图标（纯 Python zlib 写 PNG，无三方依赖）                                                |
| `electron-builder.yml` | `extraResources` 追加 `assets/icon → icon`，打包后托盘图标可找到                                            |

> ⚠️ 坑位：菜单「退出」**不能用 `role:'quit'`** —— 它绕过 `quitting` 标记，会被「关窗退回托盘」拦住导致退不掉；必须显式调 `quitApp()`。

### 4. 验证情况（如实说明）

- ✅ `typecheck:node` / `typecheck:web` 全绿；`npm run build` 通过（renderer 632 模块 + main/preload）。
- ✅ 产物自检：renderer 内 `版权所有` / `AI问道社` / `免责声明` / `全市场（沪深 A 股）` / `确认全量回填` 均在；`\${universeLabel}` 字面量 **0 处**；`dist-electron/main.js` 含「已有实例在运行 / 退回系统托盘 / 关于 QuantPilot / app:navigate / 重新选股」；preload 含 `getAppInfo` / `onNavigate`。
- ✅ **真起进程验证过一次**（`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .`）：日志依次出现 `[menu] 应用菜单已注入`、`[tray] 已创建（图标=…\assets\icon\tray.png）`、`[main] 启动完成 · quantpilot 0.5.2 · 版权所有 AI问道社`、`选股(Worker) 完成：20 只`，无运行时报错。
- ⚠️ **GUI 视觉仍未截图**：Electron 在沙箱里跑在**另一个会话**，本会话的窗口枚举/截屏（`EnumWindows` + `ImageGrab`）看不到它。修复后界面的视觉细节（按钮文案、关于页排版、托盘图标外观）仍请你在安装后点两下确认。

### 5. 升级提示

- 产物：`release/QuantPilot-Setup-0.5.2.exe`（新包名，不覆盖 0.5.1 及更早）。
- 数据库路径不变，**升级不丢数据**。
- 装完建议先在首页点一次「增量更新数据」，确认股票数与进度条正常；托盘图标会出现在任务栏右侧通知区，点它或图标即可还原窗口。

---

## 阶段七交付说明（关于窗改模态 + 去掉顶部导航条，v0.5.3）

### 1. 修复：关于窗里冒出主应用顶部导航条

**现象**（用户截图）：`帮助 → 关于 QuantPilot` 弹出的窗口顶部出现整排 `QuantPilot / 仪表盘 / A股行情 / 策略配置 / 回测 / 定时任务 / 个股`。

**根因**：关于窗与主页共用同一个 `index.html`，只靠 hash 路由 `#/about` 切页；而 `App.vue` 的 `<header>`（含 `<nav>`）是**无条件渲染**的，`About.vue` 只是被塞进 `<RouterView>` 的一个子组件，所以整条导航跟着一起渲染出来了。

**修法**（`renderer/routers/index.ts` + `renderer/App.vue`）：

| 改动                                 | 说明                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `/about` 路由加 `meta.fullscreen`     | 语义标记：该页独占整窗                                                                  |
| `App.vue` 新增 `fullscreen` computed | `route.meta.fullscreen` 为真时不渲染 `<header>`（导航条），并去掉 `main` 的 `p-5` 内边距，让内容顶到边 |



> 只有关于窗是 `/about` 路由；主窗口永远不会进这个路由，所以主界面导航条不受影响。

### 2. 关于窗改为**模态对话框**

`main/about.ts`：

| 改动                               | 说明                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `openAboutWindow(parent?)` 接收主窗口 | 用 `{ parent: main, modal: true }` 创建 → **关于窗打开期间主窗被禁用，点不得到主界面**                                               |
| `close` / `closed` 双保险解锁父窗       | Electron 原生模态层关闭时通常会自动 `setEnabled(true)`，这里再补一刀防异常路径导致主界面永久点不动                                               |
| 模态时交给 Electron 自动居中              | 非模态才手工 `setPosition` 居中（模态时系统以父窗为中心，手动设会跑偏）                                                                   |
| `parent` 为 null / 已销毁时降级非模态      | 不崩，只做独立窗口                                                                                                     |
| 调用方传主窗                           | 菜单「帮助 → 关于 QuantPilot」/ macOS 分支传 `getWindow()`；托盘「关于」先 `showWindow()` 再传 `currentWindow()`（模态窗口需要可见的 parent） |
| 模态窗支持 ESC 关闭                     | `About.vue` 监听 `keydown` → `window.close()`，不额外开 IPC 通道                                                       |

### 3. 验证情况（含一次"假警报"复盘）

- ✅ `typecheck:node` / `typecheck:web` 全绿；`npm run build` 通过。
- ✅ 真起进程 + 临时自测开关验证模态闭环，关键日志：  
  `[about] 打开关于窗口（模态）` → `[smoke] 模拟用户关闭关于窗` → `[about] closed 触发 · main destroyed=false · main enabled=true` → `[about] 诊断 父窗解锁 before=true after=true`。  
  → **结论：模态创建/关闭/父窗解锁全链路正常**（自测开关与诊断代码验证后已清除，`dist-electron/main.js` 里 `closed 触发` / `QUANTPILOT_SMOKE_ABOUT` / `aboutWinRef` 均为 0 处）。
- ⚠️ **踩坑复盘（重要）**：第一轮自测曾报 "父窗 enabled=false（应为 true）"，看似模态关闭后主界面卡死，实际是**自测脚本自己的 bug**——用 `getWindow().getTitle() === '关于 QuantPilot'` 找窗口，而窗口标题会被 `index.html` 的 `<title>QuantPilot · 专业选股</title>` **覆盖**，导致 `find()` 拿不到句柄、`close()` 压根没执行（窗口没关，父窗当然还 disabled）。改用 `BrowserWindow.getAllWindows().find(w => w.isModal())` 后一切正常。
  > 铁律：Electron 里判断窗口身份**别用 `getTitle()`**（会被页面 `<title>` 覆盖），优先 `isModal()` / `getTitle()` 之外的方式。
- ⚠️ **GUI 视觉仍未截图**：Electron GUI 在沙箱里跑在另一个会话，本会话的窗口枚举/截屏够不着。所以「关于窗顶部是否真的没有导航条」这一条**只能靠代码与构建产物保证**，请装机后点 `F1` 或 `帮助 → 关于 QuantPilot` 亲眼确认。

### 4. 升级提示

- 产物：`release/QuantPilot-Setup-0.5.3.exe`（新包名，不覆盖 0.5.2 及更早）。
- 数据库路径不变，升级不丢数据。
- 打开方式不变：菜单 `帮助 → 关于 QuantPilot`（F1）或托盘菜单「关于 QuantPilot」。

---

## 阶段八交付说明（配置保存反馈修复 + 回测默认区间，v0.5.4）

### 1. 问题与根因（真机实测定位，不是猜的）

用户反馈「策略配置改完后点『保存配置』没反应、不能保存」。真起进程挂临时自检，抓到的链路证据：

- 主进程**确实收到了**保存请求：`[strategyService] 配置已保存 7 条 maBullish,trendFollower,...`
- 但页面反馈只有 2 秒的 `已保存 ✓` 就自动变回 `保存配置`，用户根本没看清 → 体感「点了没反应」。
- 更隐蔽的第二层：页面停在 `保存配置 加载中…` + `inputTotal: 0`（策略卡片没渲染出来）时，草稿 `draft` 是空的，此时 `setParam()` 里 `if (!draft[id]) return;` 会**静默丢弃用户输入**，最终 `save()` 把一份**空配置数组**写进持久化 store —— 已存的参数被清回默认，用户看到的就是「改了等于没改」。

> 铁律：任何"保存"类操作，**成功要留得住反馈、失败必须露出原因**；草稿必须以「策略清单」为准全量建条目，绝不能只依赖另一条 IPC 的返回。

### 2. 改动清单

| 文件                                          | 改动              | 说明                                                                                                      |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/views/StrategyConfig.vue` | 草稿全量兜底          | `initDraft()` 先按 `configs` 建条目，再用 `strategies` 兜底补齐，草稿永不为空                                              |
| ↑                                           | 保存三态 + 可见错误     | `saveState: idle/saving/saved/error`，按钮文案 `保存配置 / 保存中… / 已保存 ✓ / 重新保存`；成功 4 秒内都显示绿色提示，失败显示红色原因；保存中禁用防连点 |
| ↑                                           | 加载失败显式暴露        | `loadError` 时页面显示「策略清单加载失败：…，请重启应用」，不再永远转圈「加载中…」                                                        |
| `src/renderer/src/views/Backtest.vue`       | 默认区间改最近 1 年     | 结束 = 今天 - 1 天（当天未收盘不能回测），开始 = 今天 - 1 年；手改过的区间存 `qp.backtest.range`，下次进入沿用                               |
| ↑                                           | 区间校验            | 起止顺序、结束不晚于今天，错误以红条显示，不静默跑                                                                               |
| `src/main/services/strategyService.ts`      | `saveConfig` 加固 | 校验 id/类型；**全量覆盖**写入（草稿缺失的策略回落默认，不留脏残留）；保存后立即把配置灌进内存实例，同一次请求内选股/回测/详情一致                                  |
| ↑                                           | 个股详情用带配置实例      | `getStockDetail` 由 `allStrategies()` 改为 `buildStrategies()` → 改了参数后个股 K 线上的信号标记同步生效                     |
| `src/main/ipc-router/index.ts`              | 统一错误出口          | 所有 handler 包 try/catch，失败 `log.error('[ipc:通道] handler 执行失败')` 并抛出 → 渲染层能拿到原因显示，而不是"点了没反应"              |

### 3. 验证情况

- ✅ `typecheck:node` / `typecheck:web` 全绿；`npm run build` 通过；`tsc -p tsconfig.worker.json` 通过。
- ✅ 真起进程 + 临时自检验证保存链路（改输入框 → 点保存 → 主进程落盘 → `configGet` 读回），关键日志：  
  `[strategyService] 配置已保存 7 条` → `[smoke] {"labelBefore":"保存配置","labelAfter":"已保存 ✓","configCount":7}`。
- ✅ 回测默认区间用 Node 单独跑公式核对：今天 `2026-10-01` → 默认起始 `2025-10-01`、默认结束 `2026-09-30`、跨度 364 天、结束不晚于今天。
- ⚠️ **GUI 点击仍是沙箱盲区**：「改值 → 点保存 → 按钮变红/绿」的完整交互需要装机肉眼确认。

### 4. 升级提示

- 产物：`release/QuantPilot-Setup-0.5.4.exe`（新包名，不覆盖 0.5.3 及更早）。
- 数据库路径不变，升级不丢数据。
- 装机后建议先做三步：① 进「策略配置」把某个阈值改成非默认值 → 点「保存配置」→ 应立刻看到 `已保存 ✓` 且 **4 秒内不消失**；② 切到「回测」页看默认日期是不是 `2025-10-01 ~ 2026-09-30`；③ 改一条参数后进个股页看 K 线信号标记是否跟着变。

---

## 阶段九交付说明（修复「保存失败：An object could not be cloned.」，v0.5.5）

### 1. 问题与根因

v0.5.4 把「保存配置」的失败原因显式显示到界面上，结果暴露了隐藏已久的真凶：

> 保存失败：An object could not be cloned.

根因（已用脚本实证，非推测）：`ipcRenderer.invoke` 底层走 **structuredClone 序列化**，而  
`reactive()` / Pinia state 返回的是 **Proxy 代理对象**——structuredClone 对代理对象直接抛  
`DataCloneError`。本项目「策略配置」的草稿 `draft` 是 `reactive(...)`，  
`save()` 组装出的 `configs` 里套着响应式的 `v.params`，送进 IPC 就炸。

> 为什么 v0.5.4 之前表现为「点了没反应」：这条异常被 `await store.saveConfig(...)` 静默吞掉，  
> 渲染层没有任何 catch，用户只看到按钮纹丝不动。v0.5.4 加了三态反馈后，异常才算现形。

**受影响的调用点（全项目排查）**：

| 通道                                                                                                                     | 入参来源                 | 是否踩坑             |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------- |
| `strategy:configSave`                                                                                                  | `reactive` 草稿        | ✅ 本次报错点          |
| `scheduler:set`                                                                                                        | 设置页 `reactive` draft | ✅ 同款隐患（定时任务保存会炸） |
| 其余通道（`data:*` / `market:list` / `strategy:list` / `strategy:configGet` / `stock:detail` / `backtest:run` / `app:info`） | 字面量或标量               | ❌ 不受影响           |

### 2. 改法（中心化根治，一处堵住整类问题）

| 文件                                          | 改动                                                               |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `src/renderer/src/utils/plain.ts`（新增）       | `plainify()`：IPC 入参一律先转可结构化克隆的纯数据                                |
| `src/renderer/src/api/quantApi.ts`          | `quantApi()` 包装原对象，**所有通道的入参统一 plainify** —— 以后任何调用点漏了也不会炸       |
| `src/renderer/src/stores/stockStore.ts`     | `saveConfig` / `saveScheduler` 落状态前先 `plainify`，避免把响应式代理塞进 Pinia |
| `src/renderer/src/views/StrategyConfig.vue` | `save()` 组装时 `params: { ...v.params }` 展开成纯对象，从源头断开代理引用          |


### 3. 验证情况

- ✅ `typecheck:node` / `typecheck:web` 全绿，`npm run build` 通过。
- ✅ 用真实 `plain.ts` + vue `reactive` 跑链路对照实验：
  - 对照组（未隔离代理）→ `DataCloneError: #<Object> could not be cloned.` —— 与用户截图报错一字不差，根因坐实；
  - 修复组（plainify 后送 structuredClone）→ 通过，且数据完整：`{"configs":[{"id":"maBullish","enabled":true,"params":{"maShort":9,"maLong":10}}]}`。
- ⚠️ **GUI 点击仍是沙箱盲区**：「改值 → 点保存 → 显示已保存 ✓」的完整交互需装机肉眼确认。

### 4. 升级提示

- 产物：`release/QuantPilot-Setup-0.5.5.exe`（新包名，不覆盖 0.5.4 及更早）。
- 数据库与配置路径不变，升级不丢数据。
- 装机后建议验收：进「策略配置」改一个阈值 → 点「保存配置」→ 应立即显示 `已保存 ✓`，  
  **且不再出现「An object could not be cloned」**；再进「设置」保存一次定时任务（修的是同款隐患）。

---

## 阶段十交付说明（A 批「缺陷清零」6 项，v0.6.0）

> 上一轮 A 批里的 **A2（个股详情用用户配置）** 与 **A9（回测区间校验）** 已在 v0.5.4 顺手修完，  
> 本轮落地剩余 6 项：A1 / A3 / A4 / A5 / A7 / A8。

### 1. 改动清单

| 项                       | 文件                                                                                                   | 改动                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** 回测 holdDays 改交易日 | `strategy/backtest.ts`                                                                               | 建 `dateIdx` 映射，退出判断与 `holdingDays` 全部改成「日期序号差」。回测本来只在交易日有 bar，序号差就是真实持仓交易日数                                                               |
| **A3** SQLite 双写竞态      | `src/main/services/dataService.ts`、`python/baostock_fetcher.py`                                      | 两端统一加 `PRAGMA busy_timeout = 15000`；`setMeta` 写失败只 warn 不再炸链路；`seedMockData` 的事务遇锁明确报「请等回填完成后重试」，避免「删了一半没写完」的脏 K 线；Python 侧 meta 写入被抢锁时降级 |
| **A4** 拉取/选股并发锁         | `dataService.ts`（`pullTask`）、`strategyService.ts`（`screenTask`）、`tray.ts`                            | 重复进入复用同一个任务；新增 `dataService.isPulling()` / `strategyService.isScreening()`；托盘连点时 tooltip 提示「正在拉取数据…/正在选股…」                                |
| **A5** 同股多策略去重          | `strategy/aggregate.ts`（新增）、`strategyWorker.ts`、`strategyService.ts`、`StockCard.vue`、`Dashboard.vue` | 新增 `aggregateSignals()`：同股同日聚合成一条（保留最高分 + `hits`/`strategyIds`），Worker 与主进程兜底共用；Dashboard `:key` 改 `code+date`；卡片显示「+N 策略」角标              |
| **A7** 滑点口径             | `strategy/backtest.ts`（注释）、`Backtest.vue`（表头 title）                                                  | **结论：不改公式**（见下节实测），改为把口径写进注释与界面 title                                                                                                     |
| **A8** 图表去 deep 监听      | `KLineChart.vue` / `ScoreRadar.vue` / `EquityChart.vue`                                              | 三处 `watch(..., {deep:true})` 去掉 `deep`（引用变化已足够触发），省掉每次刷新遍历 240 根 K 线整棵对象树的开销                                                              |

### 2. 一条审计意见被实测推翻（诚实记录）

审计 PID-13 原建议「`pnlPct` 里也扣 `2*slippage`」。本轮用真实代码复算，**该改法会让误差放大约 60 倍**，因此不采纳：

```
entry=10.01 exit=10.989
  代码口径(=现网实现)  9.7202%  →  资金实际口径 9.7144%   （差 0.006%）
  「再扣 2*slippage」  9.3202%  →  偏离资金实际 0.394%
```

原因：`pos.entryPrice` 本身已经是 `open*(1+slippage)`、`exitPrice` 已经是 `*(1-slippage)`，  
双边滑点**已经天然体现在分子两端**；再扣一次就是重复扣。  
所以保留原公式，只在代码注释和表头 `title` 里把「已含双边滑点与双边佣金 / 按交易日计」标清楚。  
（PID-13 请以本版结论为准。）

### 3. A6 定时任务「补跑」口径（主子已拍板）

**结论：要补跑一次。** 启动 / 每分钟检查时，若「今天已过触发时刻且当天没跑过」→ 补跑一次并写 `lastRunDate`。  
收盘后回家开软件正好补上那次收盘选股。本轮未实施（本轮范围只含 A1/A3/A4/A5/A7/A8），留到下一版。

### 4. 验证情况

- ✅ `typecheck:node` / `typecheck:web` 双绿；`build:worker`（aggregate 已进产物）、`npm run build` 通过
- ✅ `py_compile` + `_smoke/test_fetcher.py` 全绿（含「meta dataSource/lastUpdate 已落库」「非目标旧行已清理」）
- ✅ **A1 实测**：mock 池回测 `holdDays=5`，`holdingDays` 全为 `5 交易日`（对应自然日 7，跨越周末）→ 口径已改正
- ✅ **A5 实测**：4 条信号（同股 3 策略 + 另一只 1 条）→ 聚合出 2 条，`hits=3`、保留最高分 `81`、策略 id 串完整
- ✅ **A7 实测**：见上节
- ⚠️ **GUI 仍是沙箱盲区**：托盘 tooltip、卡片角标、回测表头提示需装机目视确认

### 5. 升级提示

- 产物：`release/QuantPilot-Setup-0.6.0.exe`（新包名，不覆盖 0.5.x）。数据库与配置路径不变，升级不丢数据。
- 装机三步：① 回测页跑一次 → 成交明细「持有」列应是 **5/10/… 交易日**（不是 7/12/… 自然日）；② 仪表盘若同一只票被多策略命中 → 只出 **1 张卡**且带「+N 策略」角标；③ 托盘「全量回填」连点 3 次 → 只跑一次，tooltip 提示「正在拉取数据…」。

---

## 阶段十一交付说明（B 批「全市场性能」，v0.7.0）

> A 批只清零「已知缺陷」，但「全市场 5400 只」从未真机压测过。本批落地审计 PID-02 / PID-07 / PID-08，  
> 把选股/回测从「主进程读全池 → 结构化克隆整池传给 Worker」改为「**Worker 直连 SQLite 自己流式读算**」，  
> 顺带用单条批量 SQL 取池、详情页增量计算。

### 1. 改动清单

| 项                  | 文件                                                                                          | 改动                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PID-02** 去掉整池克隆  | `src/main/workers/protocol.ts`、`strategyWorker.ts`、`strategyService.ts`、`computeService.ts` | 主进程不再把 5400×320≈**173 万根** K 线结构化克隆给 Worker（峰值 0.5~1.5GB）。改为只传 `{dbPath, limit, recentBars, configs, asOf, topN}`，由 Worker **直连同一份 `quantpilot.db`** 读池算信号，回传仅 ~20 条信号。Worker 侧用 `createRequire` 加载 better-sqlite3（只读优先，避免与 Python 写锁竞争） |
| **PID-07** 批量取池    | `strategy/dbPool.ts`（新增）、`dataService.ts`                                                   | 选股/回测取池从「5400 次逐只 SELECT」改为**单条批量 SQL**（按 `code,date` 主键索引逆序取最近 N 根，无需窗口函数/排序）。`loadScreeningPool` / `loadBacktestPool` 同时服务主进程兜底路径与 Worker 直连路径，内存用 `streamSeries` 流式分组（每次只驻留「当前一只」K 线）                                                 |
| **PID-08** 详情页增量计算 | `strategyService.ts`（`getStockDetail`）                                                      | 去掉每根 K 线 `series.bars.slice(0, sliceTo)` 的 **O(n²) 数组拷贝**，改为维护一个只 `push` 一次的增长 `hist` 数组传给 `generateSignal`，内存与 GC 抖动大幅下降                                                                                                                |
| 协议扩展               | `src/main/workers/protocol.ts`                                                              | `ScreenerPayload` / `BacktestPayload` 新增 `dbPath`（Worker 无 `app` 模块，由主进程用 `app.getPath` 算好传入）；`pool` 改为可选，仅作 Worker 不可用/测试兜底                                                                                                             |

### 2. 关键设计点

- **并发语义不变**：Worker 仍为「每请求一个、算完 terminate」的隔离模型（未引入常驻 worker），选股/回测各自独立、互不阻塞；`screenTask` / `pullTask` 并发锁照旧。
- **常驻 worker 说明（本批未做）**：审计 9.3 把「常驻 worker」列为 B 批目标之一。鉴于沙箱内 Electron GUI 不可见、无法目视验证串行阻塞回归，本批**未引入常驻 worker**——其收益（DB 连接复用）相对「消除 1.73M 对象克隆」已不是主要矛盾。若后续真机压测显示「每请求重开 DB」成为瓶颈，再加。
- **只读打开**：Worker 取池全程只读（`readonly:true`），与 Python 抓取器的写入在 WAL 下完全兼容；库不存在时回退普通打开。

### 3. 验证情况

- ✅ `typecheck:node` / `typecheck:web` 双绿；`build:worker` + `npm run build` 通过
- ✅ **SQL 合法性 + 排序**（Python 跑真实 sqlite）：选股 SQL 返回 300×320=96000 行、`per-code` 逆序取最近 N；回测 SQL 升序——均符合预期
- ✅ **JS 分组逻辑**（编译后 `streamSeries` + 假 DB 喂真实 SQL 行）：300 只 ×320 根、升序、meta(name/market) 完整、选股已正确反转为升序
- ✅ **Worker 计算路径**（编译后 Worker + `pool` 兜底分支）：15 只标的 65ms 出 15 信号、降序、无原生模块依赖
- ⚠️ **`openPoolDb` 直连路径未在本沙箱真机跑**：本沙箱 better-sqlite3 原生模块 ABI 与可用 Node 不匹配（且重建会破坏 Electron 打包 ABI），故未强跑；该路径在真实 Electron 环境（v0.6.0 已验证可加载）下等价，SQL 与分组逻辑已分别验证
- ⚠️ **GUI 盲区**：全市场 5400 只真机选股耗时 / RSS 需主子装机实测（见下）

### 4. 升级提示

- 产物：`release/QuantPilot-Setup-0.7.0.exe`（新包名，不覆盖 0.6.x）。数据库与配置路径不变，升级不丢数据。
- 装机重点验证：① 全量回填到 5400 只后点「重新选股」→ 进度走 Worker、主界面不卡；② 看 `%APPDATA%/quantpilot/logs/main.log` 应选股(Worker) 完成行正常、无 `database is locked`；③ 打开个股详情页切换不卡顿（PID-08）。

---

## 阶段十二交付说明（策略参数 + 组合预设，v0.8.0）

> 主子要求：① 批量调整 7 个策略的默认参数并新增若干参数；② 新增 4 个**只控制 enabled** 的组合预设 A/B/C/D，出厂默认启用组合A。

### 1. 策略参数调整（写入各策略 `defaultParams` + `paramSchema`）

| 策略     | 关键改动                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 均线多头   | `volMult 1.2→1.4`；`holdDays 5→15`；新增 `trailHalfMa=10` / `trailClearMa=20`（移动止盈占位）                                                                                                                       |
| 趋势选股   | `volMult 1.2→1.4`；`adxMin 25→30`；`holdDays 10→18`；新增 `trailHalfMa=10` / `trailClearMa=20`                                                                                                               |
| 断板反包   | `maxPullback 0.05→0.07`；`minOpenGuard 0.95→0.94`；`volMult 1.2→1.3`；新增 `firstBoardAmountMin=2e8` / `firstBoardSealMinutesMax=60` / `firstBoardTurnoverMin=0.05` / `firstBoardTurnoverMax=0.15`（首板质量增强占位） |
| N字反包   | `adjustMax 0.05→0.07`；新增 `activationAmountMin=1e8` / `shrinkRatio=0.5`（激活质量增强占位）                                                                                                                        |
| 海龟突破   | `bodyMin 0.01→0.03`；`holdDays 10→12`；新增 `adxFilter=25` / `trailClearMa=20`                                                                                                                              |
| 均线放量突破 | `volMult 1.5→1.6`；`holdDays 8→16`；新增 `trailHalfMa=10` / `trailClearMa=20`                                                                                                                               |
| 上升跌停反包 | `limitPct 0.095→0.093`；`holdDays 5→6`；新增 `volRatio=0.8` / `minAmount=5e7`                                                                                                                               |

> ⚠️ **移动止盈（trail*）与首板质量部分参数仅写入作为数据占位**：本次**未改 `backtest.ts` 出场逻辑**（避免破坏「持仓周期由 `holdDays` 权威控制」铁律）。`LimitUpReversal` 的「封板时间 / 换手率」因 `DailyBar` 仅日级、无流通股本，**当前无法计算**，需后续补数据才能接逻辑。

### 2. 组合预设（仅控制 enabled，不动参数）

新增 `strategy/presets.ts`：

| 组合        | 启用策略                                                              | 说明   |
| --------- | ----------------------------------------------------------------- | ---- |
| **A（默认）** | 量价共振 `maVolume` · N形反转 `nShapeReversal` · 上升跌停 `uptrendLimitDown` | 出厂默认 |
| B         | 涨停回撤 `limitUpReversal` · N形反转 `nShapeReversal`                    | —    |
| C         | 量价共振 `maVolume` · 海龟突破 `turtleBreakout` · 均线多头 `maBullish`        | —    |
| D         | 上升跌停 `uptrendLimitDown`                                           | —    |

- 出厂默认：当 `electron-store` 的 `configs` 为空（全新安装 / 已重置）时，`buildStrategies()` 按组合A 设 enabled；一旦保存过配置，用户覆盖优先。
- 新增 IPC：`strategy:applyPreset({presetId, configs?})` 一键套用预设（**只改 enabled，保留参数**；`configs` 可选，携带前端草稿以保住未保存的参数调整），`strategy:listPresets()` 列举预设供 UI 渲染。
- 前端：策略配置页顶部新增「组合预设」按钮条（组合A/B/C/D），点选即切换启用开关并立即落库；当前启用集合完全命中某组合时该按钮高亮，否则显示「当前为自定义启用组合」。

### 3. 验证

- ✅ `typecheck:node` / `typecheck:web` 双绿；`npm run build` 通过
- ✅ 编译后逻辑验证：7 策略 26 项新默认值逐项命中；4 组合 enabled 列表正确；出厂默认 enabled == 组合A 判定 YES
- ⚠️ `applyPreset` / `listPresets` 的 IPC 行为需真实 Electron 环境（套壳调用）确认

### 4. ⚠️ 升级必做：重置旧配置

由于旧版 `electron-store` 的 `configs` 可能残留「全部启用 + 旧参数」覆盖值，**升级到 v0.8.0 后必须重置**才能让新默认值与组合A 生效：

1. 关闭 QuantPilot；
2. 删除配置文件：`%APPDATA%\QuantPilot\config.json`（或清空其中 `configs` 字段为 `[]`）；
3. 重新打开 → 此时读取各策略 `defaultParams`（含本次新参数）并以组合A 为默认启用集。

> 若只想局部改：可在「策略配置」面板改完直接点保存（覆盖写入），不必删整个文件。

---

## 阶段十三 · v0.8.1 · 组合预设 UI（补齐 v0.8.0 漏做的前端）

**背景**：v0.8.0 只做了后端（`strategy/presets.ts` + `strategy:listPresets` / `strategy:applyPreset` 两个 IPC），**漏做前端**——策略配置页里没有任何「组合预设」控件，用户看不到也点不到。v0.8.1 补齐。


### 1. 改动

| 层 | 文件 | 改动 |
|---|---|---|
| 共享类型 | `src/shared/types/ipc.ts` | `strategy:applyPreset` 入参增加可选 `configs`（携带前端草稿参数） |
| 主进程 | `src/main/services/strategyService.ts` | `applyPreset` 语义修正为**只改 enabled、保留参数**（优先取草稿参数，否则取当前生效参数；不再回落 `defaultParams`） |
| 渲染 store | `src/renderer/src/stores/stockStore.ts` | 新增 `presets` 状态 + `loadPresets()` / `applyPreset(presetId, draftConfigs?)` |
| 渲染页面 | `src/renderer/src/views/StrategyConfig.vue` | 顶部新增「组合预设」按钮条：组合A/B/C/D，点选即切换启用开关并立即落库；命中组合高亮，未命中显示「当前为自定义启用组合」 |

### 2. 设计要点

- **预设只管开关、不动参数**（主子定）：点组合只重写 7 个策略的 `enabled`，用户已调参数原样保留（草稿参数一并落库，不丢未保存调整）。
- **一键即时生效**：点选即调用 `strategy:applyPreset` 落库，无需再点「保存配置」。
- **高亮判定**：当前草稿启用集合排序后与预设 `enabled` 集合完全一致才高亮；否则视为自定义组合。

### 3. 验证

- ✅ `typecheck:node` / `typecheck:web` 双绿；`npm run build` 通过
- ✅ 编译产物标记：renderer bundle 含 `组合预设` / `当前为自定义启用组合` / `strategy:applyPreset`；main bundle 含 `applyPreset` / `strategy:listPresets` / `组合A（默认）`
- ✅ 逻辑验证：4 组合高亮判定逐一点选全中、自定义组合判定为空、全禁用判定为空、预设 enabled 全部合法
- ⚠️ 按钮视觉与点击手感仍需真机确认（沙箱 GUI 不可见）

### 4. 升级提示

- 本次**不改参数默认值、不改组合定义**，无需重置 `configs`；旧配置照常生效。
- 若希望回到出厂（组合A + 新默认参数），仍按阶段十二第 4 节删除 `%APPDATA%\QuantPilot\config.json`。
- 产物：`release/QuantPilot-Setup-0.8.1.exe`（新包名，不覆盖 0.8.0）。

---

## 阶段十四 · 关于窗紧凑化（v0.8.2）

参考 Windows 原生「关于」对话框版式，把关于窗从「大卡片」改成**紧凑信息行**，免责声明全文保留。

### 1. 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| 类型定义 | `src/shared/types/ipc.ts` | `AppInfo` 新增 `chrome: string`（照参考图列「版本/Electron/Chrome/Node.js」） |
| 主进程 | `src/main/appInfo.ts` | 补 `chrome: process.versions.chrome` |
| 主进程 | `src/main/about.ts` | 窗口 **620×520 → 480×340**（min 440×320），禁最大化/最小化；保留模态与 `ready-to-show` 机制 |
| 渲染页面 | `src/renderer/src/views/About.vue` | 重写为紧凑对话框：40px 图标 + 应用名 + 5 行版本（版本/Electron/Chrome/Node.js/Vue）+ 免责声明块 + 底栏「确定」 |

### 2. 设计要点

- **版式照参考图**：小图标 + 应用名（accent 色）+ 定宽标签的版本行 + 底部横线 + 右下角「确定」。
- **配色仍走深色**（主子定）：全应用无浅色主题，关于窗独立变白会割裂，故沿用 `#0b0f17` 深色。
- **免责声明全文保留**（主子硬要求）：文案一字未删，含「不构成任何投资建议或买卖要约」。
- **版权不占额外高度**：`© 2026 AI问道社` 放在底栏左侧，与「确定」同一行 —— 既保住版权口径又不破坏极简。
- **尺寸按内容实测**：内容实需 ≈309px，取 340 留约 30px 余量，避免不同字体渲染下出滚动条。
- **关闭方式**：Esc / Enter / 点「确定」三种，均走渲染层 `window.close()`。

### 3. 验证（含真实渲染测量）

- ✅ `typecheck:node` / `typecheck:web` 双绿；`npm run build` 通过
- ✅ **Chrome 真实渲染测量**（playwright + 本机 Chrome，`about-preview.html` 内联构建产物 CSS 保证等价）：
  - 内容区 `clientHeight = scrollHeight = 340`，内部滚动容器 `293 / 293` → **零溢出**
  - 版本行 88px、免责声明块 78px、底栏 46px；`disclaimerText` 与原文逐字一致
- ✅ 编译产物标记：`width:480` / `height:340` / `minHeight:320` / `maximizable:!1` / `minimizable:!1` / `versions.chrome`；renderer 含 `确定` / `免责声明` / 免责全文
- 📷 版式预览：`docs/preview/about-preview.html`（可交互）+ `about-preview.png`

### 4. 打包变更（重要）

`electron-builder.yml` 的 `win` 段新增 **`signAndEditExecutable: false`**：

- 原因：本机杀软/管家实时扫描刚写出的 `QuantPilot.exe`，给 rcedit 一个瞬时文件锁，报 `Fatal error: Unable to commit changes`。0.8.0 那次是非致命（包照出），0.8.2 首次打包**致命中断**（重试 1 次仍失败，`rm -rf release/win-unpacked` 也无法规避）。
- 代价：EXE 属性页的版本元数据（File Description / Product Version / Copyright）不再写入；**应用内「关于」窗照常显示版本号**，功能无影响。
- 若要在意元数据：暂停杀软实时防护后，把该行改回 `true` 重跑 `npm run dist:win`。

### 5. 升级提示

- 本次只改关于窗外观与 `AppInfo` 字段，**不动策略参数、不动组合预设**，无需重置 `configs`。
- 产物：`release/QuantPilot-Setup-0.8.2.exe`（新包名，不覆盖 0.8.1）。

## 阶段十五 · 涨停池/连板统计 + K线MACD增强（v0.9.0）

对齐「犀利看盘」截屏功能的第一批（纯本地日K可实现，零新数据源风险）。

### 1. 新功能：涨停池页（/limitup）

- 全市场扫描当日（或指定历史日）收盘涨停标的：代码/名称/收盘价/涨幅/**连板数**/**N天M板标注**（如「5天4板」）/首板日/成交额/一字板·ST标记
- 连板高度分布概览：首板 / 2连板 / 3连板+ / 最高连板
- 点击行 → 个股详情 K 线
- 涨停判定（交易所口径，双规则）：
  - 规则A精确：`close >= round(preClose × (1+上限), 2)`（前复权基准日与交易所完全一致）
  - 规则B兜底：涨幅 ≥ 上限−0.0018 且 收盘=最高（覆盖历史前复权价整体缩放的 round 漂移）
  - 上限：沪深主板 10% / 创业板·科创板 20% / 名称含 ST 5%（时点近似，页面已披露）

### 2. 个股 K 线增强

- 新增 **MACD 副图**（国内口径：EMA SMA 种子，柱=(DIF−DEA)×2，柱色红=今≥昨），三副图联动缩放
- **涨停日三角标注**（最低价下方，连板 ≥2 标注「板n」，与信号 pin 上下错位防压字）

### 3. 实现要点（五层齐全）

- strategy/indicators.ts：`limitUpRatio` / `isLimitUpStrict` / `isOneWordLimitUpStrict` / `macd`
- strategy/limitup.ts（新）：`limitUpStreak`（连板+N天M板窗口，≤10交易日）/ `computeLimitUpPool`（复用 streamSeries 尾部 30 根，全市场约 16 万行流式扫，秒级）/ `finalizeLimitUpPool`
- Worker `kind:'limitup'` 直连 SQLite；主进程兜底同实现；`strategy:limitup:pool` IPC（IpcRequestMap/ResponseMap 类型安全，preload 零改动）
- renderer：`LimitUp.vue`（新）+ 路由/导航「涨停池」+ store `loadLimitUpPool`（同日期缓存）
- tsconfig.web/vite：`@strategy` alias（renderer 只引纯函数 indicators.ts，不引入 node 依赖）

### 4. 验证（如实）

- ✅ `npx tsx strategy/phase5-limitup-test.ts`：37/37（涨停判定边界/三连板/断板「5天4板」/20cm/ST/一字/asOf回看无未来函数/MACD 手算基准对拍）
- ✅ 真实库对拍（Python 复算同口径）：2026-09-30 规则A=57=稳健（基准日精确）；历史日稳健规则多捡回 10+ 只漂移漏判（2025-12-31: 45→57）
- ✅ typecheck:node / typecheck:web 双绿；`npm run build` 通过
- ⚠️ 已知局限：ST 按当前名称近似（历史摘帽/戴帽可能误判）；次新股（样本<6根）跳过；mock 演示数据无涨停形态

### 5. 升级提示

- 新增涨停池页不依赖配置变更，无需重置 `configs`。
- 产物：`release/QuantPilot-Setup-0.9.0.exe`（新包名，不覆盖 0.8.2）。
- 后续批次（已立项未实现）：腾讯实时行情涨速榜 / 分时图 / 题材 CSV 导入 / 跌停池。

## 阶段十六 · 涨停池实机验收修正（v0.9.1）

v0.9.0 实机验收截图（2026-09-30 真实行情）暴露两处问题，本版修正：

### 1. 涨停判定上界护栏（杀假阳性）

- **实证问题**：截图与库内复算共 7 只假阳性——名称现含 ST/*ST 按上限 5% 判定，但当日实际涨幅远超 5%（ST喜临门 +6.21%、*ST发展 +9.87%、*ST广糖 +9.98% 等）。根因：判定只有下界（close ≥ 涨停价），无上界——涨幅超上限的普通上涨也被误标。
- **修正**：`close > round(preClose×(1+上限),2) + 0.005`（半分钱 round 漂移裕量）直接拒判；跌停判定对称加下界护栏。
- **对拍**：2026-09-30 修后 49 只（7 假阳性全剔）；2026-06-30 的 26 只 ST 涨幅全落 5% 附近（4.89%~5.49%），真涨停零误伤。
- **口径说明**：*ST发展 +9.87% 这类「当日按 10% 涨停、现名带 ST」的股票修后会从池中消失（漏判）——这是 ST 名称时点近似的固有局限，宁漏勿错。

### 2. 涨停池固定全市场扫描

- **实证问题**：v0.9.0 误用 `poolLimit()`（选股池上限设置），主子设 500 时全市场 57 只被截成 11 只。
- **修正**：涨停池 `limit=0` 全市场扫描（约 5400 只尾部 30 根 ≈16 万行流式，秒级），不再受「选股池上限」约束。

### 验证

- ✅ phase5 算法测试 42/42（新增 6 条护栏用例：ST +6.21%/+9.87% 拒判、低价股 round 放行、round 向上 +10.04% 放行、跌停对称护栏）
- ✅ 真实库三日对拍（假阳性清零、ST 真涨停保留）；typecheck 双绿
- 产物：`release/QuantPilot-Setup-0.9.1.exe`（新包名不覆盖）

## 阶段十七 · 数据健康包（v0.9.2）

涨停池验收第二轮排查发现：**全市场标的缺 ~1100 只**（stocks 仅 4284，创业板 sz.3 重灾缺 ~850）——历史上某次全量回填时 baostock `query_stock_basic` 流中断返回半截名单，`purge_non_targets` 按残缺名单**永久删库**，而增量模式 `--local-only` 永不新增标的，名单就此冻结。本版三道防线 + 补拉能力：

### 1. Python 三道防线（baostock_fetcher.py）

- **universe 数量下限校验**：全市场口径（--limit 0）名单 < 4500（`--min-universe` 可调）→ 报错退出，绝不写库
- **purge 二次防护**：目标数 < 库内 80% → 拒绝清理（宁勿删）
- **`--fill-missing` 补拉模式**：目标 = universe 全集 − 库内已有，只拉缺的（3 年回看，与全量同窗口），不清理；完成后写 `meta.universeSize`

### 2. 数据健康可见化

- 新 IPC `data:dataHealth`（stocksCount / universeSize / lastUpdate）
- 仪表盘：覆盖 <95% 时黄条「本地 X / 全市场 Y 只（缺 Z）」+「补拉缺失标的」按钮（两段确认）
- 涨停池页：覆盖不全时顶部黄条提示可能漏股
- 涨停池完成日志输出完整命中名单（code:streak），与 `docs/limitup-ref-2026-09-30.txt` 基准 diff 可精确定性口径差异

### 3. 其他澄清（免修复）

- 2026-09-25 无数据 = **中秋休市**（9/25~9/27），连板/首板日逻辑经三天原始数据人肉验证全部正确
- v0.9.1 验收截图 UI 52 只 vs Python 复算 49 只差 3 只：streak≥2 的 11 只完全吻合，差异在 3 只首板，待新日志 diff 定性

### 验证

- ✅ `python/test_data_health.py`：14/14（下限校验/purge 防护/fill-missing 目标集合，mock 不联网）
- ✅ typecheck 双绿
- 产物：`release/QuantPilot-Setup-0.9.2.exe`
- **升级后操作**：仪表盘点「补拉缺失标的」（预计 5~15 分钟）→ 涨停池刷新（应 ~57 只+）→ 覆盖黄条消失

## 阶段十八 · 覆盖度「未知」状态可见化（v0.9.3）

v0.9.2 实机验收发现：全新安装后仪表盘**既没有黄条也没有「补拉缺失标的」按钮**。根因是设计缺陷（鸡生蛋）：`healthLow` 硬卡 `universeSize !== null`，而 `universeSize` 只有跑过一次补拉/全量回填才写入 meta——按钮的显示前提恰好是按钮要完成的事。

### 修正

- **「覆盖度未知」本身视为不健康**：`universeSize === null` 时同样亮黄条，文案分两态——
  - 未知：「数据覆盖度未知：本地 X 只，但从未对照过全市场名单校验——历史名单可能残缺（曾静默漏 ~1100 只）…建议补拉校验并补齐」
  - 已知不全：维持「本地 X / 全市场 Y 只（缺 Z）」
- 涨停池页覆盖提示同步分两态（未知时不再显示错误的全市场数字）。
- 补拉完成 → meta.universeSize 写入 → 黄条自动转为「已知」口径，覆盖合格后消失。

### 事故记录（如实）

- v0.9.3 期间 `npx asar extract-file <asar> package.json` 在项目根目录执行，把安装包内 package.json **解包覆盖**了项目根的 package.json，随后清理时误删。已从 `package-lock.json` 根条目 + 打包产物内 package.json 完整重建（依赖清单权威一致，scripts 按项目实际用法还原），typecheck 三配置全绿验证恢复成功。教训沉淀：asar 解包一律进临时目录。

### 验证

- ✅ typecheck（node+worker+web）全绿；产物 `release/QuantPilot-Setup-0.9.3.exe`
- **升级后预期**：仪表盘顶部直接出现黄色「覆盖度未知」提示条 + 补拉按钮（无需任何前置操作）→ 点两下补拉（5~15 分钟）→ 覆盖变为已知，涨停池刷新。

---

## 1.0 交付说明（v0.9.19 · M1–M6 四大工作台）

在数据层去 Python 迁移（P0–P6，见 `docs/DATA_LAYER_MIGRATION.md`）之后，1.0 补齐了**操盘日常四件套**与**数据韧性**。本节只讲「做了什么、为什么这么做、验证到哪」，实现细节见 `docs/PLAN_1_0.md`。

### M1 · 7 因子评分雷达「去伪存真」
- **核查纠正**：雷达本就接通（7 策略全调 `computeBreakdown`），真正问题是 `fund`（资金流）/`sector`（板块）两轴是**价格派生代理值**却标着「资金/板块」，对操盘手构成误导。
- **做法**：① 雷达下方加**数据驱动**注记（真值/代理分别如实标注）；② 聚合多策略命中同票时 `breakdown` 跟随最高分策略；③ **M2 完成后把板块轴接真值**（见下）。
- **诚实边界**：`fund` 无真实主力净流入数据源，**1.0 维持代理值并永久标注**，不假装是真资金流。

### M2 · 板块 / 行业模块
- **数据源（实测）**：新浪行业板块 `newSinaHy.php`（49 个行业，含涨幅/成交额/领涨股）+ 板块成分节点（与现有 universe 同结构）；成分股 code 与本地库匹配率 **97%**。
- **落库**：新增 `sectors` / `sector_members` 表（顺带补上原本全空的 `stocks.industry` 映射）。
- **页面**：板块涨幅榜（按涨幅/成交额排序）+ 成分股详情（叠加库内行情，库外成分标「库内无行情」）。**须手动点「刷新板块」才拉取**，不自动打新浪。

### M3 · 市场情绪看板
- **零新数据源**，全部从既有 `daily` 表实时算。**交易所严格涨跌停口径**（ST 5% / 主板 10% / 创业板·科创 20%），不用「涨跌幅≥9.5%」粗判。
- **情绪温度 0–100**（固定权重、可解释）：涨停占比 40（全市场约 3% 涨停即满分）+ 涨跌比 30 + 连板高度 20（8 板封顶）+ 昨日涨停今日表现 10（打板溢价）；五档：冰点/偏冷/中性/偏热/过热。附 30 日曲线 + 连板梯队分布。
- 实测（2026-09-30）：温度 51 中性 / 涨停 52 / 跌停 10 / 最高 7 板 / 打板溢价 +1.32%。

### M4 · 自选股工作台
- **新表** `watchlist(code, grp, note, cost_price, added_at)`；个股详情页「＋加自选 / ✓移出」（可录成本价）。
- **「我的自选」页**：分组筛选 + 搜索 + 浮动盈亏（**只给比例不给金额**——不连券商、无股数概念）+ 信号命中联查。
- **仅扫自选池**：仪表盘一键切范围（**范围开关只在仪表盘**，自选页专心做自选）。
- **关键**：选股**指纹含 scope + 自选内容摘要**，否则全市场/自选两份结果互相命中缓存显示错数据。

### M5 · 回测报告增强 + Excel 导出
- **报告维度**（纯聚合，主/渲染共用 `shared/reportCore.ts`）：分年/分月收益（复利口径）、持仓期分布（交易日分档 + 均收益）、**最大回撤区间**（峰值→谷底→收复/未收复）、离场原因构成、单笔盈亏极值。
- **导出 Excel(.xlsx)**：**零三方依赖手写 xlsx 生成器**（`strategy/xlsx.ts`，xlsx=ZIP+XML；本工程一贯「能自己写就不引三方」）。5 张表：回测摘要 / 分年 / 分月 / 交易明细（全量）/ 权益曲线。

### M6 · 数据韧性
- **日K host 级 failover**（v0.9.12）：腾讯 fqkline 主源 `proxy.finance.qq.com` + 备用 `web.ifzq.gtimg.cn`（实测老 host 已恢复可用、与主源 qfq **逐字节一致**），传输层失败自动切换——**同源同口径，不碰 LOCKED、不污染 qfq 库**。
- **明示数据源**：`DbStatus` 暴露 `dailySource/dailyBreaker/degraded`，仪表盘与设置页显示「日K源 腾讯财经·qfq 复权」，熔断时显式警示。
- **诚实边界（实测证伪，如实放弃）**：日K**没有第二个 qfq 源**（sina/tdx 均不复权，强行开 LOCKED 只会造空候选）；`amount` 源**结构性不提供**（腾讯/新浪日K都只有 6 字段，163/东财本机不可用）——故 amount 历史缺口当前网络下无源可补，非代码问题。

### ⚠️ 工程铁律修复：worker 静默打老产物
出包核对时发现 **worker 产物长期停留在旧版本**——`dist:win` 的构建流程**从不编译 worker**（worker 由 `tsconfig.worker.json` 产出），导致改 worker/strategy 的代码进不了安装包。**已修**：`build = vite build && tsc -p tsconfig.worker.json`。此后改 worker 后须核对 `dist-electron/src/main/workers/strategyWorker.js` 时间戳。

### 1.0 验证与诚实边界
- 三套 tsconfig（node/worker/web）typecheck 全绿；每个模块均以**真实数据实测**（真实行情库 / 真实新浪接口）而非仅编译通过为准。
- **未做/待后续**：参数敏感度网格扫描、多策略横向对比 UI（`report.ts` 有 HTML 对比报告但尚未接线到界面）；`fund` 资金流因子无数据源维持代理。

**升级提示**：安装 v0.9.19 后，先到「板块」页点一次「刷新板块」（板块评分轴依赖它），再到「回测」页跑一次回测即可体验 M5 报告与导出。
