"""TQQQ 网格交易信号逻辑

复刻自 Wendi 的 Google Sheets 模型 (投资策略-TQQQ-v3.xlsx, "信号" sheet)。

信号定义:
- 每日变化率 = 今日收盘 / 昨日收盘 - 1
- 每周变化率 = 今日收盘 / 过去 5 个交易日均价 - 1
- 每月变化率 = 今日收盘 / 过去 20 个交易日均价 - 1

触发规则 (阈值可配置, 默认 -7% / +8%):
- 变化率 <= drop_threshold (例: -0.07): 触发"买入"信号
- 变化率 >= rise_threshold (例: +0.08): 触发"卖出"信号
- 否则: 无信号
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

SignalType = Literal["daily", "weekly", "monthly"]
Action = Literal["buy", "sell", "hold"]

WINDOW_BY_TYPE: dict[SignalType, int] = {
    "daily": 1,
    "weekly": 5,
    "monthly": 20,
}

EPSILON = 1e-9  # 浮点容差


@dataclass(frozen=True)
class SignalResult:
    signal_type: SignalType
    current_price: float
    reference_price: float
    change_rate: float
    action: Action
    drop_threshold: float
    rise_threshold: float

    @property
    def is_triggered(self) -> bool:
        return self.action != "hold"

    @property
    def buy_trigger_price(self) -> float:
        return self.reference_price * (1 + self.drop_threshold)

    @property
    def sell_trigger_price(self) -> float:
        return self.reference_price * (1 + self.rise_threshold)


def compute_reference_price(
    current_price: float,
    historical_closes: Sequence[float],
    signal_type: SignalType,
) -> float:
    """参考价 = 昨天 (daily) / 5日均价 (weekly) / 20日均价 (monthly)

    historical_closes 按"距离今天由近到远"排序: [昨天, 前天, 大前天, ...]
    """
    window = WINDOW_BY_TYPE[signal_type]
    if len(historical_closes) < window:
        raise ValueError(
            f"{signal_type} 信号需要至少 {window} 天历史, 当前只有 {len(historical_closes)} 天"
        )
    if signal_type == "daily":
        return historical_closes[0]
    return sum(historical_closes[:window]) / window


def evaluate_signal(
    current_price: float,
    historical_closes: Sequence[float],
    signal_type: SignalType,
    drop_threshold: float = -0.07,
    rise_threshold: float = 0.08,
) -> SignalResult:
    """评估当前是否触发买/卖信号."""
    if drop_threshold >= 0:
        raise ValueError(f"drop_threshold 应为负数, 收到 {drop_threshold}")
    if rise_threshold <= 0:
        raise ValueError(f"rise_threshold 应为正数, 收到 {rise_threshold}")

    reference = compute_reference_price(current_price, historical_closes, signal_type)
    change_rate = current_price / reference - 1

    if change_rate <= drop_threshold + EPSILON:
        action: Action = "buy"
    elif change_rate >= rise_threshold - EPSILON:
        action = "sell"
    else:
        action = "hold"

    return SignalResult(
        signal_type=signal_type,
        current_price=current_price,
        reference_price=reference,
        change_rate=change_rate,
        action=action,
        drop_threshold=drop_threshold,
        rise_threshold=rise_threshold,
    )
