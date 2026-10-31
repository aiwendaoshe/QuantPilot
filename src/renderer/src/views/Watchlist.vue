<script setup lang="ts">
/**
 * 我的自选（M4）—— 专管自选，不管选股范围。
 *
 * 定位：跟踪自选股。列表 + 搜索 + 分组 + 浮动盈亏 + 信号命中 + 增删。
 * ⚠️ 选股范围（全市场 / 仅扫自选池）**只在仪表盘**切换（那里才是选股发生的地方）；
 *    本页不做范围切换，两处各司其职（v0.9.14 曾把范围开关也放这儿，属多余，已移除）。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useStockStore } from '../stores/stockStore';
import type { WatchlistRow } from '@shared/types/ipc';
import { fmtPct, pctClass } from '../utils/market';

const store = useStockStore();
const router = useRouter();

const keyword = ref('');
/** 分组筛选；空串 = 全部分组 */
const groupFilter = ref('');

const rows = computed(() => store.watchlist);
/** 全部出现过的分组（去重、按名称） */
const groups = computed(() => [...new Set(rows.value.map((r) => r.group))].sort());

/** 命中信号的 code 集合：用当前选股结果联查（M4）。 */
const hitCodes = computed(() => new Set(store.signals.map((s) => s.code)));

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (groupFilter.value && r.group !== groupFilter.value) return false;
    if (kw && !r.code.toLowerCase().includes(kw) && !r.name.toLowerCase().includes(kw)) return false;
    return true;
  });
});

/** 盈亏统计（仅统计录了成本价的） */
const pnlStat = computed(() => {
  const withPnl = filtered.value.filter((r) => r.pnlPct !== null);
  if (withPnl.length === 0) return null;
  const avg = withPnl.reduce((a, r) => a + (r.pnlPct as number), 0) / withPnl.length;
  return { count: withPnl.length, avgPct: +avg.toFixed(2) };
});

onMounted(async () => {
  await store.loadWatchlist();
  // 信号联查需要当前选股结果；没有就跑一次（命中指纹缓存则秒回）
  if (store.signals.length === 0) void store.runScreener(false);
});

function open(code: string): void {
  void router.push(`/stock/${code}`);
}

async function remove(row: WatchlistRow): Promise<void> {
  if (!window.confirm(`确定把「${row.name || row.code}」移出自选？`)) return;
  await store.removeWatch(row.code);
  // 自选内容变了 → 若当前是「仅扫自选池」，选股结果已作废，顺手重算
  if (store.screenScope === 'watchlist') void store.runScreener(true, 'watchlist');
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-bold">我的自选</h1>
        <p class="text-xs text-gray-500 mt-0.5">
          共 {{ rows.length }} 只 · 数据来自本地行情库最新一根 K 线（非实时报价）。
          <span class="text-gray-600">（选股范围切换在「仪表盘」）</span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="keyword"
          placeholder="搜索自选 代码/名称"
          class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200 w-44"
        />
        <select
          v-model="groupFilter"
          class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200"
        >
          <option value="">全部分组</option>
          <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
        </select>
      </div>
    </div>

    <!-- 盈亏小结（仅统计录了成本价的；没录不给「0」假装持平） -->
    <div v-if="pnlStat" class="mb-3 rounded-lg bg-panel2 px-3 py-2 text-xs text-gray-400">
      已录成本价 <b class="text-gray-200">{{ pnlStat.count }}</b> 只 · 平均浮动盈亏
      <b :class="pctClass(pnlStat.avgPct)">{{ fmtPct(pnlStat.avgPct) }}%</b>
      <span class="text-gray-600">（成本价为你手动录入，非券商账户数据）</span>
    </div>

    <div v-if="store.watchlistLoading" class="text-sm text-gray-500 py-8 text-center">
      正在读取自选…
    </div>

    <div
      v-else-if="rows.length === 0"
      class="rounded-lg bg-panel2 border border-edge py-12 text-center"
    >
      <p class="text-sm text-gray-400 mb-1">还没有自选股</p>
      <p class="text-xs text-gray-600">
        去「A股行情」或「个股详情」页把关注的票加进来（详情页点「＋加自选」可录成本价）。
      </p>
    </div>

    <div v-else-if="filtered.length === 0" class="rounded-lg bg-panel2 border border-edge py-12 text-center">
      <p class="text-sm text-gray-400">没有匹配的自选股</p>
      <p class="text-xs text-gray-600 mt-1">换个关键字，或把分组筛选切回「全部分组」。</p>
    </div>

    <div v-else class="grid gap-2">
      <div
        v-for="r in filtered"
        :key="r.code"
        class="flex items-center gap-3 rounded-lg bg-panel2 border border-edge px-3 py-2 hover:border-accent/40 cursor-pointer"
        @click="open(r.code)"
      >
        <div class="w-20 shrink-0">
          <div class="text-sm text-gray-200 font-medium truncate">{{ r.name || r.code }}</div>
          <div class="text-[11px] text-gray-500">{{ r.code }}</div>
        </div>
        <span
          class="px-1.5 py-0.5 rounded text-[11px] shrink-0"
          :class="r.group === '观察' ? 'bg-panel text-gray-400' : 'bg-panel text-accent'"
        >{{ r.group }}</span>
        <span class="text-[11px] text-gray-500 w-16 shrink-0 truncate">{{ r.industry || '—' }}</span>
        <div class="flex-1"></div>
        <div v-if="r.pnlPct !== null" class="w-20 text-right shrink-0">
          <div class="text-sm font-medium" :class="pctClass(r.pnlPct)">{{ fmtPct(r.pnlPct) }}%</div>
          <div class="text-[11px] text-gray-600">盈亏</div>
        </div>
        <div v-if="r.changePct !== null" class="w-20 text-right shrink-0">
          <div class="text-sm font-medium" :class="pctClass(r.changePct)">{{ fmtPct(r.changePct) }}%</div>
          <div class="text-[11px] text-gray-600">涨跌</div>
        </div>
        <div v-else class="w-20 text-right shrink-0 text-[11px] text-gray-600">无行情</div>
        <span
          v-if="hitCodes.has(r.code)"
          class="px-1.5 py-0.5 rounded text-[11px] bg-bull/15 text-bull shrink-0"
          title="该股在最近一次选股中命中了信号"
        >命中</span>
        <button
          class="px-2 py-1 text-[11px] rounded border border-edge text-gray-500 hover:text-bear hover:border-bear/40 shrink-0"
          title="移出自选"
          @click.stop="remove(r)"
        >
          移出
        </button>
      </div>
    </div>
  </div>
</template>
