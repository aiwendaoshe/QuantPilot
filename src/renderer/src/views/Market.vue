<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useStockStore } from '../stores/stockStore';
import type { MarketRow } from '@shared/types/ipc';
import {
  filterMarket,
  fmtAmount,
  fmtChange,
  fmtPct,
  fmtVolume,
  marketStats,
  pctClass,
  sortMarket,
  type MarketSortKey,
} from '../utils/market';

const store = useStockStore();
const router = useRouter();

const keyword = ref('');
const sortKey = ref<MarketSortKey>('changePct');
const sortAsc = ref(false);
const visible = ref(200);
const PAGE = 200;

const rows = computed(() => store.marketRows);
const isMock = computed(() => store.dbStatus.dataSource === 'mock');
const stats = computed(() => marketStats(rows.value));
const filtered = computed(() => sortMarket(filterMarket(rows.value, keyword.value), sortKey.value, sortAsc.value));
const shown = computed(() => filtered.value.slice(0, visible.value));

onMounted(() => void store.loadMarket());

function toggleSort(key: MarketSortKey): void {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = key;
    sortAsc.value = key === 'code';
  }
}

function open(row: MarketRow): void {
  void router.push(`/stock/${row.code}`);
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-bold">A 股行情</h1>
        <p class="text-xs text-gray-500 mt-0.5">
          已拉取到本地的标的行情（最新一根 K 线）。点击任意一行查看个股 K 线详情。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="keyword"
          placeholder="搜索代码 / 名称"
          class="bg-panel2 border border-panel2 rounded-lg px-3 py-1.5 text-sm w-48 placeholder:text-gray-600 focus:border-accent/60 outline-none"
        />
        <button
          @click="store.loadMarket(true)"
          :disabled="store.marketLoading"
          class="px-3 py-1.5 rounded-lg border border-panel2 text-sm hover:bg-panel2 disabled:opacity-50"
        >
          {{ store.marketLoading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 概览 -->
    <div class="flex flex-wrap items-center gap-x-5 gap-y-1 mb-3 rounded-lg bg-panel2 px-3 py-2 text-xs text-gray-400">
      <span>共 <b class="text-gray-200">{{ rows.length }}</b> 只</span>
      <span>上涨 <b class="text-bull">{{ stats.up }}</b></span>
      <span>下跌 <b class="text-bear">{{ stats.down }}</b></span>
      <span>平盘 <b class="text-gray-200">{{ stats.flat }}</b></span>
      <span v-if="store.dbStatus.barFrom && store.dbStatus.barTo">
        区间 <b class="text-gray-200">{{ store.dbStatus.barFrom }}</b> ~
        <b class="text-gray-200">{{ store.dbStatus.barTo }}</b>
      </span>
      <span
        class="px-1.5 py-0.5 rounded"
        :class="isMock ? 'bg-warn/15 text-warn' : 'bg-bull/15 text-bull'"
      >
        {{ isMock ? '演示数据' : '真实行情' }}
      </span>
      <span v-if="keyword" class="text-accent">筛选出 {{ filtered.length }} 只</span>
    </div>

    <div v-if="store.marketLoading && rows.length === 0" class="text-gray-500 py-20 text-center">
      正在读取本地行情…
    </div>
    <div v-else-if="rows.length === 0" class="text-gray-500 py-20 text-center">
      本地还没有行情数据。请到「仪表盘」点击「增量更新数据」或「全量回填」拉取。
    </div>

    <div v-else class="rounded-xl border border-edge overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-panel2 text-xs text-gray-400">
          <tr>
            <th class="text-left px-3 py-2 cursor-pointer select-none" @click="toggleSort('code')">
              代码{{ sortKey === 'code' ? (sortAsc ? ' ↑' : ' ↓') : '' }}
            </th>
            <th class="text-left px-3 py-2">名称</th>
            <th class="text-right px-3 py-2">最新价</th>
            <th class="text-right px-3 py-2">涨跌额</th>
            <th
              class="text-right px-3 py-2 cursor-pointer select-none"
              @click="toggleSort('changePct')"
            >
              涨跌幅{{ sortKey === 'changePct' ? (sortAsc ? ' ↑' : ' ↓') : '' }}
            </th>
            <th class="text-right px-3 py-2 cursor-pointer select-none" @click="toggleSort('amount')">
              成交额{{ sortKey === 'amount' ? (sortAsc ? ' ↑' : ' ↓') : '' }}
            </th>
            <th class="text-right px-3 py-2">成交量</th>
            <th class="text-right px-3 py-2">K线</th>
            <th class="text-left px-3 py-2">区间</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in shown"
            :key="r.code"
            class="border-t border-edge/60 hover:bg-panel2 cursor-pointer"
            @click="open(r)"
          >
            <td class="px-3 py-1.5 font-mono text-xs text-gray-400">{{ r.code }}</td>
            <td class="px-3 py-1.5 font-medium">{{ r.name || '—' }}</td>
            <td class="px-3 py-1.5 text-right font-mono" :class="pctClass(r.change)">
              {{ r.close.toFixed(2) }}
            </td>
            <td class="px-3 py-1.5 text-right font-mono" :class="pctClass(r.change)">
              {{ fmtChange(r.change) }}
            </td>
            <td class="px-3 py-1.5 text-right font-mono" :class="pctClass(r.changePct)">
              {{ fmtPct(r.changePct) }}
            </td>
            <td class="px-3 py-1.5 text-right font-mono text-gray-300">{{ fmtAmount(r.amount) }}</td>
            <td class="px-3 py-1.5 text-right font-mono text-gray-300">{{ fmtVolume(r.volume) }}</td>
            <td class="px-3 py-1.5 text-right text-xs text-gray-400">{{ r.bars }}</td>
            <td class="px-3 py-1.5 text-xs text-gray-500">{{ r.barFrom }} ~ {{ r.barTo }}</td>
          </tr>
        </tbody>
      </table>
      <div
        v-if="visible < filtered.length"
        class="px-3 py-2 border-t border-edge/60 bg-panel2 text-xs text-gray-400 flex items-center justify-between"
      >
        <span>已显示 {{ shown.length }} / {{ filtered.length }} 只</span>
        <button
          @click="visible += PAGE"
          class="px-2 py-1 rounded border border-panel2 hover:bg-panel"
        >
          加载更多
        </button>
      </div>
    </div>
  </div>
</template>
