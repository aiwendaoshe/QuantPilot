<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useStockStore } from '../stores/stockStore';
import EquityChart from '../components/EquityChart.vue';
import { buildReport } from '@shared/reportCore';
import type { BacktestOptions } from '@shared/types/backtest';
import type { StrategyId } from '@shared/types/signal';

const store = useStockStore();
const strategyId = ref<StrategyId | ''>('');
const running = computed(() => store.loading);

const opts = reactive<BacktestOptions>({
  initialCapital: 100_000,
  commissionRate: 0.0003,
  slippage: 0.001,
  stopLossPct: 0.07,
  takeProfitPct: 0,
  tPlusOne: true,
  holdDays: 5,
});
const startDate = ref('');
const endDate = ref('');
/** 用户手改过的区间记在 localStorage，下次进页面沿用（含默认口径） */
const RANGE_KEY = 'qp.backtest.range';
const rangeError = ref('');

/** 本地日期往前推 n 天（渲染进程时区 = 系统时区，直接用本地 Date） */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function today(): string {
  return daysAgo(0);
}

/**
 * 默认最近 1 年：结束＝昨天（当天尚未收盘，回测不能含今天），
 * 开始＝一年前的同一天（365 天前）。用户手动改过则以他改的为准。
 */
function loadDefaultRange(): { start: string; end: string } {
  try {
    const raw = window.localStorage.getItem(RANGE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as { start?: string; end?: string };
      if (o.start && o.end) return { start: o.start, end: o.end };
    }
  } catch {
    /* 读坏了就回落到默认口径 */
  }
  return { start: daysAgo(365), end: daysAgo(1) };
}

function persistRange(): void {
  try {
    window.localStorage.setItem(
      RANGE_KEY,
      JSON.stringify({ start: startDate.value, end: endDate.value }),
    );
  } catch {
    /* 隐私模式下写不进也不影响回测 */
  }
}

onMounted(async () => {
  await store.loadStrategies();
  if (store.strategies.length) strategyId.value = store.strategies[0].id;
  const r = loadDefaultRange();
  startDate.value = r.start;
  endDate.value = r.end;
});

const result = computed(() => store.backtestResult);

async function run(): Promise<void> {
  rangeError.value = '';
  if (!strategyId.value) return;
  const s = startDate.value;
  const e = endDate.value;
  if (!s || !e) {
    rangeError.value = '请填写起止日期';
    return;
  }
  if (s > e) {
    rangeError.value = '起始日期不能晚于结束日期';
    return;
  }
  if (e > today()) rangeError.value = '结束日期不能晚于今天（当天尚未收盘）';
  if (rangeError.value) return;

  persistRange();
  await store.runBacktest(strategyId.value, s, e, { ...opts });
}

// ---- 导出 Excel(M5) ----
const exporting = ref(false);
const exportMsg = ref('');
async function exportXlsx(): Promise<void> {
  if (!result.value) return;
  exporting.value = true;
  exportMsg.value = '';
  try {
    const r = await store.exportBacktestXlsx();
    if (r.canceled) exportMsg.value = '已取消导出';
    else if (r.ok) exportMsg.value = `已导出：${r.path ?? ''}`;
    else exportMsg.value = `导出失败：${r.error ?? '未知错误'}`;
  } catch (e) {
    exportMsg.value = `导出失败：${String(e)}`;
  } finally {
    exporting.value = false;
  }
}

// ---- 报告维度(M5)：由结果在渲染层就地聚合（与主进程 buildReport 同口径） ----
const report = computed(() => (result.value ? buildReport(result.value.equityCurve, result.value.trades) : null));
/** 离场原因中文名 */
const REASON_LABELS: Record<string, string> = {
  stopLoss: '止损',
  holdTimeout: '持仓到期',
  signalExit: '信号离场',
  endOfData: '回测结束强平',
};

// ---- 多策略横向对比(M5) ----
/** 参与对比的策略（默认全选，最多 7） */
const compareIds = ref<string[]>([]);
const compareMsg = ref('');
const compareResult = computed(() => store.compareResult);
function toggleCompare(id: string): void {
  const i = compareIds.value.indexOf(id);
  if (i >= 0) compareIds.value.splice(i, 1);
  else if (compareIds.value.length < 7) compareIds.value.push(id);
}
async function runCompare(): Promise<void> {
  compareMsg.value = '';
  if (compareIds.value.length === 0) {
    compareMsg.value = '请至少选择一个策略';
    return;
  }
  compareMsg.value = `正在对比 ${compareIds.value.length} 个策略（串行回测，请稍候…）`;
  try {
    await store.compareStrategies(compareIds.value, startDate.value, endDate.value, { ...opts });
    compareMsg.value = '';
  } catch (e) {
    compareMsg.value = `对比失败：${String(e)}`;
  }
}

