import type { StrategyId } from '../src/shared/types/signal';

/**
 * 策略组合预设：仅控制各策略的 enabled 开关，不触碰参数（参数以各策略 defaultParams 为准）。
 * 默认生效组合 = DEFAULT_PRESET_ID（组合A）。已保存过配置（electron-store configs 非空）时，
 * 用户覆盖优先，预设不再强制；仅当 configs 为空（全新安装 / 已重置）时由 strategyService 应用默认组合。
 */
export interface StrategyPreset {
  id: string;
  name: string;
  description: string;
  /** 启用的策略 id 列表，其余策略默认禁用 */
  enabled: StrategyId[];
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'A',
    name: '组合A（默认）',
    description: '量价共振 + N形反转 + 上升跌停反包',
    enabled: ['maVolume', 'nShapeReversal', 'uptrendLimitDown'],
  },
  {
    id: 'B',
    name: '组合B',
    description: '涨停回撤 + N形反转',
    enabled: ['limitUpReversal', 'nShapeReversal'],
  },
  {
    id: 'C',
    name: '组合C',
    description: '量价共振 + 海龟突破 + 均线多头',
    enabled: ['maVolume', 'turtleBreakout', 'maBullish'],
  },
  {
    id: 'D',
    name: '组合D',
    description: '上升跌停反包',
    enabled: ['uptrendLimitDown'],
  },
];

/** 出厂默认组合（configs 为空时启用） */
export const DEFAULT_PRESET_ID = 'A';

export function presetById(id: string): StrategyPreset | undefined {
  return STRATEGY_PRESETS.find((p) => p.id === id);
}
