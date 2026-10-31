<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { useStockStore } from '../stores/stockStore';
import KLineChart from '../components/KLineChart.vue';
import SignalTag from '../components/SignalTag.vue';
import { SIGNAL_TYPE_LABELS, strategyLabel } from '@shared/constants/strategies';

const route = useRoute();
const store = useStockStore();
const detail = computed(() => store.stockDetail);
const code = computed(() => String(route.params.code));

// ---- 自选股（M4）----
/** 当前股是否已在自选里 */
const isWatched = ref(false);
const adding = ref(false);
/** 加自选时弹出的成本价/分组小表单 */
const showAddForm = ref(false);
const costInput = ref('');
const groupInput = ref('观察');

async function refreshWatchState(): Promise<void> {
  isWatched.value = await store.hasWatch(code.value);
}

async function doAdd(): Promise<void> {
  adding.value = true;
  try {
    const cost = costInput.value.trim() === '' ? null : Number(costInput.value);
    const r = await store.upsertWatch({
      code: code.value,
      group: groupInput.value.trim() || '观察',
      costPrice: cost !== null && Number.isFinite(cost) && cost > 0 ? cost : null,
    });
    if (r.ok) {
      isWatched.value = true;
      showAddForm.value = false;
      costInput.value = '';
    }
  } finally {
    adding.value = false;
  }
}

async function doRemove(): Promise<void> {
  await store.removeWatch(code.value);
  isWatched.value = false;
}

/** 最新一根 K 线相对昨收的涨跌（A 股口径：涨=红、跌=绿） */
const quote = computed(() => {
  const bars = detail.value?.bars ?? [];
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const pre = last.preClose || bars[bars.length - 2]?.close || 0;
  const change = +(last.close - pre).toFixed(2);
  return {
    date: last.date,
    close: last.close,
    change,
    pct: pre > 0 ? +((change / pre) * 100).toFixed(2) : 0,
    amount: last.amount,
    volume: last.volume,
  };
});

/** 信号按触发日倒序（图上标签是中文短名，这里给全名 + 分数明细） */
const marksDesc = computed(() =>
  [...(detail.value?.marks ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1)),
);

/** 各策略信号计数：一眼看出这只票主要被哪套策略盯上 */
const summary = computed(() => {
  const m = new Map<string, number>();
  for (const k of detail.value?.marks ?? []) m.set(k.strategyId, (m.get(k.strategyId) ?? 0) + 1);
  return [...m.entries()]
    .map(([id, n]) => ({ id, n, label: strategyLabel(id) }))
    .sort((a, b) => b.n - a.n);
});

onMounted(() => {
  void store.loadStockDetail(code.value);
  void refreshWatchState();
});
watch(code, (c) => {
  void store.loadStockDetail(c);
  void refreshWatchState();
  showAddForm.value = false;
});
</script>