// ---- 参数敏感度扫描(M5) ----
/** 选定要扫描的策略与参数 */
const sensStrategy = ref<StrategyId | ''>('');
const sensParam = ref('');
/** 网格点数量（默认 5，太多则慢——每次扫描=N 次完整回测） */
const sensPoints = ref(5);
/** 数值参数候选（来自当前策略 paramSchema 的 number 字段） */
const numericParams = computed(() => {
  const meta = store.strategies.find((s) => s.id === sensStrategy.value);
  return (meta?.paramSchema ?? []).filter((f) => f.type === 'number');
});
const sensResult = computed(() => store.sensitivityResult);
function onSensStrategyChange(): void {
  sensParam.value = numericParams.value[0]?.key ?? '';
}
/** 生成网格值：在 min~max 间均匀取 N 个（含端点），按 step 对齐 */
function gridValues(): number[] {
  const meta = store.strategies.find((s) => s.id === sensStrategy.value);
  const field = meta?.paramSchema.find((f) => f.key === sensParam.value);
  if (!field || field.type !== 'number' || field.min === undefined || field.max === undefined) return [];
  const n = Math.max(2, Math.min(9, sensPoints.value));
  const step = field.step && field.step > 0 ? field.step : (field.max - field.min) / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = field.min + ((field.max - field.min) * i) / (n - 1);
    if (step > 0 && step < 1) v = +v.toFixed(2);
    else v = Math.round(v);
    if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, 9);
}
async function runSensitivity(): Promise<void> {
  if (!sensStrategy.value || !sensParam.value) return;
  const values = gridValues();
  if (values.length === 0) return;
  try {
    await store.scanSensitivity(sensStrategy.value, sensParam.value, startDate.value, endDate.value, {
      ...opts,
    }, values);
  } catch (e) {
    sensMsg.value = `扫描失败：${String(e)}`;
  }
}
const sensMsg = ref('');

function pct(v: number): string {
  return (v * 100).toFixed(2) + '%';
}
const gainPct = computed(() =>
  result.value ? ((result.value.finalCapital / result.value.initialCapital - 1) * 100).toFixed(2) + '%' : '-',
);
</script>

