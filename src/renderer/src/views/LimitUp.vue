<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useStockStore } from '../stores/stockStore';
import type { LimitUpRow } from '@shared/types/ipc';
import { fmtAmount, fmtPct } from '../utils/market';

const store = useStockStore();
const router = useRouter();

/** 查询日期（空串 = 最新交易日） */
const queryDate = ref('');
const visible = ref(200);
const PAGE = 200;

const result = computed(() => store.limitUpResult);
const rows = computed(() => result.value?.rows ?? []);
const isMock = computed(() => store.dbStatus.dataSource === 'mock');
const shown = computed(() => rows.value.slice(0, visible.value));

onMounted(() => {
  void store.loadLimitUpPool();
  void store.loadHealth();
});

/** 数据健康（v0.9.3）：覆盖不全或未知都提示——涨停池扫的是本地库，缺标的=漏涨停股 */
const healthLow = computed(() => {
  const h = store.health;
  if (!h) return false;
  return h.universeSize === null || h.stocksCount < h.universeSize * 0.95;
});
const healthUnknown = computed(
  () => !!store.health && store.health.universeSize === null,
);

function query(): void {
  // input[type=date] 空串 = 查最新
  void store.loadLimitUpPool(queryDate.value || undefined, true);
}

/** 连板标注：窗口内全连板 → 「n连板」；否则「N天M板」 */
function streakLabel(r: LimitUpRow): string {
  if (r.windowDays === r.streak) return `${r.streak} 连板`;
  return `${r.windowDays}天${r.windowBoards}板`;
}

