<script setup lang="ts">
/**
 * 市场情绪看板（M3）—— 辅助仓位决策。
 *
 * 全部指标由本地 daily 表实时算出（零新数据源），与涨停池同口径（交易所严格涨跌停判定）。
 * 温度 0~100 的打分口径见 strategy/sentiment.ts 文件头（固定权重、可解释）。
 */
import { computed, onMounted, ref } from 'vue';
import { useStockStore } from '../stores/stockStore';
import type { SentimentLevel, SentimentSnapshot } from '@shared/types/ipc';

const store = useStockStore();
const historyDays = ref(30);

const result = computed(() => store.sentimentResult);
const cur = computed<SentimentSnapshot | null>(() => result.value?.current ?? null);

/** 温度配色：冰点冷蓝 → 过热红（A 股口径：越热越红） */
function levelColor(level: SentimentLevel): string {
  switch (level) {
    case '冰点':
      return '#60a5fa';
    case '偏冷':
      return '#22d3ee';
    case '中性':
      return '#fbbf24';
    case '偏热':
      return '#fb923c';
    case '过热':
      return '#f87171';
    default:
      return '#9ca3af';
  }
}

/** 涨跌家数比（红涨绿跌口径：这里只算比值，配色在模板里给） */
const upDownRatio = computed(() => {
  const c = cur.value;
  if (!c) return null;
  const d = c.down;
  if (d === 0) return null;
  return +(c.up / d).toFixed(2);
});