<template>
  <div>
    <h1 class="text-xl font-bold mb-4">回测面板</h1>

    <div class="bg-panel2 border border-edge rounded-xl p-4 mb-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 items-end">
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        策略
        <select v-model="strategyId" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200">
          <option v-for="s in store.strategies" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        起始日期
        <input v-model="startDate" type="date" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        结束日期
        <input v-model="endDate" type="date" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        初始资金
        <input v-model.number="opts.initialCapital" type="number" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        止损%
        <input v-model.number="opts.stopLossPct" type="number" step="0.01" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
      </label>
      <label class="flex flex-col gap-1 text-xs text-gray-500">
        止盈%(0关)
        <input v-model.number="opts.takeProfitPct" type="number" step="0.01" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
      </label>
      <button
        @click="run"
        :disabled="running"
        class="px-4 py-1.5 rounded-lg bg-accent text-black text-sm font-medium disabled:opacity-50 h-[34px]"
      >
        {{ running ? '回测中…' : '运行回测' }}
      </button>
      <!-- 导出 Excel(M5)：需先有回测结果 -->
      <button
        v-if="result"
        @click="exportXlsx"
        :disabled="exporting"
        class="px-3 py-1.5 rounded-lg border border-edge text-gray-300 hover:bg-panel2 text-sm disabled:opacity-50 h-[34px]"
        title="导出回测摘要/分年/分月/交易明细/权益曲线到 Excel(.xlsx)"
      >
        {{ exporting ? '导出中…' : '导出 Excel' }}
      </button>
    </div>

    <div v-if="exportMsg" class="mb-3 rounded-lg bg-panel2 px-3 py-2 text-xs text-gray-400 break-all">
      {{ exportMsg }}
    </div>

    <div v-if="rangeError" class="mb-3 rounded-lg border border-bear/40 bg-bear/10 px-3 py-2 text-xs text-bear">
      {{ rangeError }}
    </div>

    <div v-if="!result" class="text-gray-500 py-20 text-center">选择策略与区间后点击「运行回测」。</div>

    <div v-else class="flex flex-col gap-4">
      <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <div class="bg-panel2 border border-edge rounded-lg p-3">
          <div class="text-[11px] text-gray-500">期末资金</div>
          <div class="text-lg font-bold text-accent">¥{{ result.finalCapital.toFixed(0) }}</div>
        </div>
        <div class="bg-panel2 border border-edge rounded-lg p-3">
          <div class="text-[11px] text-gray-500">收益率</div>
          <div class="text-lg font-bold" :class="result.finalCapital >= result.initialCapital ? 'text-bull' : 'text-bear'">{{ gainPct }}</div>
        </div>
        <div class="bg-panel2 border border-edge rounded-lg p-3">
          <div class="text-[11px] text-gray-500">胜率</div>
          <div class="text-lg font-bold">{{ pct(result.winRate) }}</div>
        </div>
        <div class="bg-panel2 border border-edge rounded-lg p-3">
          <div class="text-[11px] text-gray-500">盈亏比</div>
          <div class="text-lg font-bold">{{ result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2) }}</div>
        </div>
        <div class="bg-panel2 border border-edge rounded-lg p-3">
          <div class="text-[11px] text-gray-500">最大回撤</div>
          <div class="text-lg font-bold text-bear">{{ pct(result.maxDrawdown) }}</div>
        </div>
        <div class="bg-panel2 border border-edge rounded-lg p-3">
          <div class="text-[11px] text-gray-500">夏普</div>
          <div class="text-lg font-bold">{{ result.sharpe.toFixed(2) }}</div>
        </div>
        <div class="bg-panel2 border border-edge rounded-lg p-3">
          <div class="text-[11px] text-gray-500">交易次数</div>
          <div class="text-lg font-bold">{{ result.totalTrades }}</div>
        </div>
      </div>

      <div class="bg-panel2 border border-edge rounded-xl p-2">
        <EquityChart :result="result" height="380px" />
      </div>

      <!-- 报告维度(M5) -->
      <div v-if="report" class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <!-- 分年收益 -->
        <div class="bg-panel2 border border-edge rounded-xl p-4">
          <div class="text-sm font-bold mb-2">分年收益</div>
          <table class="w-full text-xs text-gray-300">
            <thead class="text-gray-500">
              <tr class="text-left border-b border-edge">
                <th class="py-1 pr-2">年份</th>
                <th class="py-1 pr-2 text-right">收益率</th>
                <th class="py-1 pr-2 text-right">成交</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="y in report.yearly" :key="y.year" class="border-b border-edge/40">
                <td class="py-1 pr-2">{{ y.year }}</td>
                <td class="py-1 pr-2 text-right font-medium" :class="y.returnPct >= 0 ? 'text-bull' : 'text-bear'">
                  {{ y.returnPct > 0 ? '+' : '' }}{{ y.returnPct.toFixed(2) }}%
                </td>
                <td class="py-1 pr-2 text-right text-gray-500">{{ y.trades }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 持仓期分布 + 离场原因 -->
        <div class="bg-panel2 border border-edge rounded-xl p-4">
          <div class="text-sm font-bold mb-2">持仓期分布（交易日）· 平均 {{ report.avgHoldingDays }} 日</div>
          <div class="flex flex-col gap-1">
            <div v-for="b in report.holdingDist" :key="b.label" class="flex items-center gap-2">
              <span class="w-14 text-[11px] text-gray-400 shrink-0">{{ b.label }}</span>
              <div class="flex-1 h-4 bg-panel rounded overflow-hidden">
                <div class="h-full bg-accent/70 rounded" :style="{ width: (b.count / Math.max(1, result.totalTrades)) * 100 + '%' }"></div>
              </div>
              <span class="w-16 text-right text-[11px] text-gray-400 shrink-0">{{ b.count }}笔 {{ b.avgPnlPct > 0 ? '+' : '' }}{{ b.avgPnlPct }}%</span>
            </div>
          </div>
          <div class="text-xs text-gray-500 mt-3 mb-1">离场原因构成</div>
          <div class="flex flex-wrap gap-2">
            <span v-for="r in report.exitReasons" :key="r.reason" class="px-2 py-0.5 rounded bg-panel text-[11px] text-gray-400">
              {{ REASON_LABELS[r.reason] ?? r.reason }} {{ r.count }}笔 · 均{{ r.avgPnlPct > 0 ? '+' : '' }}{{ r.avgPnlPct }}%
            </span>
          </div>
        </div>

        <!-- 最大回撤区间 + 离场统计 -->
        <div class="bg-panel2 border border-edge rounded-xl p-4">
          <div class="text-sm font-bold mb-2">回撤发生在哪一段</div>
          <div v-if="report.maxDrawdownPeriod" class="text-xs text-gray-400 leading-relaxed">
            峰值 <b class="text-gray-200">{{ report.maxDrawdownPeriod.peakDate }}</b> → 谷底
            <b class="text-bear">{{ report.maxDrawdownPeriod.troughDate }}</b>
            （<b class="text-bear">{{ (report.maxDrawdownPeriod.depth * 100).toFixed(2) }}%</b>，历时
            {{ report.maxDrawdownPeriod.lengthDays }} 交易日）<br />
            收复情况：<b class="text-gray-200">{{ report.maxDrawdownPeriod.recoveredDate ?? '至今未收复' }}</b>
          </div>
          <div v-else class="text-xs text-gray-600">无明显回撤</div>
        </div>

        <!-- 单笔盈亏极值 -->
        <div class="bg-panel2 border border-edge rounded-xl p-4">
          <div class="text-sm font-bold mb-2">单笔盈亏极值</div>
          <div class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div class="text-gray-500">最好一笔</div>
              <div class="text-lg font-bold text-bull">+{{ report.bestTradePct.toFixed(2) }}%</div>
            </div>
            <div>
              <div class="text-gray-500">最差一笔</div>
              <div class="text-lg font-bold text-bear">{{ report.worstTradePct.toFixed(2) }}%</div>
            </div>
            <div>
              <div class="text-gray-500">最长持仓</div>
              <div class="text-lg font-bold text-gray-200">{{ report.maxHoldingDays }} <span class="text-xs text-gray-500">日</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-panel2 border border-edge rounded-xl p-3">
        <div class="text-sm font-bold mb-2">成交明细（前 30 笔）</div>
        <div class="overflow-auto max-h-72">
          <table class="w-full text-xs text-gray-300">
            <thead class="text-gray-500 sticky top-0 bg-panel2">
              <tr class="text-left">
                <th class="py-1 pr-2">代码 / 名称</th>
                <th class="py-1 pr-2">买入日</th>
                <th class="py-1 pr-2">买价</th>
                <th class="py-1 pr-2">卖出日</th>
                <th class="py-1 pr-2">卖价</th>
                <th class="py-1 pr-2" title="已含双边滑点与双边佣金">收益%</th>
                <th class="py-1 pr-2" title="按交易日计，非自然日">持有</th>
                <th class="py-1">原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in result.trades.slice(0, 30)" :key="i" class="border-t border-edge">
                <td class="py-1 pr-2">{{ t.code }} <span class="text-gray-500">{{ t.name }}</span></td>
                <td class="py-1 pr-2">{{ t.entryDate }}</td>
                <td class="py-1 pr-2">{{ t.entryPrice.toFixed(2) }}</td>
                <td class="py-1 pr-2">{{ t.exitDate }}</td>
                <td class="py-1 pr-2">{{ t.exitPrice.toFixed(2) }}</td>
                <td class="py-1 pr-2" :class="t.pnlPct >= 0 ? 'text-bull' : 'text-bear'">{{ (t.pnlPct * 100).toFixed(2) }}</td>
                <td class="py-1 pr-2">{{ t.holdingDays }}天</td>
                <td class="py-1">{{ t.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 多策略横向对比(M5) -->
      <div class="bg-panel2 border border-edge rounded-xl p-4">
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm font-bold">多策略横向对比</div>
          <button
            @click="runCompare"
            :disabled="store.comparing"
            class="px-3 py-1 text-xs rounded-lg border border-panel2 hover:bg-panel2 text-gray-300 disabled:opacity-50"
          >
            {{ store.comparing ? '对比中…' : '运行对比' }}
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5 mb-2">
          <button
            v-for="s in store.strategies"
            :key="s.id"
            @click="toggleCompare(s.id)"
            class="px-2 py-0.5 rounded text-[11px] border"
            :class="compareIds.includes(s.id) ? 'border-accent text-accent bg-accent/10' : 'border-edge text-gray-500 hover:text-gray-300'"
          >{{ s.name }}</button>
        </div>
        <p class="text-[10px] text-gray-600 mb-2">同一区间/参数下各策略各跑一次回测（串行，较慢）；按总收益率降序。已应用你在「策略配置」页调过的参数。</p>
        <div v-if="compareMsg" class="text-[11px] text-gray-500 mb-2">{{ compareMsg }}</div>
        <table v-if="compareResult && compareResult.rows.length" class="w-full text-xs text-gray-300">
          <thead class="text-gray-500">
            <tr class="text-left border-b border-edge">
              <th class="py-1 pr-2">策略</th>
              <th class="py-1 pr-2 text-right">交易数</th>
              <th class="py-1 pr-2 text-right">胜率</th>
              <th class="py-1 pr-2 text-right">盈亏比</th>
              <th class="py-1 pr-2 text-right">最大回撤</th>
              <th class="py-1 pr-2 text-right">夏普</th>
              <th class="py-1 text-right">总收益</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in compareResult.rows" :key="r.strategyId" class="border-b border-edge/40">
              <td class="py-1 pr-2">{{ r.name }}</td>
              <td class="py-1 pr-2 text-right">{{ r.totalTrades }}</td>
              <td class="py-1 pr-2 text-right">{{ (r.winRate * 100).toFixed(1) }}%</td>
              <td class="py-1 pr-2 text-right">{{ r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2) }}</td>
              <td class="py-1 pr-2 text-right text-bear">{{ (r.maxDrawdown * 100).toFixed(1) }}%</td>
              <td class="py-1 pr-2 text-right">{{ r.sharpe.toFixed(2) }}</td>
              <td class="py-1 text-right font-medium" :class="r.totalReturn >= 0 ? 'text-bull' : 'text-bear'">
                {{ (r.totalReturn * 100).toFixed(2) }}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 参数敏感度扫描(M5) -->
      <div class="bg-panel2 border border-edge rounded-xl p-4">
        <div class="text-sm font-bold mb-2">参数敏感度扫描</div>
        <div class="flex flex-wrap items-end gap-2 mb-2">
          <label class="flex flex-col gap-1 text-[11px] text-gray-500">
            策略
            <select v-model="sensStrategy" class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200" @change="onSensStrategyChange">
              <option value="">选择策略</option>
              <option v-for="s in store.strategies" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[11px] text-gray-500">
            参数
            <select v-model="sensParam" class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200" :disabled="!sensStrategy">
              <option v-for="f in numericParams" :key="f.key" :value="f.key">{{ f.label }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[11px] text-gray-500">
            网格点
            <input v-model.number="sensPoints" type="number" min="2" max="9" class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200 w-16" />
          </label>
          <button
            @click="runSensitivity"
            :disabled="store.sensitivityLoading || !sensStrategy || !sensParam"
            class="px-3 py-1 text-xs rounded-lg border border-panel2 hover:bg-panel2 text-gray-300 disabled:opacity-50 h-[26px]"
          >
            {{ store.sensitivityLoading ? '扫描中…' : '扫描' }}
          </button>
        </div>
        <p class="text-[10px] text-gray-600 mb-2">在同一区间把该参数按网格取值各跑一次回测（每个点=一次完整回测，较慢；≤9点）。<b class="text-gray-400">不会改你的配置</b>，仅本次扫描用。</p>
        <div v-if="sensMsg" class="text-[11px] text-gray-500 mb-2">{{ sensMsg }}</div>
        <table v-if="sensResult && sensResult.points.length" class="w-full text-xs text-gray-300">
          <thead class="text-gray-500">
            <tr class="text-left border-b border-edge">
              <th class="py-1 pr-2">{{ sensResult.paramLabel }}</th>
              <th class="py-1 pr-2 text-right">交易数</th>
              <th class="py-1 pr-2 text-right">胜率</th>
              <th class="py-1 pr-2 text-right">最大回撤</th>
              <th class="py-1 pr-2 text-right">夏普</th>
              <th class="py-1 text-right">总收益</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in sensResult.points" :key="p.value" class="border-b border-edge/40"
                :class="p.value === sensResult.currentValue ? 'bg-accent/5' : ''">
              <td class="py-1 pr-2">
                {{ p.value }}
                <span v-if="p.value === sensResult.currentValue" class="text-[10px] text-accent">（当前）</span>
              </td>
              <td class="py-1 pr-2 text-right">{{ p.totalTrades }}</td>
              <td class="py-1 pr-2 text-right">{{ (p.winRate * 100).toFixed(1) }}%</td>
              <td class="py-1 pr-2 text-right text-bear">{{ (p.maxDrawdown * 100).toFixed(1) }}%</td>
              <td class="py-1 pr-2 text-right">{{ p.sharpe.toFixed(2) }}</td>
              <td class="py-1 text-right font-medium" :class="p.totalReturn >= 0 ? 'text-bull' : 'text-bear'">
                {{ (p.totalReturn * 100).toFixed(2) }}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
