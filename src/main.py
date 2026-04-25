"""主入口 - GitHub Actions 每 5 分钟跑一次

流程:
  1. 检查是否在通知时段 (默认仅美股盘中)
  2. 拉 TQQQ 实时价格 (Yahoo, 失败切 Finnhub)
  3. 拉过去 N 个交易日历史价
  4. 评估信号
  5. 如果触发 + 今日同类型同动作还没通知过 -> 发通知
  6. 写回 state.json
"""
from __future__ import annotations

import sys
import os
import logging
import yaml
from pathlib import Path
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent))

from grid_signal import evaluate_signal, WINDOW_BY_TYPE, SignalType
from price import fetch_current_price, fetch_historical_closes
from state import load_state, save_state, FiredSignal
from notify import notify_all, NotifyMessage


CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"
ET = ZoneInfo("America/New_York")


def is_market_open(now_utc: datetime | None = None) -> bool:
    """美股盘中 = 工作日 美东 9:30 - 16:00."""
    now_et = (now_utc or datetime.now(timezone.utc)).astimezone(ET)
    if now_et.weekday() >= 5:  # 周六日
        return False
    open_time = now_et.replace(hour=9, minute=30, second=0, microsecond=0)
    close_time = now_et.replace(hour=16, minute=0, second=0, microsecond=0)
    return open_time <= now_et <= close_time


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def build_notification_config(cfg: dict) -> dict:
    """把 config.yaml + 环境变量组装成 notify_all 需要的格式."""
    n = cfg["notifications"]
    out = {}

    # 主通道: Pushover
    if n.get("pushover", {}).get("enabled"):
        keys = {}
        for name in n["pushover"]["recipients"]:
            env_key = f"PUSHOVER_USER_{name.upper()}"
            keys[name] = os.environ.get(env_key, "")
        out["pushover"] = {"enabled": True, "recipient_keys": keys}

    # 备份: Resend 邮件
    if n.get("email", {}).get("enabled"):
        out["email"] = {"enabled": True, "to": n["email"]["to"]}

    return out


