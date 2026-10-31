<script setup lang="ts">
/**
 * 板块/行业（M2）—— 浏览新浪行业板块涨幅榜，点开看成分股。
 *
 * 数据需先点「刷新板块」从新浪拉取并落库（本页不自动拉，避免每次进来就打新浪）。
 * 板块涨跌幅/成交额/领涨股来自板块源（新浪）；成分股的收盘/涨跌叠加**本地行情库**
 * 最新一根 K 线（与「A股行情」同源），库外成分只显示代码/名称。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { quantApi } from '../api/quantApi';
import type { SectorDetail, SectorRow } from '@shared/types/ipc';
import { fmtPct, pctClass } from '../utils/market';

const router = useRouter();

const sort = ref<'changePct' | 'amount'>('changePct');
const rows = ref<SectorRow[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const msg = ref('');
/** 展开的板块详情（null=只看列表） */
const detail = ref<SectorDetail | null>(null);
const detailLoading = ref(false);

async function loadList(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await quantApi().invoke('sector:list', { sort: sort.value });
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  msg.value = '正在从新浪拉取板块与成分（约十几秒）…';
  try {
    const r = await quantApi().invoke('sector:refresh', { withMembers: true });
    if (r.ok) {
      msg.value = `已刷新：${r.sectors} 个板块 / ${r.members} 条成分`;
      await loadList();
    } else {
      msg.value = `刷新失败：${r.error ?? '未知错误'}`;
    }
  } catch (e) {
    msg.value = `刷新失败：${String(e)}`;
  } finally {
    refreshing.value = false;
  }
}

async function open(row: SectorRow): Promise<void> {
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await quantApi().invoke('sector:detail', { id: row.id });
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail(): void {
  detail.value = null;
}

function openStock(code: string): void {
  void router.push(`/stock/${code}`);
}

onMounted(loadList);
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-bold">板块 / 行业</h1>
        <p class="text-xs text-gray-500 mt-0.5">
          新浪行业板块涨跌幅榜。板块数据来自板块源，成分股涨跌叠加本地行情库（非实时报价）。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <select v-model="sort" class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200" @change="loadList">
          <option value="changePct">按涨幅</option>
          <option value="amount">按成交额</option>
        </select>
        <button
          class="px-3 py-1 text-xs rounded-lg border border-panel2 hover:bg-panel2 text-gray-300 disabled:opacity-50"
          :disabled="refreshing"
          @click="refresh"
        >
          {{ refreshing ? '刷新中…' : '刷新板块' }}
        </button>
      </div>
    </div>

    <div v-if="msg" class="mb-3 rounded-lg bg-panel2 px-3 py-2 text-xs text-gray-400">{{ msg }}</div>

    <!-- 空态：还没拉过 -->
    <div v-if="!loading && rows.length === 0" class="rounded-lg bg-panel2 border border-edge py-16 text-center">
      <p class="text-sm text-gray-400 mb-1">还没有板块数据</p>
      <p class="text-xs text-gray-600">点右上角「刷新板块」从新浪拉取（首次约十几秒）。</p>
    </div>

    <div v-else-if="loading" class="text-sm text-gray-500 py-16 text-center">读取中…</div>

    <div v-else class="flex gap-4">
      <!-- 板块列表 -->
      <div class="flex-1 grid gap-1" :class="detail ? 'lg:max-w-md' : ''">
        <div
          v-for="s in rows"
          :key="s.id"
          class="flex items-center gap-3 rounded-lg bg-panel2 border border-edge px-3 py-2 cursor-pointer hover:border-accent/40"
          :class="detail?.id === s.id ? 'border-accent' : ''"
          @click="open(s)"
        >
          <div class="flex-1 min-w-0">
            <div class="text-sm text-gray-200 font-medium truncate">{{ s.name }}</div>
            <div class="text-[11px] text-gray-500">
              {{ s.stockCount }} 只 · 库内 {{ s.memberCount }} 只
            </div>
          </div>
          <div class="text-right shrink-0 w-20">
            <div class="text-sm font-medium" :class="pctClass(s.changePct)">{{ fmtPct(s.changePct) }}%</div>
            <div class="text-[11px] text-gray-600">{{ (s.amount / 1e8).toFixed(0) }}亿</div>
          </div>
          <div class="text-right shrink-0 w-24 hidden sm:block">
            <div class="text-[11px] text-gray-400 truncate">{{ s.leaderName }}</div>
            <div class="text-[11px]" :class="pctClass(s.leaderChangePct)">{{ fmtPct(s.leaderChangePct) }}%</div>
          </div>
        </div>
      </div>

      <!-- 板块详情（成分股） -->
      <div v-if="detailLoading" class="flex-1 text-sm text-gray-500 py-16 text-center">读取成分…</div>
      <div v-else-if="detail" class="flex-1 rounded-xl bg-panel2 border border-edge p-4">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="text-lg font-bold">{{ detail.name }}</h2>
            <p class="text-xs text-gray-500 mt-0.5">
              涨幅 <b :class="pctClass(detail.changePct)">{{ fmtPct(detail.changePct) }}%</b> ·
              {{ detail.stockCount }} 只 · 领涨 {{ detail.leaderName }}
              <b :class="pctClass(detail.leaderChangePct)">{{ fmtPct(detail.leaderChangePct) }}%</b>
            </p>
          </div>
          <button class="px-2 py-1 text-xs text-gray-500 hover:text-gray-200" @click="closeDetail">关闭 ✕</button>
        </div>
        <div class="grid gap-1">
          <div
            v-for="m in detail.members"
            :key="m.code"
            class="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-panel cursor-pointer"
            :class="m.inLibrary ? '' : 'opacity-50'"
            @click="openStock(m.code)"
          >
            <div class="flex-1 min-w-0">
              <div class="text-sm text-gray-200 truncate">{{ m.name }}</div>
              <div class="text-[11px] text-gray-500">{{ m.code }}</div>
            </div>
            <div v-if="m.inLibrary" class="text-right shrink-0 w-24">
              <div class="text-sm font-medium" :class="m.changePct === null ? '' : pctClass(m.changePct)">
                {{ m.changePct === null ? '—' : fmtPct(m.changePct) + '%' }}
              </div>
              <div class="text-[11px] text-gray-600">{{ m.close?.toFixed(2) ?? '—' }}</div>
            </div>
            <div v-else class="text-[11px] text-gray-600 shrink-0 w-24 text-right">库内无行情</div>
          </div>
        </div>
        <p class="text-[11px] text-gray-600 mt-3">「库内无行情」= 该成分在本软件行情库里还没有 K 线（未回填到），仅板块源有它的归属。</p>
      </div>
    </div>
  </div>
</template>
