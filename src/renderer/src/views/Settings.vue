<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useStockStore } from '../stores/stockStore';
import type { AdjustBiasEntry, Capability, LayerStatusInfo, ProviderId } from '@shared/types/ipc';
import type { SchedulerConfig } from '@shared/types/scheduler';
import { DEFAULT_SCHEDULER } from '@shared/types/scheduler';

const store = useStockStore();
const draft = reactive<SchedulerConfig>({ ...DEFAULT_SCHEDULER });
const saved = ref(false);
const running = ref(false);

/**
 * 设置页左侧边栏（顶部导航「设置」→ 页内分两页）。
 * 顺序即用户动线：先进「数据源」（行情从哪来），再看「定时任务」（什么时候跑）。
 */
type SettingsTab = 'source' | 'scheduler';
const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'source', label: '数据源' },
  { key: 'scheduler', label: '定时任务' },
];
const tab = ref<SettingsTab>('source');

// 数据源区块（P4）：只放开「名单 / 快照」两层，日 K 由主进程锁死腾讯 qfq
const capLabel: Record<Capability, string> = {
  universe: '名单（全市场标的清单）',
  snapshot: '快照（实时/最新价）',
  dailyBars: '日 K（历史 K 线）',
};
const capHint: Record<Capability, string> = {
  universe: '决定「补拉缺失标的 / 全量回填」的目标集合',
  snapshot: '用于补当日成交额（腾讯 K 线本身不返回 amount）',
  dailyBars: '锁死：存量库是前复权序列，换源会改写约 37% 的历史 close（见迁移文档 §0.5）',
};

const LAYER_ORDER: Capability[] = ['universe', 'snapshot', 'dailyBars'];

const cfg = computed(() => store.sourceConfig);
const engine = computed(() => cfg.value?.engine ?? 'node');

/** Python 实验路径能不能点：解释器 + 桥脚本都在位（打包版随包不带 python/，故为 false） */
const pythonUsable = computed(() => Boolean(cfg.value?.pythonAvailable && cfg.value?.pythonScriptReady));

/** 已知口径偏差名单（meta.knownAdjustBias）；只在留档非空时显示，避免空区块占位 */
const biasList = computed<AdjustBiasEntry[]>(() => cfg.value?.adjustBias ?? []);

/** 某层的当前首选；没设过就用主进程给的候选默认 */
function preferred(cap: Capability): ProviderId | undefined {
  return cfg.value?.layers.find((l) => l.cap === cap)?.preferred ?? undefined;
}

/** 某源在某层是否可选（结构上支持 + 没被熔断 + 该层实际可用） */
function optionState(cap: Capability, id: ProviderId): { disabled: boolean; note: string } {
  const l: LayerStatusInfo | undefined = cfg.value?.layers.find((x) => x.cap === cap);
  const p = cfg.value?.providers.find((x) => x.id === id);
  if (!l || !p) return { disabled: true, note: '源未注册' };
  if (!l.available.includes(id)) {
    if (p.breaker !== 'closed') return { disabled: true, note: '该源正在熔断，稍后自动恢复' };
    if (p.optional) return { disabled: true, note: p.requiredPackage ?? '需安装可选依赖' };
    return { disabled: true, note: '不可用（熔断或故障）' };
  }
  return { disabled: false, note: '' };
}

function layerAvailableCount(cap: Capability): number {
  return cfg.value?.layers.find((l) => l.cap === cap)?.available.length ?? 0;
}

/** 状态灯：熔断 / 可选依赖缺失 / 正常 */
function lampOf(id: ProviderId): { text: string; cls: string } {
  const p = cfg.value?.providers.find((x) => x.id === id);
  if (!p) return { text: '未知', cls: 'bg-gray-600' };
  if (p.breaker === 'open') return { text: '熔断', cls: 'bg-red-500' };
  if (p.breaker === 'half-open') return { text: '探测中', cls: 'bg-amber-400' };
  if (p.optional) return { text: '需装依赖', cls: 'bg-gray-500' };
  return { text: '正常', cls: 'bg-emerald-500' };
}

const providerLabel = (id: ProviderId): string =>
  cfg.value?.providers.find((p) => p.id === id)?.label ?? id;

/**
 * 日 K 锁死源的状态灯（M6）。
 * 之前这里写死一个永远绿的点 —— 腾讯真熔断了也照样显示「正常」，属误导。
 * 改为复用 lampOf 读真实 breaker 状态；日 K 无降级兜底，熔断=拉不到，要让用户看见。
 */
const dailyLamp = computed(() => lampOf(cfg.value?.dailyLock.provider ?? 'tencent'));

onMounted(async () => {
  await store.loadScheduler();
  if (store.scheduler) Object.assign(draft, store.scheduler);
  await store.loadSourceConfig();
});

async function save(): Promise<void> {
  await store.saveScheduler({ ...draft });
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}