def format_signal_message(
    cfg: dict, current_price: float, result, now_et: datetime
) -> NotifyMessage:
    sig_label = {"daily": "每日", "weekly": "每周", "monthly": "每月"}[result.signal_type]
    action_label = "买入" if result.action == "buy" else "卖出"
    chg_pct = result.change_rate * 100
    threshold_pct = (result.drop_threshold if result.action == "buy" else result.rise_threshold) * 100

    title = f"TQQQ {sig_label}信号触发: {action_label} @ ${current_price:.2f}"

    body = (
        f"⚡ TQQQ 触发{action_label}信号\n\n"
        f"当前价: ${current_price:.2f}\n"
        f"{sig_label}变化率: {chg_pct:+.2f}% (阈值 {threshold_pct:+.0f}%)\n"
        f"参考价: ${result.reference_price:.2f}\n"
        f"触发时间: {now_et.strftime('%Y-%m-%d %H:%M ET')}\n\n"
        f"建议下单金额: ${cfg['trade']['buy_amount_usd' if result.action == 'buy' else 'sell_amount_usd']}\n"
        f"参考股数: {cfg['trade']['buy_amount_usd' if result.action == 'buy' else 'sell_amount_usd'] / current_price:.2f} 股\n\n"
        f"——————\n"
        f"明日触发预测:\n"
        f"  跌至 ${result.buy_trigger_price:.2f} 触发买入\n"
        f"  涨至 ${result.sell_trigger_price:.2f} 触发卖出"
    )

    body_html = f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px;">
      <h2 style="margin: 0 0 12px;">⚡ TQQQ 触发{action_label}信号</h2>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr><td style="padding: 6px 0; color: #666;">当前价</td><td style="text-align: right; font-weight: 500;">${current_price:.2f}</td></tr>
        <tr><td style="padding: 6px 0; color: #666;">{sig_label}变化率</td><td style="text-align: right; color: {'#A32D2D' if result.action == 'sell' else '#3B6D11'};">{chg_pct:+.2f}% (阈值 {threshold_pct:+.0f}%)</td></tr>
        <tr><td style="padding: 6px 0; color: #666;">参考价</td><td style="text-align: right;">${result.reference_price:.2f}</td></tr>
        <tr><td style="padding: 6px 0; color: #666;">触发时间</td><td style="text-align: right;">{now_et.strftime('%H:%M ET')}</td></tr>
        <tr><td style="padding: 6px 0; color: #666;">建议金额</td><td style="text-align: right;">${cfg['trade']['buy_amount_usd' if result.action == 'buy' else 'sell_amount_usd']}</td></tr>
      </table>
      <p style="font-size: 12px; color: #999; margin-top: 16px;">
        明日触发预测: 跌至 ${result.buy_trigger_price:.2f} 触发买入, 涨至 ${result.sell_trigger_price:.2f} 触发卖出
      </p>
    </div>
    """

    return NotifyMessage(title=title, body=body, body_html=body_html)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    log = logging.getLogger("main")

    cfg = load_config()
    state = load_state()

    now_utc = datetime.now(timezone.utc)
    now_et = now_utc.astimezone(ET)

    # 1. 通知时段检查
    market_only = cfg.get("quiet_hours", {}).get("market_only", True)
    market_open = is_market_open(now_utc)
    if market_only and not market_open:
        log.info(f"美股未开盘 (北京 {now_utc.astimezone(ZoneInfo('Asia/Shanghai')).strftime('%H:%M')}), 跳过本次")
        # 仍然更新 state.last_run_at 让 dashboard 知道脚本在跑
        save_state(state)
        return

    # 2. 拉价格
    log.info(f"开始拉取 {cfg['ticker']} 价格...")
    quote = fetch_current_price(cfg["ticker"])
    log.info(f"当前价: ${quote.price:.2f} (来源: {quote.source})")

    # 3. 拉历史
    sig_type: SignalType = cfg["signal"]["type"]
    needed = WINDOW_BY_TYPE[sig_type]
    historical = fetch_historical_closes(cfg["ticker"], days=max(needed + 5, 25))
    log.info(f"历史 {len(historical)} 天: 最近 5 天 {[f'${c:.2f}' for c in historical[:5]]}")

    # 4. 评估
    result = evaluate_signal(
        current_price=quote.price,
        historical_closes=historical,
        signal_type=sig_type,
        drop_threshold=cfg["signal"]["drop_threshold"],
        rise_threshold=cfg["signal"]["rise_threshold"],
    )
    log.info(f"信号: {result.action} (变化率 {result.change_rate:+.2%}, 参考价 ${result.reference_price:.2f})")

    # 5. 状态快照 (即使没触发, dashboard 也要看)
    state.last_quote = {
        "price": quote.price,
        "timestamp": quote.timestamp,
        "source": quote.source,
        "signal_type": sig_type,
        "change_rate": result.change_rate,
        "action": result.action,
        "buy_trigger_price": result.buy_trigger_price,
        "sell_trigger_price": result.sell_trigger_price,
        "reference_price": result.reference_price,
    }

    # 6. 触发 + 未通知过 -> 发通知
    today_et = now_et.strftime("%Y-%m-%d")
    if result.is_triggered:
        if state.is_already_fired_today(today_et, sig_type, result.action):
            log.info(f"今天已通知过 {sig_type}-{result.action}, 跳过 (防重复)")
        else:
            log.info("发送通知...")
            msg = format_signal_message(cfg, quote.price, result, now_et)
            notify_cfg = build_notification_config(cfg)
            send_results = notify_all(msg, notify_cfg)
            log.info(f"通知结果: {send_results}")

            state.mark_fired(FiredSignal(
                date=today_et,
                signal_type=sig_type,
                action=result.action,
                price=quote.price,
                fired_at=now_utc.isoformat(),
            ))

    # 7. 写回 state
    save_state(state)
    log.info("完成")


if __name__ == "__main__":
    main()