/** 情绪温度曲线（内联 SVG 折线，不引 ECharts——这条曲线很简单，不值得为它加载图表库） */
const curve = computed(() => {
  const hs = result.value?.history ?? [];
  if (hs.length < 2) return null;
  const W = 720;
  const H = 120;
  const PAD = 6;
  const stepX = (W - PAD * 2) / (hs.length - 1);
  const yOf = (v: number): number => H - PAD - (v / 100) * (H - PAD * 2);
  const pts = hs.map((s, i) => ({ x: PAD + i * stepX, y: yOf(s.score), s }));
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${PAD},${H - PAD} ${line} ${(PAD + (hs.length - 1) * stepX).toFixed(1)},${H - PAD}`;
  return { W, H, pts, line, area, last: pts[pts.length - 1] };
});

/** 连板分布（按板数从高到低展示） */
const streakRows = computed(() => {
  const d = cur.value?.streakDist ?? {};
  return Object.entries(d)
    .map(([k, v]) => ({ streak: Number(k), count: v }))
    .sort((a, b) => b.streak - a.streak);
});
const maxStreakCount = computed(() => Math.max(1, ...streakRows.value.map((r) => r.count)));

onMounted(() => void store.loadSentiment(undefined, historyDays.value));

function reload(): void {
  void store.loadSentiment(undefined, historyDays.value, true);
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-bold">市场情绪</h1>
        <p class="text-xs text-gray-500 mt-0.5">
          情绪温度 0~100，用于辅助仓位决策。指标由本地行情库实时统计（交易所严格涨跌停口径），非实时报价。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <select
          v-model.number="historyDays"
          class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200"
          @change="reload"
        >
          <option :value="10">回看 10 日</option>
          <option :value="30">回看 30 日</option>
          <option :value="60">回看 60 日</option>
        </select>
        <button
          class="px-3 py-1 text-xs rounded-lg border border-panel2 hover:bg-panel2 text-gray-300 disabled:opacity-50"
          :disabled="store.sentimentLoading"
          @click="reload"
        >
          {{ store.sentimentLoading ? '统计中…' : '重新统计' }}
        </button>
      </div>
    </div>

    <div v-if="store.sentimentLoading" class="text-sm text-gray-500 py-16 text-center">
      正在全市场统计情绪…（约十几秒）
    </div>

    <div v-else-if="!cur" class="text-sm text-gray-500 py-16 text-center">
      暂无情绪数据，请先「增量更新数据」。
    </div>

    <div v-else class="flex flex-col gap-4">
      <!-- 温度计 + 核心指标 -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <!-- 温度计 -->
        <div class="rounded-xl bg-panel2 border border-edge p-4 flex flex-col items-center justify-center">
          <div class="text-xs text-gray-500 mb-1">情绪温度（{{ cur.date }}）</div>
          <div class="text-5xl font-black" :style="{ color: levelColor(cur.level) }">{{ cur.score }}</div>
          <div class="mt-1 text-sm font-medium" :style="{ color: levelColor(cur.level) }">{{ cur.level }}</div>
          <!-- 温度条 -->
          <div class="w-full mt-3 h-2 rounded-full bg-panel overflow-hidden">
            <div
              class="h-full rounded-full transition-all"
              :style="{ width: cur.score + '%', background: levelColor(cur.level) }"
            ></div>
          </div>
          <div class="text-[11px] text-gray-600 mt-3 text-center leading-relaxed">
            冰点 · 偏冷 · 中性 · 偏热 · 过热<br />
            <span class="text-gray-500">仅供辅助参考，非投资建议</span>
          </div>
        </div>

        <!-- 指标卡 -->
        <div class="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div class="rounded-xl bg-panel2 border border-edge p-3">
            <div class="text-xs text-gray-500">涨停 / 跌停</div>
            <div class="mt-1">
              <span class="text-2xl font-bold text-bull">{{ cur.limitUp }}</span>
              <span class="text-gray-600"> / </span>
              <span class="text-2xl font-bold text-bear">{{ cur.limitDown }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-panel2 border border-edge p-3">
            <div class="text-xs text-gray-500">涨 / 跌 / 平</div>
            <div class="mt-1 text-lg font-bold">
              <span class="text-bull">{{ cur.up }}</span>
              <span class="text-gray-600"> / </span>
              <span class="text-bear">{{ cur.down }}</span>
              <span class="text-gray-600"> / </span>
              <span class="text-gray-400">{{ cur.flat }}</span>
            </div>
            <div v-if="upDownRatio !== null" class="text-[11px] text-gray-500 mt-0.5">涨跌比 {{ upDownRatio }}</div>
          </div>
          <div class="rounded-xl bg-panel2 border border-edge p-3">
            <div class="text-xs text-gray-500">最高连板（空间板）</div>
            <div class="mt-1 text-2xl font-bold text-accent">{{ cur.maxStreak }}<span class="text-sm text-gray-500"> 板</span></div>
          </div>
          <div class="rounded-xl bg-panel2 border border-edge p-3">
            <div class="text-xs text-gray-500" title="昨日涨停股今日平均涨幅（打板赚钱效应）">昨日涨停今表现</div>
            <div class="mt-1 text-2xl font-bold" :class="cur.yesterdayLimitUpPerf === null ? 'text-gray-500' : (cur.yesterdayLimitUpPerf >= 0 ? 'text-bull' : 'text-bear')">
              {{ cur.yesterdayLimitUpPerf === null ? '—' : (cur.yesterdayLimitUpPerf >= 0 ? '+' : '') + cur.yesterdayLimitUpPerf + '%' }}
            </div>
          </div>
          <div class="rounded-xl bg-panel2 border border-edge p-3">
            <div class="text-xs text-gray-500">全市场成交量</div>
            <div class="mt-1 text-2xl font-bold text-gray-200">{{ (cur.totalVolume / 1e8).toFixed(0) }}<span class="text-sm text-gray-500"> 亿股</span></div>
          </div>
          <div class="rounded-xl bg-panel2 border border-edge p-3">
            <div class="text-xs text-gray-500">全市场成交额</div>
            <div class="mt-1 text-2xl font-bold text-gray-200">
              <template v-if="cur.totalAmount !== null">{{ (cur.totalAmount / 1e8).toFixed(0) }}<span class="text-sm text-gray-500"> 亿</span></template>
              <span v-else class="text-sm text-gray-500">源不提供</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 情绪温度曲线 -->
      <div class="rounded-xl bg-panel2 border border-edge p-4">
        <div class="text-sm font-medium mb-2">情绪温度走势（近 {{ result?.history.length ?? 0 }} 个交易日）</div>
        <svg v-if="curve" :viewBox="`0 0 ${curve.W} ${curve.H}`" class="w-full" style="height: 130px">
          <!-- 50 分中性参考线 -->
          <line :x1="6" :y1="curve.H - 6 - 0.5 * (curve.H - 12)" :x2="curve.W - 6" :y2="curve.H - 6 - 0.5 * (curve.H - 12)"
            stroke="#4b5563" stroke-width="1" stroke-dasharray="4 4" />
          <!-- 面积 + 折线 -->
          <polygon :points="curve.area" fill="rgba(251,191,36,0.08)" />
          <polyline :points="curve.line" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          <!-- 各点 tooltip（title） -->
          <circle v-for="p in curve.pts" :key="p.s.date" :cx="p.x" :cy="p.y" r="6" fill="transparent">
            <title>{{ p.s.date }} 温度{{ p.s.score }}（{{ p.s.level }}） 涨停{{ p.s.limitUp }} 跌停{{ p.s.limitDown }} {{ p.s.maxStreak }}板</title>
          </circle>
        </svg>
        <div v-else class="text-xs text-gray-600 py-6 text-center">历史数据不足（需至少 2 个交易日）</div>
        <div class="flex justify-between text-[11px] text-gray-600 mt-1" v-if="curve">
          <span>{{ result?.history[0]?.date }}</span>
          <span>{{ cur.date }}</span>
        </div>
      </div>

      <!-- 连板高度分布 -->
      <div class="rounded-xl bg-panel2 border border-edge p-4">
        <div class="text-sm font-medium mb-3">连板高度分布（打板梯队）</div>
        <div v-if="streakRows.length === 0" class="text-xs text-gray-600 py-4 text-center">当日无涨停</div>
        <div v-else class="flex flex-col gap-1.5">
          <div v-for="r in streakRows" :key="r.streak" class="flex items-center gap-3">
            <span class="w-14 text-xs text-gray-400 shrink-0">{{ r.streak }}板</span>
            <div class="flex-1 h-4 bg-panel rounded overflow-hidden">
              <div class="h-full bg-accent/70 rounded" :style="{ width: (r.count / maxStreakCount) * 100 + '%' }"></div>
            </div>
            <span class="w-10 text-right text-xs text-gray-300 shrink-0">{{ r.count }} 只</span>
          </div>
        </div>
      </div>

      <p class="text-[11px] text-gray-600 leading-relaxed">
        说明：涨跌停采用交易所严格口径（ST 5% / 主板 10% / 创业板·科创板 20%），非「涨跌幅≥9.5%」粗判；
        情绪温度为固定权重综合打分（涨停占比 40 + 涨跌比 30 + 连板高度 20 + 打板溢价 10），仅供辅助参考，不构成投资建议。
      </p>
    </div>
  </div>
</template>
