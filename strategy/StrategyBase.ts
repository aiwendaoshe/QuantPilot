import type {
  DailyBar,
  StockMeta,
  StockSeries,
} from '../src/shared/types/stock';
import type { Signal, StrategyId } from '../src/shared/types/signal';
import type {
  StrategyConfig,
  StrategyMeta,
  ParamValue,
} from '../src/shared/types/strategy';
import type { BacktestOptions, BacktestResult } from '../src/shared/types/backtest';
import { runBacktest, type BacktestRange } from './backtest';

/**
 * 所有策略的抽象基类。
 * 子类只需实现 generateSignal（信号生成）与 score（评分），
 * backtest 由基类统一调用通用回测器，保证信号/执行分离、杜绝未来函数。
 */
export abstract class StrategyBase {
  abstract readonly id: StrategyId;
  abstract readonly meta: StrategyMeta;

  // 延迟初始化：避免基类构造时读取尚未赋值的子类字段 meta
  private _config: StrategyConfig | null = null;
  private _partial: Partial<StrategyConfig> | undefined;

  constructor(config?: Partial<StrategyConfig>) {
    this._partial = config;
  }

  /** 运行时重载配置（由持久化配置恢复时调用） */
  setConfig(partial: Partial<StrategyConfig>): void {
    this._partial = partial;
    this._config = null;
  }

  private ensureConfig(): StrategyConfig {
    if (this._config) return this._config;
    const params: Record<string, ParamValue> = { ...this.meta.defaultParams };
    if (this._partial?.params) {
      for (const [k, v] of Object.entries(this._partial.params)) params[k] = v;
    }
    this._config = {
      id: this.id,
      enabled: this._partial?.enabled ?? true,
      params,
    };
    return this._config;
  }

  /** 读取参数（带默认值兜底，类型安全），公开供回测器等外部调用 */
  getParam<T extends ParamValue>(key: string, fallback: T): T {
    const v = this.ensureConfig().params[key];
    return (v as T) ?? fallback;
  }

  getConfig(): StrategyConfig {
    return this.ensureConfig();
  }

  /** 信号生成：输入截至某日的 K 线（升序），返回信号或 null。禁止访问未来数据。 */
  abstract generateSignal(bars: DailyBar[], meta: StockMeta): Signal | null;

  /** 综合评分 0-100（用于排序与雷达图数据） */
  abstract score(bars: DailyBar[]): number;

  /** 回测：输入标的池与参数，可选时间区间，返回完整回测报告 */
  backtest(
    pool: StockSeries[],
    options: BacktestOptions,
    range?: BacktestRange,
  ): BacktestResult {
    return runBacktest(this, pool, options, range);
  }
}
