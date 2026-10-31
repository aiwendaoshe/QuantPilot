<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useStockStore } from '../stores/stockStore';
import type { StrategyConfig, ParamValue } from '@shared/types/strategy';
import type { SignalType } from '@shared/types/signal';

const store = useStockStore();

// 本地编辑副本：id -> { enabled, params }
const draft = reactive<Record<string, { enabled: boolean; params: Record<string, ParamValue> }>>({});
/** idle | saving | saved | error —— 保存必须让用户看见结果，禁止「点了没反应」 */
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const saveError = ref('');
const loadError = ref('');
/** 正在应用的组合预设 id（防连点） */
const presetApplying = ref('');
const presetMsg = ref('');

const typeLabel: Record<SignalType, string> = {
  trend: '趋势',
  reversal: '反包',
  breakout: '突破',
  limitdown: '跌停反包',
};

/**
 * 以「策略清单」为准建全量草稿：
 * 历史 bug 是只按 configGet 的结果建条目，一旦加载慢/失败草稿就为空，
 * 此时 setParam 会静默丢弃用户输入，最终保存的是空配置（把已存参数全清回默认）。
 */
function initDraft(): void {
  for (const k of Object.keys(draft)) delete draft[k];
  for (const c of store.configs) {
    draft[c.id] = { enabled: c.enabled, params: { ...c.params } };
  }
  // 兜底：configGet 没返回（或缺失）的策略也要建条目
  for (const m of store.strategies) {
    if (!draft[m.id]) draft[m.id] = { enabled: true, params: { ...m.defaultParams } };
  }
}

const list = computed(() =>
  store.strategies.map((m) => ({
    meta: m,
    cfg:
      draft[m.id] ?? {
        enabled: true,
        params: { ...m.defaultParams } as Record<string, ParamValue>,
      },
  })),
);

/** 当前草稿的启用集合，是否完全命中某个预设（完全一致才高亮）；未命中 = 自定义 */
const activePresetId = computed(() => {
  const enabled = store.strategies
    .filter((m) => draft[m.id]?.enabled)
    .map((m) => m.id)
    .sort();
  if (enabled.length === 0) return '';
  for (const p of store.presets) {
    const pe = [...p.enabled].sort();
    if (pe.length === enabled.length && pe.every((x, i) => x === enabled[i])) return p.id;
  }
  return '';
});

/** 由当前草稿组装全量配置（策略清单为准，缺条目回落到默认） */
function draftConfigs(): StrategyConfig[] {
  return store.strategies.map((m) => {
    const v = draft[m.id] ?? { enabled: true, params: { ...m.defaultParams } };
    return { id: m.id, enabled: v.enabled, params: { ...v.params } };
  });
}

onMounted(async () => {
  try {
    await store.loadStrategies();
    await store.loadConfig();
    await store.loadPresets();
  } catch (e) {
    // 加载失败必须显式暴露，否则页面永远停在一句「加载中…」
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    initDraft();
  }
});

async function save(): Promise<void> {
  if (saveState.value === 'saving') return; // 防连点重复写盘
  saveState.value = 'saving';
  saveError.value = '';
  try {
    // 以策略清单为准组装，草稿缺条目也不会丢策略
    const configs: StrategyConfig[] = store.strategies.map((m) => {
      const v = draft[m.id] ?? { enabled: true, params: { ...m.defaultParams } };
      // 展开成纯对象：响应式代理过不了 ipcRenderer.invoke 的结构化克隆
      return { id: m.id, enabled: v.enabled, params: { ...v.params } };
    });
    await store.saveConfig(configs);
    saveState.value = 'saved';
    setTimeout(() => {
      if (saveState.value === 'saved') saveState.value = 'idle';
    }, 4000);
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e);
    saveState.value = 'error';
  }
}

function setParam(id: string, key: string, value: ParamValue): void {
  if (!draft[id]) draft[id] = { enabled: true, params: {} as Record<string, ParamValue> };
  draft[id].params[key] = value;
}

/**
 * 应用组合预设：一键切换各策略启用开关（不动参数），立即落库生效。
 * 携带当前草稿参数，保证用户已调未保存的参数不被抹掉。
 */