async function runNow(): Promise<void> {
  running.value = true;
  try {
    await store.runScreener();
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="flex gap-5 max-w-5xl">
    <!-- 左侧边栏：设置页的页内导航，默认停在「数据源」 -->
    <aside class="w-36 shrink-0 flex flex-col gap-1 self-start">
      <button
        v-for="t in TABS"
        :key="t.key"
        @click="tab = t.key"
        class="text-left px-3 py-2 rounded-lg text-sm border transition-colors"
        :class="
          tab === t.key
            ? 'border-accent/40 bg-panel2 text-accent'
            : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-panel2'
        "
      >
        {{ t.label }}
      </button>
    </aside>

    <div class="flex-1 min-w-0">
    <template v-if="tab === 'scheduler'">
        <h1 class="text-xl font-bold mb-4">定时任务与推送</h1>

        <div class="bg-panel2 border border-edge rounded-xl p-5 flex flex-col gap-4">
          <label class="flex items-center justify-between">
            <div>
              <div class="font-medium">启用每日自动选股</div>
              <div class="text-xs text-gray-500">到达设定时间后自动运行全部启用策略</div>
            </div>
            <input type="checkbox" v-model="draft.enabled" class="accent-[#f59e0b] w-5 h-5" />
          </label>

          <div class="grid grid-cols-3 gap-3">
            <label class="flex flex-col gap-1 text-xs text-gray-500">
              触发小时(0-23)
              <input type="number" min="0" max="23" v-model.number="draft.hour" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-gray-500">
              触发分钟(0-59)
              <input type="number" min="0" max="59" v-model.number="draft.minute" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
            </label>
            <label class="flex flex-col gap-1 text-xs text-gray-500">
              TOP N 数量
              <input type="number" min="5" max="100" v-model.number="draft.topN" class="bg-panel border border-edge rounded px-2 py-1.5 text-sm text-gray-200" />
            </label>
          </div>

          <label class="flex items-center justify-between">
            <div>
              <div class="font-medium">桌面通知</div>
              <div class="text-xs text-gray-500">选股完成后弹出系统通知</div>
            </div>
            <input type="checkbox" v-model="draft.notifyDesktop" class="accent-[#f59e0b] w-5 h-5" />
          </label>

          <label class="flex flex-col gap-1 text-xs text-gray-500">
            飞书 Webhook 地址（自定义机器人）
            <input
              v-model="draft.feishuWebhook"
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
              class="bg-panel border border-edge rounded px-3 py-2 text-sm text-gray-200 focus:border-accent outline-none"
            />
            <span class="text-[11px] text-gray-600">留空则不推送飞书。可在飞书群「设置-群机器人-自定义」获取。</span>
          </label>

          <div class="flex items-center gap-3 pt-2">
            <button
              @click="save"
              class="px-4 py-1.5 rounded-lg bg-accent text-black text-sm font-medium hover:opacity-90"
            >
              {{ saved ? '已保存 ✓' : '保存设置' }}
            </button>
            <button
              @click="runNow"
              :disabled="running"
              class="px-4 py-1.5 rounded-lg border border-edge text-sm text-gray-300 disabled:opacity-50"
            >
              {{ running ? '选股中…' : '立即选股一次' }}
            </button>
          </div>
        </div>

        </template>

        <!-- 数据源（P4）：后台是 Node Provider 层，用户只需在这三层里挑源 -->
    <template v-else>
        <h1 class="text-xl font-bold mb-4">数据源</h1>
        <div class="bg-panel2 border border-edge rounded-xl p-5 flex flex-col gap-4">
          <div class="text-xs text-gray-500">
            全部行情由软件内置接口直连获取，<span class="text-gray-300">不需要安装 Python / baostock</span>。
            数据源切换后对下一次拉取生效；首选源若因限流熔断，会自动回退到次源。
          </div>

          <div v-if="!cfg" class="text-xs text-gray-500">正在读取数据源配置…</div>

          <template v-else>
            <div v-for="cap in LAYER_ORDER" :key="cap" class="border-t border-edge pt-4 first:border-0 first:pt-0">
              <div class="flex items-center justify-between">
                <div class="font-medium">{{ capLabel[cap] }}</div>
                <span
                  class="text-[11px] px-2 py-0.5 rounded-full"
                  :class="layerAvailableCount(cap) > 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'"
                >
                  {{ cap === 'dailyBars' ? '已锁死' : layerAvailableCount(cap) > 0 ? `${layerAvailableCount(cap)} 个可用` : '无可服务源' }}
                </span>
              </div>
              <div class="text-xs text-gray-500 mt-0.5">{{ capHint[cap] }}</div>

              <!-- 日 K：只做只读说明，不给下拉 -->
              <div v-if="cap === 'dailyBars'" class="mt-2 flex items-center gap-2 text-sm text-gray-300">
                <span class="inline-flex items-center gap-1.5 bg-panel border border-edge rounded-lg px-3 py-1.5">
                  <span class="w-1.5 h-1.5 rounded-full" :class="dailyLamp.cls" :title="dailyLamp.text" />
                  {{ providerLabel(cfg.dailyLock.provider) }} · 前复权（qfq）
                </span>
                <span class="text-[11px] text-gray-600">接口固定，不可切换</span>
                <span
                  v-if="dailyLamp.text === '熔断' || dailyLamp.text === '探测中'"
                  class="text-[11px] text-amber-300/90"
                >
                  {{ dailyLamp.text === '熔断' ? '源已熔断，暂时拉不到新 K 线（无自动降级兜底）' : '源恢复探测中…' }}
                </span>
              </div>

              <div v-else class="mt-2 grid gap-2">
                <div
                  v-for="id in cfg.layers.find((l) => l.cap === cap)?.options ?? []"
                  :key="id"
                  class="flex items-center gap-3 bg-panel border border-edge rounded-lg px-3 py-2"
                >
                  <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="lampOf(id).cls" :title="lampOf(id).text" />
                  <span class="text-sm text-gray-200 flex-1">{{ providerLabel(id) }}</span>
                  <span
                    v-if="optionState(cap, id).disabled"
                    class="text-[11px] text-amber-300/80"
                  >{{ optionState(cap, id).note }}</span>
                  <select
                    :value="preferred(cap) === id ? id : ''"
                    :disabled="optionState(cap, id).disabled"
                    class="bg-panel border border-edge rounded px-2 py-1 text-xs text-gray-200 disabled:opacity-40"
                    @change="store.setSourcePreference(cap, ($event.target as HTMLSelectElement).value as ProviderId)"
                  >
                    <option value="">{{ preferred(cap) === id ? '' : '默认（按优先级）' }}</option>
                    <option :value="id">{{ preferred(cap) === id ? '当前使用' : '选它' }}</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- 拉取引擎 -->
            <div class="border-t border-edge pt-4">
              <div class="font-medium">拉取引擎</div>
              <div class="text-xs text-gray-500 mt-0.5">
                Node 内置源（零依赖，默认）；Python / baostock 是旧版遗留的实验路径，仅开发/调试环境可用。
              </div>
              <div class="mt-2 flex items-center gap-2">
                <button
                  v-for="e in (['node', 'python'] as const)"
                  :key="e"
                  @click="store.setPullEngine(e)"
                  :disabled="e === 'python' && !pythonUsable"
                  class="px-3 py-1.5 rounded-lg border text-sm disabled:opacity-40"
                  :class="
                    engine === e
                      ? 'border-accent text-accent'
                      : 'border-edge text-gray-400 hover:text-gray-200'
                  "
                >
                  {{ e === 'node' ? 'Node 内置源（推荐）' : 'Python / baostock（实验）' }}
                </button>
                <span v-if="engine === 'python'" class="text-[11px] text-amber-300/80">
                  需要本机自行安装 Python 与 baostock，普通用户请勿开启
                </span>
              </div>
              <div class="text-[11px] mt-1.5" :class="pythonUsable ? 'text-gray-600' : 'text-amber-300/80'">
                <template v-if="pythonUsable">
                  Python 解释器已检测到，Python 桥脚本在位 → 实验路径可切换（dev 环境）。
                </template>
                <template v-else>
                  当前不可用：{{ cfg?.pythonScriptReady ? '未检测到 Python 解释器' : '安装包未附带 Python 数据桥（v0.9.5 起已移除 extraResources），需在开发者模式下自行放置 python/baostock_fetcher.py' }}。
                </template>
              </div>
            </div>

            <!-- 诚实缺口：换源后新行没有成交额 -->
            <div class="text-[11px] text-gray-600 leading-relaxed">
              成交额覆盖率：<span class="text-gray-400">{{
                cfg.amountCoverage === null ? '未知' : `${(cfg.amountCoverage * 100).toFixed(2)}%`
              }}</span>
              —— 换源后新增的历史行不含成交额（腾讯 K 线接口不返回该字段），只有最新一根会用快照补齐。
              软件不会用「成交量 × 收盘价」去编造成交额。
              <template v-if="store.sourceError">
                <br /><span class="text-amber-300/80">切换提示：{{ store.sourceError }}</span>
              </template>
            </div>

            <!-- 已知口径偏差：meta.knownAdjustBias 的事实留档，不做实时扫描 -->
            <template v-if="biasList.length">
              <div class="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-2">
                <div class="text-[11px] text-amber-300/90 font-medium">
                  已知口径偏差 {{ biasList.length }} 条（留档，非实时检测结果）
                </div>
                <ul class="mt-1 space-y-1">
                  <li v-for="(b, i) in biasList" :key="i" class="text-[11px] text-gray-500 leading-relaxed">
                    <span class="text-gray-300">{{ b.code }}</span>
                    <template v-if="b.dates.length">
                      · {{ b.dates.join('、') }}
                    </template>
                    · <span class="text-amber-300/80">{{
                      b.status === 'fixed' ? '已修复' : '有意保留'
                    }}</span>
                    <br />{{ b.detail }}
                  </li>
                </ul>
              </div>
            </template>
          </template>
        </div>

        <p class="text-[11px] text-gray-600 mt-3 leading-relaxed">
          说明：定时调度运行在主进程，应用需保持运行（最小化到托盘亦可）。应用启动时会按已保存配置自动启动定时器。
        </p>
      </template>
    </div>
  </div>
</template>
