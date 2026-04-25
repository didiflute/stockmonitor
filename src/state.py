"""状态文件读写 (v2)

state.json 字段:
  - last_run_at: 最近一次脚本执行时间 (ISO UTC)
  - last_quote: 最近一次价格快照 + 信号评估
  - fired_signals: 触发过的信号列表
      - 含 user_acknowledged / user_skipped / executed_shares / executed_price / executed_at
  - holding_shares / avg_cost / cash_flow / realized_profit: 持仓状态
      - 通过 dashboard "我已下单" 触发 Worker 写回更新

GitHub Actions 写入 last_run_at + last_quote + fired_signals (新增).
Cloudflare Worker 写入 fired_signals[i] 的 ack/skip 字段 + 持仓数字.
两边互不冲突: 后端只动它该动的字段.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATE_FILE = Path(__file__).parent.parent / "state.json"


@dataclass
class FiredSignal:
    """已触发并通知过的信号 (用于去重 + 历史记录)"""
    date: str        # ISO date YYYY-MM-DD (美东交易日)
    signal_type: str # daily | weekly | monthly
    action: str      # buy | sell
    price: float     # 触发时的价格
    fired_at: str    # ISO timestamp UTC

    # v2 新增 (由 Cloudflare Worker 在用户点 "我已下单"/"跳过" 时填写):
    user_acknowledged: bool = False
    user_skipped: bool = False
    executed_shares: float | None = None
    executed_price: float | None = None
    executed_at: str | None = None
    skipped_at: str | None = None


@dataclass
class State:
    last_run_at: str | None = None
    last_quote: dict[str, Any] | None = None
    fired_signals: list[FiredSignal] = field(default_factory=list)
    holding_shares: float = 0.0
    avg_cost: float = 0.0
    cash_flow: float = 0.0
    realized_profit: float = 0.0  # v2 新增: 累计已实现盈利

    def is_already_fired_today(self, date: str, signal_type: str, action: str) -> bool:
        """同一天 + 同一种信号类型 + 同一动作 = 重复, 不再发通知."""
        return any(
            s.date == date and s.signal_type == signal_type and s.action == action
            for s in self.fired_signals
        )

    def mark_fired(self, signal: FiredSignal) -> None:
        if self.is_already_fired_today(signal.date, signal.signal_type, signal.action):
            return
        self.fired_signals.append(signal)
        # 只保留最近 365 天, 防止文件越来越大
        cutoff = datetime.now(timezone.utc).timestamp() - 365 * 86400
        self.fired_signals = [
            s for s in self.fired_signals
            if datetime.fromisoformat(s.fired_at.replace("Z", "+00:00")).timestamp() >= cutoff
        ]

    def to_dict(self) -> dict:
        return {
            "last_run_at": self.last_run_at,
            "last_quote": self.last_quote,
            "fired_signals": [asdict(s) for s in self.fired_signals],
            "holding_shares": self.holding_shares,
            "avg_cost": self.avg_cost,
            "cash_flow": self.cash_flow,
            "realized_profit": self.realized_profit,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "State":
        return cls(
            last_run_at=d.get("last_run_at"),
            last_quote=d.get("last_quote"),
            fired_signals=[
                FiredSignal(
                    date=s["date"],
                    signal_type=s["signal_type"],
                    action=s["action"],
                    price=float(s["price"]),
                    fired_at=s["fired_at"],
                    user_acknowledged=bool(s.get("user_acknowledged", False)),
                    user_skipped=bool(s.get("user_skipped", False)),
                    executed_shares=s.get("executed_shares"),
                    executed_price=s.get("executed_price"),
                    executed_at=s.get("executed_at"),
                    skipped_at=s.get("skipped_at"),
                )
                for s in d.get("fired_signals", [])
            ],
            holding_shares=float(d.get("holding_shares", 0)),
            avg_cost=float(d.get("avg_cost", 0)),
            cash_flow=float(d.get("cash_flow", 0)),
            realized_profit=float(d.get("realized_profit", 0)),
        )


def load_state(path: Path = STATE_FILE) -> State:
    if not path.exists():
        return State()
    with open(path, "r", encoding="utf-8") as f:
        return State.from_dict(json.load(f))


def save_state(state: State, path: Path = STATE_FILE) -> None:
    """写回 state.json. 注意: dashboard/Worker 修改的字段在这里会被保留,
    因为 main.py 是先 load_state -> 改自己的字段 -> save_state.
    Worker 修改的字段 (持仓数字、acked/skipped) 是在 main.py 跑完之后才发生,
    所以也不会冲突."""
    state.last_run_at = datetime.now(timezone.utc).isoformat()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state.to_dict(), f, ensure_ascii=False, indent=2)
