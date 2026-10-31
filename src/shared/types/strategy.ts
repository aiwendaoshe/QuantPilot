import type { StrategyId, SignalType } from './signal';

export type ParamValue = number | boolean | string;

export interface ParamField {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
}

/** 策略运行时配置（用户可调、可持久化） */
export interface StrategyConfig {
  id: StrategyId;
  enabled: boolean;
  params: Record<string, ParamValue>;
}

/** 策略静态元信息（前端配置面板渲染依据） */
export interface StrategyMeta {
  id: StrategyId;
  name: string;
  type: SignalType;
  description: string;
  defaultParams: Record<string, ParamValue>;
  paramSchema: ParamField[];
}
