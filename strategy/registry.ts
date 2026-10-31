import type { StrategyBase } from './StrategyBase';
import { MaBullish } from './MaBullish';
import { TrendFollower } from './TrendFollower';
import { LimitUpReversal } from './LimitUpReversal';
import { NShapeReversal } from './NShapeReversal';
import { TurtleBreakout } from './TurtleBreakout';
import { MaVolume } from './MaVolume';
import { UptrendLimitDown } from './UptrendLimitDown';

/**
 * 策略注册表：返回全部内置策略实例（阶段一验证策略 + 阶段二 6 大策略）。
 * 主进程 strategyService 通过本函数统一获取策略，保证调度/回测覆盖完整。
 */
export function allStrategies(): StrategyBase[] {
  return [
    new MaBullish(),
    new TrendFollower(),
    new LimitUpReversal(),
    new NShapeReversal(),
    new TurtleBreakout(),
    new MaVolume(),
    new UptrendLimitDown(),
  ];
}

/** 仅阶段二交付的 6 大策略（用于回测对比焦点） */
export function phase2Strategies(): StrategyBase[] {
  return [
    new TrendFollower(),
    new LimitUpReversal(),
    new NShapeReversal(),
    new TurtleBreakout(),
    new MaVolume(),
    new UptrendLimitDown(),
  ];
}
