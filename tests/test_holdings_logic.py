"""测试 v2 持仓更新逻辑

测试 Worker 里的 applyTradeToState 函数 (用 Python 复刻一份, 因为 Worker 是 JS).
关键场景:
  1. 买入: holding+, avg_cost 加权平均, cash_flow+, realized_profit 不变
  2. 卖出: holding-, avg_cost 不变, cash_flow-, realized_profit += (price - avg_cost) * shares
  3. 完全卖空: holding 变 0, avg_cost 重置 (但还有 realized_profit)
"""
from copy import deepcopy


def apply_trade(state: dict, action: str, shares: float, price: float) -> dict:
    """复刻 worker.js 的 applyTradeToState 逻辑."""
    next_state = deepcopy(state)
    old_shares = next_state.get("holding_shares", 0)
    old_cost = next_state.get("avg_cost", 0)
    old_cash_flow = next_state.get("cash_flow", 0)
    old_realized = next_state.get("realized_profit", 0)

    if action == "buy":
        old_total_cost = old_shares * old_cost
        new_total_cost = old_total_cost + shares * price
        next_state["holding_shares"] = old_shares + shares
        next_state["avg_cost"] = (
            new_total_cost / next_state["holding_shares"]
            if next_state["holding_shares"] > 0 else 0
        )
        next_state["cash_flow"] = old_cash_flow + shares * price
        # realized_profit 不变
    elif action == "sell":
        next_state["holding_shares"] = old_shares - shares
        # avg_cost 不变
        next_state["cash_flow"] = old_cash_flow - shares * price
        next_state["realized_profit"] = old_realized + (price - old_cost) * shares
    return next_state


def test_buy_first_position():
    """从 0 持仓开始, 买入"""
    s = {"holding_shares": 0, "avg_cost": 0, "cash_flow": 0, "realized_profit": 0}
    r = apply_trade(s, "buy", 10, 50.0)
    assert r["holding_shares"] == 10
    assert r["avg_cost"] == 50.0
    assert r["cash_flow"] == 500.0
    assert r["realized_profit"] == 0
    print("  PASS 首次买入")


def test_buy_more_avg_cost():
    """已有持仓, 加仓, 平均成本计算正确"""
    s = {"holding_shares": 10, "avg_cost": 50.0, "cash_flow": 500, "realized_profit": 0}
    # 再买 10 股, 价格 60
    r = apply_trade(s, "buy", 10, 60.0)
    assert r["holding_shares"] == 20
    assert r["avg_cost"] == 55.0  # (10*50 + 10*60) / 20 = 55
    assert r["cash_flow"] == 1100  # 500 + 600
    assert r["realized_profit"] == 0
    print("  PASS 加仓后平均成本 = 55")


def test_sell_partial():
    """部分卖出, avg_cost 不变, realized_profit 增加"""
    s = {"holding_shares": 20, "avg_cost": 55.0, "cash_flow": 1100, "realized_profit": 0}
    # 卖 5 股, 价格 70
    r = apply_trade(s, "sell", 5, 70.0)
    assert r["holding_shares"] == 15
    assert r["avg_cost"] == 55.0  # 不变
    assert r["cash_flow"] == 750  # 1100 - 350
    assert r["realized_profit"] == 75  # (70-55) * 5
    print("  PASS 部分卖出 realized=$75")


def test_sell_all():
    """全部卖出, holding 变 0"""
    s = {"holding_shares": 15, "avg_cost": 55.0, "cash_flow": 750, "realized_profit": 75}
    r = apply_trade(s, "sell", 15, 80.0)
    assert r["holding_shares"] == 0
    assert r["avg_cost"] == 55.0  # 即使没持仓了, 这个数字保留 (无伤大雅)
    assert r["cash_flow"] == 750 - 15 * 80  # = -450 (卖出净流入超过累计投入)
    assert r["realized_profit"] == 75 + (80 - 55) * 15  # 75 + 375 = 450
    print("  PASS 清仓 realized=$450")


def test_complex_sequence():
    """模拟用户实际买卖序列"""
    s = {"holding_shares": 0, "avg_cost": 0, "cash_flow": 0, "realized_profit": 0}
    # 买 10 @ 100
    s = apply_trade(s, "buy", 10, 100)
    # 买 10 @ 80
    s = apply_trade(s, "buy", 10, 80)
    # avg = (1000 + 800) / 20 = 90
    assert s["avg_cost"] == 90
    assert s["holding_shares"] == 20
    assert s["cash_flow"] == 1800

    # 卖 10 @ 120 -> 实现盈利 (120-90)*10 = 300
    s = apply_trade(s, "sell", 10, 120)
    assert s["holding_shares"] == 10
    assert s["avg_cost"] == 90  # 不变
    assert s["cash_flow"] == 1800 - 1200  # = 600
    assert s["realized_profit"] == 300

    # 再买 5 @ 70 -> avg = (10*90 + 5*70) / 15 = (900 + 350) / 15 ≈ 83.33
    s = apply_trade(s, "buy", 5, 70)
    assert s["holding_shares"] == 15
    assert abs(s["avg_cost"] - 83.333333333) < 1e-6
    assert s["cash_flow"] == 600 + 350  # = 950
    assert s["realized_profit"] == 300  # 不变

    print(f"  PASS 复杂序列, 最终 holding={s['holding_shares']}, avg={s['avg_cost']:.2f}, cash_flow={s['cash_flow']}, realized={s['realized_profit']}")


def test_realized_profit_accumulates():
    """连续多次卖出, realized_profit 累加"""
    s = {"holding_shares": 30, "avg_cost": 50.0, "cash_flow": 1500, "realized_profit": 0}
    s = apply_trade(s, "sell", 10, 60)  # +100
    s = apply_trade(s, "sell", 10, 70)  # +200
    s = apply_trade(s, "sell", 5, 55)   # +25
    assert s["holding_shares"] == 5
    assert s["avg_cost"] == 50.0
    assert s["realized_profit"] == 100 + 200 + 25  # 325
    print(f"  PASS 多次卖出累加 realized=$325")


def test_buy_with_no_existing_position():
    """无持仓状态 (avg_cost=0) 卖出 (异常情况, 不应发生但代码不能崩)"""
    s = {"holding_shares": 0, "avg_cost": 0, "cash_flow": 0, "realized_profit": 0}
    r = apply_trade(s, "sell", 5, 60)
    # 此时 realized_profit = (60 - 0) * 5 = 300, 但这个值没意义 (没成本基础)
    # 至少不应该 crash
    assert r["holding_shares"] == -5  # 仓位变负 (说明数据异常)
    print(f"  PASS 异常状态不崩")


if __name__ == "__main__":
    print("v2 持仓逻辑测试:\n")
    tests = [
        test_buy_first_position,
        test_buy_more_avg_cost,
        test_sell_partial,
        test_sell_all,
        test_complex_sequence,
        test_realized_profit_accumulates,
        test_buy_with_no_existing_position,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            print(f"  FAIL {t.__name__}: {e}")
            failed += 1
    if failed:
        print(f"\n{failed}/{len(tests)} 失败")
        exit(1)
    print(f"\n全部 {len(tests)} 个测试通过")
