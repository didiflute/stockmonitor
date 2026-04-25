"""状态文件读写 (v3 - 多用户)

state.json schema:
  {
    // 共享 (后端写)
    "last_run_at": "...",
    "last_quote": {...},
    "fired_signals": [
      { "date", "signal_type", "action", "price", "fired_at" }
    ],
    // 个人 (Worker 按 user_id 写, 后端不动)
    "users": {
      "wz": {
        "holding_shares", "avg_cost", "cash_flow", "realized_profit",
        "acks": [ { signal_id, date, signal_type, action, executed_shares, executed_price, acknowledged_at, delta } ],
        "skips": [ { signal_id, date, signal_type, action, skipped_at } ]
      },
      "fp": { ... }
    }
  }

迁移逻辑: 老格式扁平字段 (holding_shares 等) 自动转到 users.wz.
后端 main.py 只动 last_run_at / last_quote / fired_signals, 永远不碰 users.*
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATE_FILE = Path(__file__).parent.parent / "state.json"

# 默认用户 (老格式迁移目标)
DEFAULT_USER = "wz"


@dataclass
class FiredSignal:
    """触发的信号事件 (共享)"""
    date: str
    signal_type: str
    action: str
    price: float
    fired_at: str


@dataclass
class State:
    last_run_at: str | None = None
    last_quote: dict[str, Any] | None = None
    fired_signals: list[FiredSignal] = field(default_factory=list)
    # 用户个人数据 - 后端不解析, 只保留原始 dict 透传
    users: dict[str, dict] = field(default_factory=dict)

    def is_already_fired_today(self, date: str, signal_type: str, action: str) -> bool:
        return any(
            s.date == date and s.signal_type == signal_type and s.action == action
            for s in self.fired_signals
        )

    def mark_fired(self, signal: FiredSignal) -> None:
        if self.is_already_fired_today(signal.date, signal.signal_type, signal.action):
            return
        self.fired_signals.append(signal)
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
            "users": self.users,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "State":
        # 自动迁移: 老格式扁平字段 -> users.wz
        users = d.get("users")
        if users is None:
            users = {}
            # 迁移老字段
            old_holding = d.get("holding_shares")
            if old_holding is not None:
                users[DEFAULT_USER] = {
                    "holding_shares": float(old_holding),
                    "avg_cost": float(d.get("avg_cost", 0)),
                    "cash_flow": float(d.get("cash_flow", 0)),
                    "realized_profit": float(d.get("realized_profit", 0)),
                    "acks": [],
                    "skips": [],
                }

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
                )
                for s in d.get("fired_signals", [])
            ],
            users=users,
        )


def load_state(path: Path = STATE_FILE) -> State:
    if not path.exists():
        return State()
    with open(path, "r", encoding="utf-8") as f:
        return State.from_dict(json.load(f))


def save_state(state: State, path: Path = STATE_FILE) -> None:
    """写回 state.json. 注意: 只动 last_run_at / last_quote / fired_signals,
    users 部分原样保留 (Worker 才改 users)."""
    state.last_run_at = datetime.now(timezone.utc).isoformat()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state.to_dict(), f, ensure_ascii=False, indent=2)