<template>
  <div>
    <div v-if="store.loading && !detail" class="text-gray-500 py-20 text-center">加载中…</div>
    <div v-else-if="!detail" class="text-gray-500 py-20 text-center">
      未找到该股票（代码：{{ code }}）
      <RouterLink to="/market" class="text-accent ml-2 hover:underline">去「A股行情」看看</RouterLink>
    </div>

    <div v-else class="flex flex-col gap-4">
      <div class="flex items-start justify-between">
        <div>
          <div class="flex items-baseline gap-3">
            <h1 class="text-2xl font-bold">{{ detail.meta.name || detail.meta.code }}</h1>
            <span class="text-xs text-gray-500 font-mono">{{ detail.meta.code }}</span>
            <span class="text-xs text-gray-500">
              {{ detail.meta.industry || '行业未知' }} · {{ detail.meta.market.toUpperCase() }}
            </span>
          </div>
          <div v-if="quote" class="flex items-baseline gap-3 mt-1">
            <span
              class="text-xl font-mono font-bold"
              :class="quote.change > 0 ? 'text-bull' : quote.change < 0 ? 'text-bear' : 'text-gray-300'"
            >
              {{ quote.close.toFixed(2) }}
            </span>
            <span
              class="text-sm font-mono"
              :class="quote.change > 0 ? 'text-bull' : quote.change < 0 ? 'text-bear' : 'text-gray-400'"
            >
              {{ quote.change > 0 ? '+' : '' }}{{ quote.change.toFixed(2) }}
              （{{ quote.pct > 0 ? '+' : '' }}{{ quote.pct.toFixed(2) }}%）
            </span>
            <span class="text-xs text-gray-500">{{ quote.date }}</span>
          </div>
        </div>
        <div class="flex flex-col items-end gap-2 shrink-0">
          <span class="text-xs text-gray-500 text-right">
            近 {{ detail.bars.length }} 根 K 线 · {{ detail.marks.length }} 个信号点<br />
            <span class="text-gray-600">图上的信号 pin 已用中文短名标注</span>
          </span>
          <!-- 自选股按钮（M4） -->
          <div class="flex items-center gap-2">
            <button
              v-if="!isWatched && !showAddForm"
              class="px-3 py-1 text-xs rounded-lg border border-accent/50 text-accent hover:bg-accent/10"
              title="加入我的自选（可录成本价算浮动盈亏）"
              @click="showAddForm = true"
            >
              ＋ 加自选
            </button>
            <button
              v-else-if="isWatched"
              class="px-3 py-1 text-xs rounded-lg border border-edge text-gray-500 hover:text-bear hover:border-bear/40"
              title="从自选中移除"
              @click="doRemove"
            >
              ✓ 已自选 · 移出
            </button>
          </div>
          <!-- 加自选小表单：分组 + 成本价（选填） -->
          <div
            v-if="showAddForm"
            class="flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-2 py-1.5"
          >
            <input
              v-model="groupInput"
              placeholder="分组"
              class="bg-panel2 border border-edge rounded px-1.5 py-0.5 text-xs text-gray-200 w-16"
            />
            <input
              v-model="costInput"
              placeholder="成本价(选填)"
              class="bg-panel2 border border-edge rounded px-1.5 py-0.5 text-xs text-gray-200 w-20"
            />
            <button
              class="px-2 py-0.5 text-xs rounded bg-accent/20 text-accent disabled:opacity-40"
              :disabled="adding"
              @click="doAdd"
            >
              确定
            </button>
            <button class="px-2 py-0.5 text-xs text-gray-500" @click="showAddForm = false">取消</button>
          </div>
        </div>
      </div>

      <div class="bg-panel2 border border-edge rounded-xl p-2">
        <KLineChart
          :bars="detail.bars"
          :marks="detail.marks"
          :limit-up="{ code: detail.meta.code, name: detail.meta.name }"
          height="560px"
        />
      </div>

      <div class="bg-panel2 border border-edge rounded-xl p-4">
        <div class="flex items-center justify-between mb-3">
          <div class="text-sm font-bold">信号标记（按触发日）</div>
          <div v-if="summary.length" class="flex flex-wrap gap-2 text-xs text-gray-400">
            <span v-for="s in summary" :key="s.id" class="px-2 py-0.5 rounded bg-panel border border-edge">
              {{ s.label }} <b class="text-accent">{{ s.n }}</b> 次
            </span>
          </div>
        </div>
        <div v-if="detail.marks.length === 0" class="text-xs text-gray-500">该区间内无策略发出信号。</div>
        <div v-else class="flex flex-wrap gap-2">
          <div
            v-for="(m, i) in marksDesc"
            :key="i"
            class="flex items-center gap-2 bg-panel border border-edge rounded-lg px-2 py-1 text-xs"
            :title="`${strategyLabel(m.strategyId)} · ${SIGNAL_TYPE_LABELS[m.type]} · 评分 ${m.score}`"
          >
            <SignalTag :type="m.type" />
            <span class="text-gray-200">{{ strategyLabel(m.strategyId) }}</span>
            <span class="text-gray-500">{{ m.date }}</span>
            <span class="text-accent font-bold">{{ m.score }}</span>
          </div>
        </div>
        <div v-if="detail.marks.length" class="mt-2 text-[11px] text-gray-600">
          图例：pin 上的 2 字中文即策略短名（均线 / 趋势 / 断板 / N字 / 海龟 / 放量 / 跌停）；
          颜色区分信号大类 —— 趋势（红）/ 反包（紫）/ 突破（蓝）/ 跌停反包（绿）。
          副图 MACD：DIF（蓝）/ DEA（黄）/ 柱（红=今≥昨，绿=今<昨）；
          K 线下方的红色小三角为涨停日（连板 ≥2 标注「板n」，交易所口径判定）。
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-panel2 border border-edge rounded-xl p-4">
          <div class="text-sm font-bold mb-2">筹码分布</div>
          <p class="text-xs text-gray-500 leading-relaxed">
            阶段三占位：接入真实行情后，此处展示筹码峰（成本分布）与获利盘比例。
          </p>
        </div>
        <div class="bg-panel2 border border-edge rounded-xl p-4">
          <div class="text-sm font-bold mb-2">龙虎榜数据</div>
          <p class="text-xs text-gray-500 leading-relaxed">
            阶段三占位：接入开盘啦 / 东方财富龙虎榜接口后，展示上榜营业部与买卖席位。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
