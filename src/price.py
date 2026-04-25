"""TQQQ 价格获取

主源: Yahoo Finance (yfinance, 免费, 无需 API key, 延迟通常 < 2 分钟)
备源: Finnhub (免费 60 次/分钟, 需要在 finnhub.io 注册一个 API key)

如果主源失败 (网络抽风 / Yahoo 限流), 自动切到备源.
"""
from __future__ import annotations

import os
import time
import logging
from dataclasses import dataclass

import yfinance as yf

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PriceQuote:
    symbol: str
    price: float
    timestamp: int  # Unix epoch (秒)
    source: str    # "yahoo" | "finnhub"


def fetch_current_price_yahoo(symbol: str) -> PriceQuote:
    """从 Yahoo Finance 获取当前价格.

    yfinance.Ticker.fast_info 返回最新价 (盘中近实时, 盘后 = 最近收盘).
    """
    ticker = yf.Ticker(symbol)
    info = ticker.fast_info
    price = info.get("last_price") or info.get("lastPrice")
    if price is None:
        # 兜底: 用最近一根 1 分钟 K 线
        hist = ticker.history(period="1d", interval="1m")
        if hist.empty:
            raise RuntimeError(f"Yahoo 没返回 {symbol} 的价格")
        price = float(hist["Close"].iloc[-1])
    return PriceQuote(
        symbol=symbol,
        price=float(price),
        timestamp=int(time.time()),
        source="yahoo",
    )


def fetch_current_price_finnhub(symbol: str) -> PriceQuote:
    """从 Finnhub 获取当前价格 (备源).

    需要环境变量 FINNHUB_API_KEY.
    """
    api_key = os.environ.get("FINNHUB_API_KEY")
    if not api_key:
        raise RuntimeError("未设置 FINNHUB_API_KEY 环境变量")

    import urllib.request
    import json
    url = f"https://finnhub.io/api/v1/quote?symbol={symbol}&token={api_key}"
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read().decode())
    if "c" not in data or data["c"] in (0, None):
        raise RuntimeError(f"Finnhub 返回异常: {data}")
    return PriceQuote(
        symbol=symbol,
        price=float(data["c"]),
        timestamp=int(data.get("t", time.time())),
        source="finnhub",
    )


def fetch_historical_closes(symbol: str, days: int = 30) -> list[float]:
    """获取过去 N 个交易日的收盘价 (按距离今天由近到远排序).

    返回值: [昨天close, 前天close, ...]
    """
    ticker = yf.Ticker(symbol)
    # 多取一些防止节假日不够
    hist = ticker.history(period=f"{days * 2 + 10}d", interval="1d")
    if hist.empty:
        raise RuntimeError(f"Yahoo 没返回 {symbol} 的历史数据")
    # hist.index 是日期升序; 我们要除"今天"以外的最近 N 天, 倒序
    closes = hist["Close"].astype(float).tolist()
    dates = list(hist.index)
    today = dates[-1].date()
    # 排除今天 (我们用实时价作为今天)
    historical = [(d.date(), c) for d, c in zip(dates, closes) if d.date() < today]
    historical.sort(key=lambda x: x[0], reverse=True)  # 由近到远
    return [c for _, c in historical[:days]]


def fetch_current_price(symbol: str = "TQQQ") -> PriceQuote:
    """主入口: 先试 Yahoo, 失败切到 Finnhub."""
    try:
        return fetch_current_price_yahoo(symbol)
    except Exception as e:
        logger.warning(f"Yahoo 获取价格失败 ({e}), 尝试 Finnhub 备源...")
        try:
            return fetch_current_price_finnhub(symbol)
        except Exception as e2:
            raise RuntimeError(f"主备源都失败. Yahoo: {e}; Finnhub: {e2}")


if __name__ == "__main__":
    # 简单测试
    quote = fetch_current_price("TQQQ")
    print(f"当前价: ${quote.price:.2f} (来源: {quote.source}, 时间戳: {quote.timestamp})")
    closes = fetch_historical_closes("TQQQ", days=20)
    print(f"过去 20 天收盘价 (近→远): {[f'{c:.2f}' for c in closes]}")
