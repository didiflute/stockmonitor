"""状态文件读写

state.json 记录:
  - last_quote: 最近一次价格快照
  - fired_signals: 已触发并已通知过的信号 (按 date+signal_type+action 去重, 防重复通知)
  - last_run_at: 最近一次脚本执行时间
  - holding: 当前持仓 (用户在 dashboard 手动维护; 脚本只读取展示)

文件位置: 项目根目录 state.json
GitHub Actions 每次跑完会 git commit + push 这个文件回到仓库.
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
    """已触发并通知过的信号 (用于去重)"""
    date: str        # ISO date YYYY-MM-DD (美东时区交易日)
    signal_type: str # daily | weekly | monthly
    action: str      # buy | sell
    price: float
    fired_at: str    # ISO timestamp UTC
    user_acknowledged: bool = False  # 用户在 dashboard 点了"我已下单"


@dataclass
class State:
    last_run_at: str | None = None
    last_quote: dict[str, Any] | None = None  # {price, timestamp, source}
    fired_signals: list[FiredSignal] = field(default_factory=list)
    holding_shares: float = 0.0
    avg_cost: float = 0.0
    cash_flow: float = 0.0  # 累计净投入

    def is_already_fired_today(self, date: str, signal_type: str, action: str) -> bool:
        """同一天 + 同一种信号类型 + 同一动作, 算重复, 不再发通知."""
        return any(
            s.date == date and s.signal_type == signal_type and s.action == action
            for s in self.fired_signals
        )

    def mark_fired(self, signal: FiredSignal) -> None:
        # 防重复
        if self.is_already_fired_today(signal.date, signal.signal_type, signal.action):
            return
        self.fired_signals.append(signal)
        # 只保留最近 365 天, 文件别越长越大
        cutoff = (datetime.now(timezone.utc).timestamp()) - 365 * 86400
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
        }

    @classmethod
    def from_dict(cls, d: dict) -> "State":
        return cls(
            last_run_at=d.get("last_run_at"),
            last_quote=d.get("last_quote"),
            fired_signals=[FiredSignal(**s) for s in d.get("fired_signals", [])],
            holding_shares=float(d.get("holding_shares", 0)),
            avg_cost=float(d.get("avg_cost", 0)),
            cash_flow=float(d.get("cash_flow", 0)),
        )


def load_state(path: Path = STATE_FILE) -> State:
    if not path.exists():
        return State()
    with open(path, "r", encoding="utf-8") as f:
        return State.from_dict(json.load(f))


def save_state(state: State, path: Path = STATE_FILE) -> None:
    state.last_run_at = datetime.now(timezone.utc).isoformat()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state.to_dict(), f, ensure_ascii=False, indent=2)