function open(r: LimitUpRow): void {
  void router.push(`/stock/${r.code}`);
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-bold">涨停池</h1>
        <p class="text-xs text-gray-500 mt-0.5">
          基于本地日 K 收盘判定（四舍五入到分）。点击任意一行查看个股 K 线详情。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="queryDate"
          type="date"
          class="bg-panel2 border border-panel2 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:border-accent/60 outline-none [color-scheme:dark]"
        />
        <button
          @click="query"
          :disabled="store.limitUpLoading"
          class="px-3 py-1.5 rounded-lg border border-accent/40 text-accent text-sm hover:bg-panel2 disabled:opacity-50"
        >
          {{ store.limitUpLoading ? '扫描中…' : '查询' }}
        </button>
        <button
          @click="store.loadLimitUpPool(queryDate || undefined, true)"
          :disabled="store.limitUpLoading"
          class="px-3 py-1.5 rounded-lg border border-panel2 text-sm hover:bg-panel2 disabled:opacity-50"
        >
          刷新
        </button>
      </div>
    </div>

    <!-- 数据覆盖提示（v0.9.2）：缺标的 = 漏涨停股 -->
    <div
      v-if="healthLow && store.health"
      class="mb-3 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn"
    >
      <span v-if="healthUnknown">
        ⚠️ 本地数据覆盖度未知（本地 {{ store.health.stocksCount }} 只，从未对照全市场名单校验），本页可能漏掉部分涨停股。
      </span>
      <span v-else>
        ⚠️ 本地数据覆盖不全（{{ store.health.stocksCount }} / 全市场
        {{ store.health.universeSize }} 只），本页可能漏掉部分涨停股。
      </span>
      请到「仪表盘」点击「补拉缺失标的」后再来。
    </div>

    <!-- 概览条 -->
    <div
      v-if="result"
      class="flex flex-wrap items-center gap-x-5 gap-y-1 mb-3 rounded-lg bg-panel2 px-3 py-2 text-xs text-gray-400"
    >
      <span>判定日 <b class="text-gray-200">{{ result.date }}</b></span>
      <span>共 <b class="text-gray-200">{{ rows.length }}</b> 只</span>
      <span>首板 <b class="text-bull">{{ result.distribution.first }}</b></span>
      <span>2连板 <b class="text-bull">{{ result.distribution.two }}</b></span>
      <span>3连板+ <b class="text-bull">{{ result.distribution.threePlus }}</b></span>
      <span>最高 <b class="text-accent">{{ result.distribution.maxStreak }}</b> 连板</span>
      <span
        class="px-1.5 py-0.5 rounded"
        :class="isMock ? 'bg-warn/15 text-warn' : 'bg-bull/15 text-bull'"
      >
        {{ isMock ? '演示数据' : '真实行情' }}
      </span>
      <span
        v-if="result.stSuspectCount > 0"
        class="text-warn"
        title="ST 按当前股票名称判定，历史时点可能已摘帽/戴帽，存在 5%/10% 误判可能"
      >
        ST 判定 {{ result.stSuspectCount }} 条（时点近似） ⓘ
      </span>
    </div>

    <div v-if="store.limitUpLoading && rows.length === 0" class="text-gray-500 py-20 text-center">
      正在扫描全市场涨停形态…
    </div>
    <div v-else-if="result && rows.length === 0" class="text-gray-500 py-20 text-center">
      <template v-if="isMock">
        演示数据无真实涨停形态，无入库标的。请先在仪表盘点「增量更新数据」用内置行情接口回填数据。
      </template>
      <template v-else>
        {{ result.date }} 无收盘涨停标的（或该日无数据）。
      </template>
    </div>
    <div v-else-if="!result" class="text-gray-500 py-20 text-center">
      本地还没有行情数据。请到「仪表盘」点击「增量更新数据」或「全量回填」拉取。
    </div>

    <div v-else class="rounded-xl border border-edge overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-panel2 text-xs text-gray-400">
          <tr>
            <th class="text-left px-3 py-2">代码</th>
            <th class="text-left px-3 py-2">名称</th>
            <th class="text-right px-3 py-2">收盘价</th>
            <th class="text-right px-3 py-2">涨幅</th>
            <th class="text-right px-3 py-2">连板</th>
            <th class="text-left px-3 py-2">标注</th>
            <th class="text-left px-3 py-2">首板日</th>
            <th class="text-right px-3 py-2">成交额</th>
            <th class="text-left px-3 py-2">行业</th>
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
            <td class="px-3 py-1.5 font-medium">
              {{ r.name || '—' }}
              <span v-if="r.stSuspect" class="ml-1 px-1 rounded text-[10px] bg-warn/15 text-warn">ST</span>
              <span v-if="r.isOneWord" class="ml-1 px-1 rounded text-[10px] bg-bull/15 text-bull">一字</span>
            </td>
            <td class="px-3 py-1.5 text-right font-mono text-bull">{{ r.close.toFixed(2) }}</td>
            <td class="px-3 py-1.5 text-right font-mono text-bull">{{ fmtPct(r.changePct * 100) }}</td>
            <td class="px-3 py-1.5 text-right font-mono font-bold text-bull">{{ r.streak }}</td>
            <td class="px-3 py-1.5 text-accent">{{ streakLabel(r) }}</td>
            <td class="px-3 py-1.5 text-xs text-gray-500">{{ r.firstDate }}</td>
            <td class="px-3 py-1.5 text-right font-mono text-gray-300">{{ fmtAmount(r.amount) }}</td>
            <td class="px-3 py-1.5 text-xs text-gray-500">{{ r.industry || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div
        v-if="visible < rows.length"
        class="px-3 py-2 border-t border-edge/60 bg-panel2 text-xs text-gray-400 flex items-center justify-between"
      >
        <span>已显示 {{ shown.length }} / {{ rows.length }} 只</span>
        <button
          @click="visible += PAGE"
          class="px-2 py-1 rounded border border-panel2 hover:bg-panel"
        >
          加载更多
        </button>
      </div>
    </div>

    <!-- 口径局限说明 -->
    <div v-if="result" class="mt-3 text-[11px] text-gray-600 leading-relaxed">
      口径说明：① 涨停 = 收盘价 ≥ round(昨收 × (1 + 涨幅上限), 2)，上限按板块取 10%（沪深主板）/ 20%（创业板・科创板）/ 5%（ST）；
      ② 昨收为后复权口径，除权日附近如出现整板漏判/多判属复权基准差异；③ ST 按当前股票名称近似，历史时点可能已摘帽/戴帽；
      ④ 「N天M板」按交易日计，窗口最多 10 个交易日，超过只显示连板数。
    </div>
  </div>
</template>