async function applyPreset(id: string): Promise<void> {
  if (presetApplying.value) return; // 防连点
  presetApplying.value = id;
  presetMsg.value = '';
  saveError.value = '';
  try {
    await store.applyPreset(id, draftConfigs());
    initDraft(); // 以持久化后的权威配置重建草稿
    const name = store.presets.find((p) => p.id === id)?.name ?? id;
    presetMsg.value = `已应用「${name}」：仅切换启用开关，参数保持不变`;
    setTimeout(() => {
      if (presetMsg.value) presetMsg.value = '';
    }, 4000);
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e);
    saveState.value = 'error';
  } finally {
    presetApplying.value = '';
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1 class="text-xl font-bold">策略配置</h1>
        <p class="text-xs text-gray-500 mt-0.5">调整各策略阈值 / 窗口期，保存后下次选股与回测自动生效。</p>
      </div>
      <div class="flex flex-col items-end gap-1">
        <button
          @click="save"
          :disabled="saveState === 'saving'"
          class="px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-60"
          :class="
            saveState === 'error'
              ? 'bg-bear text-white'
              : 'bg-accent text-black hover:opacity-90'
          "
        >
          {{
            saveState === 'saving'
              ? '保存中…'
              : saveState === 'saved'
                ? '已保存 ✓'
                : saveState === 'error'
                  ? '重新保存'
                  : '保存配置'
          }}
        </button>
        <span v-if="saveState === 'saved'" class="text-[11px] text-bull">已写入本地配置，下次选股/回测/个股信号立即生效</span>
        <span v-if="saveState === 'error'" class="text-[11px] text-bear">保存失败：{{ saveError }}</span>
      </div>
    </div>

    <!-- 组合预设：一键切换启用开关（不动参数） -->
    <div class="mb-4 rounded-xl border border-edge bg-panel2 px-4 py-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-gray-400 mr-1">组合预设</span>
        <button
          v-for="p in store.presets"
          :key="p.id"
          @click="applyPreset(p.id)"
          :disabled="!!presetApplying"
          :title="`${p.description}（仅切换启用开关，不修改参数）`"
          class="px-3 py-1 rounded-lg text-xs font-medium border transition disabled:opacity-60"
          :class="
            activePresetId === p.id
              ? 'bg-accent text-black border-accent'
              : 'bg-panel text-gray-300 border-edge hover:border-accent hover:text-white'
          "
        >
          {{ p.name }}<span v-if="presetApplying === p.id"> …</span>
        </button>
        <span v-if="store.presets.length && !activePresetId" class="text-[11px] text-gray-500">
          当前为自定义启用组合
        </span>
      </div>
      <p class="text-[11px] text-gray-500 mt-1.5 leading-relaxed">
        仅切换各策略「启用」开关，<span class="text-gray-400">不修改已调参数</span>；点选后立即保存生效。
      </p>
      <span v-if="presetMsg" class="text-[11px] text-bull">{{ presetMsg }}</span>
    </div>

    <div
      v-if="loadError"
      class="mb-3 rounded-lg border border-bear/40 bg-bear/10 px-3 py-2 text-xs text-bear"
    >
      策略清单加载失败：{{ loadError }}。请重启应用后重试；已保存的配置不会丢失。
    </div>

    <div v-if="store.strategies.length === 0" class="text-gray-500 py-20 text-center">
      {{ loadError ? '策略清单加载失败' : '加载中…' }}
    </div>

    <div v-else class="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <div
        v-for="item in list"
        :key="item.meta.id"
        class="bg-panel2 border border-edge rounded-xl p-4 flex flex-col gap-3"
      >
        <div class="flex items-start justify-between">
          <div>
            <div class="font-bold flex items-center gap-2">
              {{ item.meta.name }}
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-panel text-gray-400">{{ typeLabel[item.meta.type] }}</span>
            </div>
            <p class="text-xs text-gray-400 mt-1 leading-relaxed">{{ item.meta.description }}</p>
          </div>
          <label class="flex items-center gap-1 text-xs text-gray-400 shrink-0">
            <input
              type="checkbox"
              v-model="item.cfg.enabled"
              class="accent-[#f59e0b]"
            />
            启用
          </label>
        </div>

        <div class="grid grid-cols-2 gap-x-4 gap-y-2">
          <div v-for="f in item.meta.paramSchema" :key="f.key" class="flex flex-col gap-1">
            <span class="text-[11px] text-gray-500">{{ f.label }}</span>
            <input
              v-if="f.type === 'number'"
              type="number"
              :min="f.min"
              :max="f.max"
              :step="f.step ?? 1"
              :value="(item.cfg.params[f.key] as number)"
              @input="setParam(item.meta.id, f.key, Number(($event.target as HTMLInputElement).value))"
              class="bg-panel border border-edge rounded px-2 py-1 text-sm text-gray-200 focus:border-accent outline-none"
            />
            <select
              v-else-if="f.type === 'select'"
              :value="String(item.cfg.params[f.key])"
              @change="setParam(item.meta.id, f.key, ($event.target as HTMLSelectElement).value)"
              class="bg-panel border border-edge rounded px-2 py-1 text-sm text-gray-200"
            >
              <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <label v-else class="flex items-center gap-1 text-sm text-gray-300">
              <input
                type="checkbox"
                :checked="Boolean(item.cfg.params[f.key])"
                @change="setParam(item.meta.id, f.key, ($event.target as HTMLInputElement).checked)"
                class="accent-[#f59e0b]"
              />
              {{ String(item.cfg.params[f.key]) }}
            </label>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
