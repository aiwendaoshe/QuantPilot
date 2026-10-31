<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useStockStore, UNIVERSE_OPTIONS } from '../stores/stockStore';
import StockCard from '../components/StockCard.vue';

const store = useStockStore();
const signals = computed(() => store.signals);
const loading = computed(() => store.loading);
const confirmFull = ref(false);
const isMock = computed(() => store.dbStatus.dataSource === 'mock');
const universeHint = computed(
  () => UNIVERSE_OPTIONS.find((o) => o.value === store.universe)?.hint ?? '',
);
/** 范围的人话说法（0 = 全市场，绝不能显示成「0 只」） */
const universeLabel = computed(() =>
  store.universe === 0 ? '全市场（沪深 A 股）' : `${store.universe} 只`,
);
/** 全量回填按钮的悬浮说明（三元放不进 :title 模板串，抽成 computed） */
const fullTitle = computed(() =>
  confirmFull.value
    ? `再次点击确认：清空重建为 ${universeLabel.value}（约 ${universeHint.value}）`
    : `全量回填：按「范围」重建标的池（约 ${universeHint.value}）`,
);
/** 重新选股按钮：全市场档要提前告知耗时 */
const poolTitle = computed(() =>
  store.universe === 0 ? '选股池 = 全市场约 5400 只，单次选股约数分钟' : '',
);

/** 选股范围切换（M4）：全市场 ⇄ 仅自选池 */
function toggleScope(): void {
  void store.setScreenScope(store.screenScope === 'all' ? 'watchlist' : 'all');
}

/** 数据健康（v0.9.3）：覆盖 <95% 或「未知」（从未跑过全市场口径回填）都视为不健康——未知≠合格 */
const healthLow = computed(() => {
  const h = store.health;
  if (!h) return false;
  if (h.universeSize === null) return true;
  return h.stocksCount < h.universeSize * 0.95;
});
/** 覆盖度未知：meta.universeSize 为空 = 从未对照过全市场名单 */
const healthUnknown = computed(
  () => !!store.health && store.health.universeSize === null,
);
const missingCount = computed(() => {
  const h = store.health;
  if (!h || h.universeSize === null) return 0;
  return Math.max(0, h.universeSize - h.stocksCount);
});
const confirmFill = ref(false);

/**
 * 抓取进度条右侧说明（v0.9.6）。
 * 历史上这里写死「baostock 逐只拉取」，但 v0.9.4 起默认引擎已是 Node 内置源、且日 K 锁定腾讯 qfq，
 * 那句话会误导用户以为软件还在用 Python 逐只抓 —— 改成按 meta.pullEngine 如实显示。
 */
const progressHint = computed(() =>
  store.dbStatus.engine === 'python'
    ? 'Python / baostock 逐只拉取（旧实验路径），可先去「A股行情」页面查看已有数据'
    : 'Node 内置源批量拉取（腾讯财经 · 前复权 qfq），可先去「A股行情」页面查看已有数据',
);

/**
 * 日 K 数据源明示（M6）。
 * 日 K 层锁死腾讯 qfq 且无降级兜底，所以把「出处 + 单点风险」直接写进状态栏，
 * 让用户随时知道库里的 K 线是谁给的，不靠猜。
 */
const dailySourceLabel = computed(() => {
  const map: Record<string, string> = { tencent: '腾讯财经', sina: '新浪财经', tdx: '通达信' };
  const name = map[store.dbStatus.dailySource] ?? store.dbStatus.dailySource;
  return `${name} · ${store.dbStatus.adjust ?? 'qfq'} 复权`;
});
/** 日 K 熔断=降级停摆（M6）：腾讯无兜底，熔断就拉不到，必须显式警示而非静默 */
const dailyDegraded = computed(() => store.dbStatus.degraded);
const dailyBreakerLabel = computed(() =>
  store.dbStatus.dailyBreaker === 'half-open' ? '试探中' : '已熔断',
);

