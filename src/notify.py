"""通知模块 (Pushover 推送 + Gmail SMTP 邮件备份)

- 主通道: Pushover (https://pushover.net)
  - 每人独立 USER_KEY, 一个 App 共用一个 API_TOKEN
  - iOS 走 APNs, 国内可用且稳定
- 备份: Gmail SMTP
  - 万一 Pushover 推送没收到, 邮箱里至少留个底
  - 需要 Gmail 应用专用密码 (App Password)
- 不用微信, 不用短信

环境变量 (走 GitHub Secrets):
  PUSHOVER_API_TOKEN          - Pushover 后台创建的 App Token
  PUSHOVER_USER_WENDI         - 你的 User Key
  PUSHOVER_USER_HUSBAND       - 老公的 User Key (可选)
  GMAIL_USER                  - 你的 Gmail 地址
  GMAIL_APP_PASSWORD          - Gmail 应用专用密码 (16 位)
"""
from __future__ import annotations

import os
import json
import smtplib
import logging
import urllib.request
import urllib.parse
from dataclasses import dataclass
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr

logger = logging.getLogger(__name__)


@dataclass
class NotifyMessage:
    title: str
    body: str
    body_html: str = ""
    url: str = ""
    url_title: str = ""


# ---------------- Pushover 推送 ----------------

def send_pushover(msg: NotifyMessage, recipient_keys: dict[str, str]) -> dict[str, bool]:
    """通过 Pushover 给每个收件人发推送.

    参数:
        recipient_keys: { "wendi": "USER_KEY_xxx", "husband": "USER_KEY_yyy" }
    """
    api_token = os.environ.get("PUSHOVER_API_TOKEN")
    if not api_token:
        logger.warning("未配置 PUSHOVER_API_TOKEN, 跳过推送")
        return {n: False for n in recipient_keys}

    results = {}
    for name, user_key in recipient_keys.items():
        if not user_key:
            results[name] = False
            continue
        payload = {
            "token": api_token,
            "user": user_key,
            "title": msg.title,
            "message": msg.body,
            "priority": 1,
            "sound": "cashregister",
        }
        if msg.url:
            payload["url"] = msg.url
            if msg.url_title:
                payload["url_title"] = msg.url_title

        data = urllib.parse.urlencode(payload).encode("utf-8")
        try:
            with urllib.request.urlopen(
                "https://api.pushover.net/1/messages.json",
                data=data,
                timeout=10,
            ) as resp:
                ok = resp.status == 200
                body = json.loads(resp.read().decode())
                ok = ok and body.get("status") == 1
                results[name] = ok
                if ok:
                    logger.info(f"Pushover -> {name}: OK")
                else:
                    logger.error(f"Pushover -> {name}: 失败, 响应 {body}")
        except Exception as e:
            logger.error(f"Pushover -> {name} 异常: {e}")
            results[name] = False
    return results


# ---------------- Gmail SMTP 邮件 ----------------

def send_email_gmail(msg: NotifyMessage, to_addrs: list[str]) -> bool:
    """通过 Gmail SMTP 发邮件 (备份通道).

    需要的环境变量:
      GMAIL_USER: 你的 gmail 地址
      GMAIL_APP_PASSWORD: 16 位应用专用密码 (不是登录密码)
        - 生成: https://myaccount.google.com/apppasswords
        - 前提: 账号开启了 2-Step Verification
    """
    user = os.environ.get("GMAIL_USER")
    pwd = os.environ.get("GMAIL_APP_PASSWORD")
    if not user or not pwd:
        logger.info("未配置 GMAIL_USER / GMAIL_APP_PASSWORD, 跳过邮件备份")
        return False
    if not to_addrs:
        return False

    em = MIMEMultipart("alternative")
    em["Subject"] = msg.title
    em["From"] = formataddr(("TQQQ 信号", user))
    em["To"] = ", ".join(to_addrs)
    em.attach(MIMEText(msg.body, "plain", "utf-8"))
    if msg.body_html:
        em.attach(MIMEText(msg.body_html, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=15) as smtp:
            smtp.login(user, pwd)
            smtp.sendmail(user, to_addrs, em.as_string())
        logger.info(f"Gmail 邮件已发送给 {to_addrs}")
        return True
    except Exception as e:
        logger.error(f"Gmail 邮件发送失败: {e}")
        return False


# ---------------- 主入口 ----------------

def notify_all(msg: NotifyMessage, config: dict) -> dict:
    """根据 config 同时发到所有启用的渠道."""
    results = {}
    if config.get("pushover", {}).get("enabled"):
        results["pushover"] = send_pushover(msg, config["pushover"]["recipient_keys"])
    if config.get("email", {}).get("enabled"):
        results["email"] = send_email_gmail(msg, config["email"]["to"])
    return results
