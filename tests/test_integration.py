"""集成测试 - mock 价格数据, 跑完整 pipeline."""
import sys
import tempfile
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from grid_signal import evaluate_signal
from state import State, FiredSignal, load_state, save_state


def test_buy_signal_triggered():
    historical = [60.0] * 20
    result = evaluate_signal(50.0, historical, "monthly", -0.07, 0.08)
    assert result.action == "buy"
    assert result.is_triggered
    assert abs(result.buy_trigger_price - 60.0 * 0.93) < 1e-9
    print(f"  PASS 暴跌触发买入: {result.change_rate:+.2%}")


def test_sell_signal_triggered():
    historical = [49.5] * 20
    result = evaluate_signal(62.56, historical, "monthly", -0.07, 0.08)
    assert result.action == "sell"
    print(f"  PASS 暴涨触发卖出: {result.change_rate:+.2%}")


def test_no_signal():
    historical = [60.0] * 20
    result = evaluate_signal(61.0, historical, "monthly")
    assert result.action == "hold"
    print(f"  PASS 小幅波动不触发: {result.change_rate:+.2%}")


def test_state_round_trip():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "state.json"
        s1 = State()
        s1.holding_shares = 131.5
        s1.avg_cost = 48.37
        s1.mark_fired(FiredSignal(
            date="2026-04-24",
            signal_type="monthly",
            action="sell",
            price=62.56,
            fired_at=datetime.now(timezone.utc).isoformat(),
        ))
        save_state(s1, path)

        s2 = load_state(path)
        assert s2.holding_shares == 131.5
        assert len(s2.fired_signals) == 1
        assert s2.fired_signals[0].action == "sell"
        print(f"  PASS 状态读写正确")


def test_dedup_same_signal():
    s = State()
    sig = FiredSignal(
        date="2026-04-24",
        signal_type="monthly",
        action="sell",
        price=62.56,
        fired_at="2026-04-24T14:23:00+00:00",
    )
    s.mark_fired(sig)
    s.mark_fired(sig)
    s.mark_fired(sig)
    assert len(s.fired_signals) == 1
    assert s.is_already_fired_today("2026-04-24", "monthly", "sell")
    assert not s.is_already_fired_today("2026-04-24", "monthly", "buy")
    assert not s.is_already_fired_today("2026-04-25", "monthly", "sell")
    print(f"  PASS 去重逻辑正确")


def test_threshold_boundary():
    historical = [100.0] * 20
    r = evaluate_signal(108.0, historical, "monthly", -0.07, 0.08)
    assert r.action == "sell", f"+8% boundary expected sell, got {r.action}"
    r = evaluate_signal(107.99, historical, "monthly", -0.07, 0.08)
    assert r.action == "hold", f"+7.99% expected hold, got {r.action}"
    r = evaluate_signal(93.0, historical, "monthly", -0.07, 0.08)
    assert r.action == "buy", f"-7% boundary expected buy, got {r.action}"
    r = evaluate_signal(92.99, historical, "monthly", -0.07, 0.08)
    assert r.action == "buy", f"-7.01% expected buy, got {r.action}"
    print(f"  PASS 阈值边界处理正确")


def test_custom_thresholds():
    historical = [100.0] * 5
    r = evaluate_signal(105.0, historical, "weekly", -0.05, 0.06)
    assert r.action == "hold"
    r = evaluate_signal(106.0, historical, "weekly", -0.05, 0.06)
    assert r.action == "sell"
    r = evaluate_signal(95.0, historical, "weekly", -0.05, 0.06)
    assert r.action == "buy"
    print(f"  PASS 自定义阈值生效")


def test_all_signal_types():
    """三种信号都能正常评估"""
    historical = [100.0] * 25
    for sig_type in ("daily", "weekly", "monthly"):
        r = evaluate_signal(95.0, historical, sig_type, -0.07, 0.08)
        assert r.signal_type == sig_type
        assert r.action == "hold"  # -5% 不触发 -7% 阈值
    print(f"  PASS 三种信号类型 (daily/weekly/monthly)")


if __name__ == "__main__":
    print("集成测试:\n")
    tests = [
        test_buy_signal_triggered,
        test_sell_signal_triggered,
        test_no_signal,
        test_state_round_trip,
        test_dedup_same_signal,
        test_threshold_boundary,
        test_custom_thresholds,
        test_all_signal_types,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            print(f"  FAIL {t.__name__}: {e}")
            failed += 1
    if failed:
        print(f"\n{failed}/{len(tests)} 测试失败")
        sys.exit(1)
    print(f"\n全部 {len(tests)} 个测试通过")