/** 结果版本一行（v0.9.7 指纹缓存）：如实告诉用户「这排结果是基于哪天数据、什么时候算的」 */
const screenStamp = computed(() => {
  const m = store.screenMeta;
  if (!m) return null;
  const d = m.dataDate ? `${m.dataDate.slice(0, 10)} 数据` : '数据日期未知';
  const t = m.computedAt ? new Date(m.computedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
  return `${d} · 计算于 ${t}${m.cached ? ' · 缓存命中（未重算）' : ''}`;
});
/** 结果比库内数据旧（库里有更新日期，但结果不是基于它算的）→ 提示重算 */
const screenStale = computed(() => {
  const m = store.screenMeta;
  const barTo = store.dbStatus.barTo;
  return !!m && !!barTo && !!m.dataDate && m.dataDate < barTo;
});

/** 抓取进度百分比（拉取中才显示） */
const progressPct = computed(() => {
  const p = store.pullProgress;
  if (!p || p.phase !== 'fetch' || p.total <= 0) return 0;
  return Math.min(100, Math.round((p.done / p.total) * 100));
});

onMounted(async () => {
  await store.refreshStatus();
  void store.loadHealth();
  await store.runScreener();
});

function doPull(force: boolean): void {
  if (force && !confirmFull.value) {
    confirmFull.value = true;
    return;
  }
  confirmFull.value = false;
  void store.pullHistory(force);
}

/** 补拉缺失标的（两段确认：先亮按钮再点一次才执行） */
function doFillMissing(): void {
  if (!confirmFill.value) {
    confirmFill.value = true;
    return;
  }
  confirmFill.value = false;
  void store.pullHistory(true, 'fill-missing');
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-bold">今日选股 · TOP {{ signals.length }}</h1>
        <p class="text-xs text-gray-500 mt-0.5">
          <template v-if="screenStamp">结果基于 <b class="text-gray-300">{{ screenStamp }}</b></template>
          <template v-else>收盘后运行全部启用策略，按综合评分降序排列，点击卡片查看个股详情。</template>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <!-- 拉取范围：全量回填按所选范围重建，增量更新只续拉库内已有标的 -->
        <label class="flex items-center gap-1.5 text-xs text-gray-400" title="全量回填的目标标的数；范围越大越慢">
          范围
          <select
            :value="store.universe"
            :disabled="store.pulling || loading"
            @change="store.setUniverse(Number(($event.target as HTMLSelectElement).value))"
            class="bg-panel2 border border-panel2 rounded-lg px-2 py-1.5 text-xs text-gray-200 disabled:opacity-50"
          >
            <option v-for="o in UNIVERSE_OPTIONS" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </label>
        <button
          @click="doPull(false)"
          :disabled="store.pulling || loading"
          class="px-3 py-1.5 rounded-lg border border-panel2 text-sm hover:bg-panel2 disabled:opacity-50"
          title="只续拉本地库已有标的的最新 K 线（快，不新增标的）"
        >
          {{ store.pulling ? '拉取中…' : '增量更新数据' }}
        </button>
        <button
          @click="doPull(true)"
          :disabled="store.pulling || loading"
          class="px-3 py-1.5 rounded-lg border text-sm disabled:opacity-50"
          :class="confirmFull ? 'border-bull text-bull' : 'border-panel2 hover:bg-panel2'"
          :title="fullTitle"
        >
          {{ confirmFull ? '确认全量回填 ' + universeLabel + '？' : '全量回填' }}
        </button>
        <button
          @click="store.runScreener(true)"
          :disabled="loading || store.pulling"
          class="px-3 py-1.5 rounded-lg bg-accent text-black text-sm font-medium disabled:opacity-50"
          :title="poolTitle"
        >
          {{ loading ? '计算中…' : '重新选股' }}
        </button>
        <!-- 选股范围切换（M4）：全市场 / 仅自选池 -->
        <button
          @click="toggleScope"
          :disabled="store.screening || store.pulling"
          class="px-3 py-1.5 rounded-lg border text-sm disabled:opacity-50"
          :class="
            store.screenScope === 'watchlist'
              ? 'border-accent text-accent bg-accent/10'
              : 'border-panel2 hover:bg-panel2 text-gray-300'
          "
          :title="
            store.screenScope === 'watchlist'
              ? '当前只对自选池选股。点一下改回「全市场」。'
              : '当前全市场选股。点一下改为「仅对自选池」选股。'
          "
        >
          {{ store.screenScope === 'watchlist' ? '仅扫自选池 ✓' : '全市场' }}
        </button>
        <button
          @click="store.detectPythonEnv()"
          :disabled="store.detecting || store.pulling"
          class="px-3 py-1.5 rounded-lg border border-panel2 text-sm hover:bg-panel2 disabled:opacity-50"
          title="旧版遗留实验项：检查本机是否装好 Python + baostock（默认拉取已走 Node 内置源，普通用户无需此项）"
        >
          {{ store.detecting ? '检测中…' : 'Python 环境（旧）' }}
        </button>
      </div>
    </div>

    <!-- 本地行情库状态 -->
    <div class="flex flex-wrap items-center gap-x-5 gap-y-1 mb-3 rounded-lg bg-panel2 px-3 py-2 text-xs text-gray-400">
      <span>本地行情库</span>
      <span>
        股票 <b class="text-gray-200">{{ store.dbStatus.stockCount }}</b> 只
        <span v-if="store.dbStatus.poolCount !== store.dbStatus.stockCount" class="text-warn">
          （有行情 {{ store.dbStatus.poolCount }} 只）
        </span>
      </span>
      <span>
        K线 <b class="text-gray-200">{{ store.dbStatus.barCount }}</b> 根
      </span>
      <span v-if="store.dbStatus.barFrom && store.dbStatus.barTo">
        区间 <b class="text-gray-200">{{ store.dbStatus.barFrom }}</b> ~
        <b class="text-gray-200">{{ store.dbStatus.barTo }}</b>
      </span>
      <span>
        更新 <b class="text-gray-200">{{ store.dbStatus.lastUpdate ? store.dbStatus.lastUpdate.slice(0, 10) : '—' }}</b>
      </span>
      <span title="选股只会跑这个范围内的标的">
        选股池上限 <b class="text-gray-200">{{ store.dbStatus.poolLimit || '不限' }}</b>
      </span>
      <span
        class="px-1.5 py-0.5 rounded"
        :class="isMock ? 'bg-warn/15 text-warn' : 'bg-bull/15 text-bull'"
        :title="
          isMock
            ? '未取到真实行情（当前为内置演示数据，仅供功能演示）'
            : `数据来自真实行情：${store.dbStatus.provider ?? '—'} · ${store.dbStatus.adjust ?? '—'} 复权`
        "
      >
        {{ isMock ? '演示数据' : '真实行情' }}
      </span>
      <!-- 日 K 数据源明示（M6）：锁死腾讯 qfq、无自动降级兜底，熔断时显式警示 -->
      <span
        class="px-1.5 py-0.5 rounded"
        :class="dailyDegraded ? 'bg-warn/15 text-warn' : 'bg-panel1 text-gray-300'"
        :title="
          dailyDegraded
            ? `日 K 源${dailySourceLabel}当前${dailyBreakerLabel}，暂时拉不到新 K 线（日 K 无自动降级兜底）。库内已有数据仍可正常选股。`
            : `日 K 线来自 ${dailySourceLabel}（锁死主源 · 无自动降级兜底）`
        "
      >
        日K源 {{ dailySourceLabel }}{{ dailyDegraded ? ` · ${dailyBreakerLabel}` : '' }}
      </span>
      <span v-if="store.pullMessage" class="text-accent">{{ store.pullMessage }}</span>
    </div>

    <!-- 日 K 源降级警示条（M6）：只在熔断时出现，平时不占版面 -->
    <div
      v-if="dailyDegraded"
      class="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
    >
      <b>日 K 数据源{{ dailyBreakerLabel }}</b>：{{ dailySourceLabel }} 当前不可用，
      暂时无法拉取新 K 线。库内已有数据仍可正常选股/回测；待源恢复后点「增量更新数据」补齐。
      <span class="text-warn/80">（日 K 锁死单一主源，暂无自动降级兜底 —— 这是当前数据韧性的已知边界）</span>
    </div>

    <!-- 数据健康（v0.9.2）：覆盖不全时提示补拉——历史上残缺名单曾静默删掉 ~1100 只 -->
    <div
      v-if="healthLow && store.health"
      class="mb-3 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs flex items-center justify-between gap-3"
    >
      <span v-if="healthUnknown" class="text-warn">
        ⚠️ 数据覆盖度未知：本地
        <b>{{ store.health.stocksCount }}</b> 只，但从未对照过全市场名单校验——历史名单可能残缺（曾静默漏 ~1100 只），涨停池与选股可能漏股。建议补拉校验并补齐（只拉缺的，几分钟）。
      </span>
      <span v-else class="text-warn">
        ⚠️ 数据覆盖不全：本地
        <b>{{ store.health.stocksCount }}</b> / 全市场
        <b>{{ store.health.universeSize }}</b> 只（缺 {{ missingCount }}），
        涨停池与选股可能漏股。建议补拉缺失标的（只拉缺的，几分钟）。
      </span>
      <button
        @click="doFillMissing"
        :disabled="store.pulling || loading"
        class="shrink-0 px-3 py-1.5 rounded-lg border text-xs disabled:opacity-50"
        :class="confirmFill ? 'border-warn text-warn font-medium' : 'border-warn/50 text-warn hover:bg-warn/10'"
      >
        {{ confirmFill ? '确认开始补拉？' : '补拉缺失标的' }}
      </button>
    </div>

    <!-- 抓取进度：baostock 逐只回填很慢，没有进度条用户会以为点了没反应 -->
    <div v-if="store.pulling" class="mb-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
      <div class="flex items-center justify-between text-xs text-accent">
        <span>
          正在拉取
          <template v-if="store.pullProgress?.phase === 'fetch'">
            · {{ store.pullProgress.done }}/{{ store.pullProgress.total }} 只（{{ progressPct }}%）
            · 已写入 {{ store.pullProgress.bars }} 根
          </template>
          <template v-else>· 正在准备目标清单…</template>
        </span>
        <span class="text-gray-500">{{ progressHint }}</span>
      </div>
      <div class="mt-1.5 h-1.5 rounded-full bg-panel overflow-hidden">
        <div
          class="h-full bg-accent transition-all duration-300"
          :style="{ width: `${progressPct}%` }"
        ></div>
      </div>
    </div>

    <!-- Python 环境探测明细（点「检测环境」后展开） -->
    <div
      v-if="store.pyDetect"
      class="mb-3 rounded-lg border px-3 py-2 text-xs"
      :class="store.pyDetect.found ? 'border-bull/40 bg-bull/5' : 'border-warn/40 bg-warn/5'"
    >
      <div v-if="store.pyDetect.found" class="text-bull">
        ✅ 已找到可用的 Python / baostock 解释器（旧实验路径，默认拉取不走这里）：
        <code class="text-gray-200">{{ store.pyDetect.found }}</code>
      </div>
      <div v-else class="text-warn">
        ⚠️ 未找到带 baostock 的 Python 解释器。请在装有 baostock 的环境执行
        <code class="text-gray-200">pip install baostock</code>；若已装好仍检测不到，
        可设置环境变量 <code class="text-gray-200">QUANTPILOT_PYTHON</code> 指向该 python.exe
        后重启应用。
      </div>
      <details class="mt-1.5 text-gray-500">
        <summary class="cursor-pointer select-none">
          已生成 {{ store.pyDetect.candidates.length }} 个候选 / 已尝试
          {{ store.pyDetect.tried.length }} 个
        </summary>
        <div class="mt-1 space-y-0.5 font-mono text-[11px] break-all">
          <div
            v-for="c in store.pyDetect.candidates"
            :key="c"
            :class="c === store.pyDetect.found ? 'text-bull' : ''"
          >
            {{ c === store.pyDetect.found ? '▶ ' : '· ' }}{{ c }}
          </div>
        </div>
      </details>
    </div>

    <!-- 结果比库内数据旧：只提示，不抢着自动重算（v0.9.7 主子定的规矩） -->
    <div
      v-if="screenStale"
      class="mb-3 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs flex items-center justify-between gap-3"
    >
      <span class="text-warn">
        库内数据已更新到 <b>{{ store.dbStatus.barTo }}</b>，但当前结果基于
        <b>{{ store.screenMeta?.dataDate }}</b> —— 这排结果里没有新数据。
      </span>
      <button
        @click="store.runScreener(true)"
        :disabled="loading || store.pulling"
        class="shrink-0 px-3 py-1.5 rounded-lg border text-xs hover:bg-warn/10"
        :class="loading ? 'border-panel2 text-gray-500' : 'border-warn/50 text-warn font-medium'"
      >
        {{ loading ? '重算中…' : '用新数据重算' }}
      </button>
    </div>

    <div v-if="store.screening || store.pulling" class="text-gray-500 py-20 text-center">正在运行策略引擎…</div>
    <div v-else-if="signals.length === 0" class="text-gray-500 py-20 text-center">
      <template v-if="store.screenMeta">暂无信号（可点击「增量更新数据」拉取行情，或点「重新选股」）</template>
      <template v-else>还没有选股结果，点「重新选股」跑一次；或先「增量更新数据」把行情拉下来。</template>
    </div>
    <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
      <StockCard
        v-for="(s, i) in signals"
        :key="s.code + s.date"
        :signal="s"
        :rank="i + 1"
      />
    </div>
  </div>
</template>
