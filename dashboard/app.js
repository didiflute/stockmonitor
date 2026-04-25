// TQQQ 网格信号 PWA Dashboard v2
//
// state.json / config.yaml 由 deploy_pages.yml workflow 复制到同目录, 浏览器走相对路径读
// 写操作走 Cloudflare Worker (WORKER_URL), 用一个共享密码做鉴权
//
// 部署后需要把下面的 WORKER_URL 改成你 Cloudflare 部署后拿到的网址

const WORKER_URL = "https://stockmonitor.wendizeng11.workers.dev";  // 改成你的 Worker URL

const STATE_URL = "./state.json";
const CONFIG_URL = "./config.yaml";

const STALE_MINUTES = 15;
const AUTO_REFRESH_SECONDS = 60;

let state = null;
let config = null;
let dashboardPassword = localStorage.getItem("tqqq_password") || "";
let currentSignalForAck = null;  // {action, suggested_shares, suggested_price}

// ---------------- 工具函数 ----------------

function fmtUsd(n, frac = 2) {
  if (n === null || n === undefined || isNaN(n)) return "$--";
  return "$" + Number(n).toLocaleString(undefined, {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}

function fmtPct(n, frac = 2) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  return (Number(n) * 100).toFixed(frac) + "%";
}

function fmtLocalTime(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtRelativeTime(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function showToast(text, durationMs = 2000) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.remove("hide");
  setTimeout(() => t.classList.add("hide"), durationMs);
}

// ---------------- Worker API ----------------

async function callWorker(endpoint, body = {}) {
  if (!dashboardPassword) {
    promptPassword();
    throw new Error("需要密码");
  }
  const r = await fetch(`${WORKER_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": dashboardPassword,
    },
    body: JSON.stringify(body),
  });
  if (r.status === 401) {
    localStorage.removeItem("tqqq_password");
    dashboardPassword = "";
    promptPassword();
    throw new Error("密码错误");
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "unknown" }));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return await r.json();
}

// ---------------- 密码弹窗 ----------------

function promptPassword() {
  document.getElementById("modal-password").classList.remove("hide");
  setTimeout(() => document.getElementById("modal-password-input").focus(), 100);
}

async function submitPassword() {
  const pwd = document.getElementById("modal-password-input").value;
  if (!pwd) return;
  dashboardPassword = pwd;
  // 用 /api/auth 验证一下
  try {
    const r = await fetch(`${WORKER_URL}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": pwd },
      body: "{}",
    });
    if (r.status === 401) {
      showToast("密码错误");
      return;
    }
    if (!r.ok) {
      showToast("Worker 连接失败 - 检查 WORKER_URL 是否正确");
      return;
    }
    localStorage.setItem("tqqq_password", pwd);
    document.getElementById("modal-password").classList.add("hide");
    showToast("登录成功");
  } catch (e) {
    showToast("无法连接 Worker: " + e.message);
  }
}

// 回车提交密码
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !document.getElementById("modal-password").classList.contains("hide")) {
    submitPassword();
  }
});

// ---------------- 数据加载 ----------------

async function fetchState() {
  try {
    const r = await fetch(STATE_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    state = await r.json();
  } catch (e) {
    document.getElementById("page-sub").textContent = "无法读 state.json: " + e.message;
    return null;
  }
  return state;
}

async function fetchConfig() {
  try {
    const r = await fetch(CONFIG_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = await r.text();
    config = parseSimpleYaml(text);
  } catch (e) {
    config = {
      signal: { type: "weekly", drop_threshold: -0.07, rise_threshold: 0.08 },
      trade: { buy_amount_usd: 500, sell_amount_usd: 500 },
      notifications: {
        pushover: { enabled: true, recipients: ["wendi"] },
        email: { enabled: true, to: [] },
      },
    };
  }
  return config;
}

// 极简 YAML 解析 (仅满足我们这个 config.yaml 结构)
function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ obj: root, indent: -1, parent: null, key: null }];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = rawLine.match(/^ */)[0].length;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];
    let parent = top.obj;

    if (line.trim().startsWith("- ")) {
      const val = line.trim().slice(2).trim();
      if (top.key && !Array.isArray(top.parent[top.key])) top.parent[top.key] = [];
      const arr = top.parent[top.key];
      arr.push(parseScalar(val));
      continue;
    }

    const m = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, , key, valRaw] = m;
    if (valRaw === "" || valRaw === undefined) {
      const child = {};
      parent[key] = child;
      stack.push({ obj: child, indent, parent, key });
    } else {
      parent[key] = parseScalar(valRaw);
    }
  }
  return root;
}

function parseScalar(s) {
  s = s.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "[]") return [];
  return s.replace(/^["']|["']$/g, "");
}

// ---------------- 渲染: 今日 ----------------

function renderToday() {
  if (!state || !config) return;
  const q = state.last_quote || {};
  const sigType = config.signal.type;
  document.getElementById("signal-type-pill").textContent =
    { daily: "每日", weekly: "每周", monthly: "每月" }[sigType] + " 信号";

  // 持仓
  const shares = state.holding_shares || 0;
  const price = q.price || 0;
  const value = shares * price;
  const cost = state.avg_cost || 0;
  const pnl = value - shares * cost;
  document.getElementById("h-shares").textContent = shares.toFixed(0) + " 股";
  document.getElementById("h-value").textContent = fmtUsd(value, 0);
  const pnlEl = document.getElementById("h-pnl");
  pnlEl.textContent = (pnl >= 0 ? "+" : "") + fmtUsd(pnl, 0);
  pnlEl.classList.toggle("up", pnl >= 0);
  pnlEl.classList.toggle("down", pnl < 0);

  // 当前价
  document.getElementById("current-price").textContent = fmtUsd(price);
  const dayChangeEl = document.getElementById("day-change");
  if (q.change_rate !== undefined) {
    const sign = q.change_rate >= 0 ? "↑ " : "↓ ";
    dayChangeEl.textContent = sign + fmtPct(Math.abs(q.change_rate));
    dayChangeEl.classList.toggle("up", q.change_rate >= 0);
    dayChangeEl.classList.toggle("down", q.change_rate < 0);
  }

  // 触发预测
  document.getElementById("buy-trigger").textContent = fmtUsd(q.buy_trigger_price);
  document.getElementById("sell-trigger").textContent = fmtUsd(q.sell_trigger_price);
  if (q.buy_trigger_price && price) {
    const dist = (price - q.buy_trigger_price) / price * 100;
    document.getElementById("buy-distance").textContent = `还需跌 ${dist.toFixed(1)}%`;
  }
  if (q.sell_trigger_price && price) {
    const dist = (q.sell_trigger_price - price) / price * 100;
    document.getElementById("sell-distance").textContent =
      dist >= 0 ? `还需涨 ${dist.toFixed(1)}%` : `已超 ${(-dist).toFixed(1)}%`;
  }
  document.getElementById("forecast-note").textContent =
    `明天 TQQQ 若跌到 ${fmtUsd(q.buy_trigger_price)} 触发买入, 涨到 ${fmtUsd(q.sell_trigger_price)} 触发卖出.`;

  // 信号警告卡
  const alertCard = document.getElementById("alert-card");
  if (q.action === "buy" || q.action === "sell") {
    const today = new Date().toISOString().slice(0, 10);
    const fired = (state.fired_signals || []).find(
      s => s.date === today && s.signal_type === sigType && s.action === q.action
    );
    if (fired && !fired.user_acknowledged && !fired.user_skipped) {
      alertCard.classList.remove("hide");
      const actionLabel = q.action === "buy" ? "买入" : "卖出";
      document.getElementById("alert-action").textContent = "已触发" + actionLabel;
      document.getElementById("alert-meta").textContent =
        `${{ daily: "每日", weekly: "每周", monthly: "每月" }[sigType]}信号`;
      document.getElementById("alert-desc").textContent =
        `变化率 ${fmtPct(q.change_rate)} (阈值 ${fmtPct(q.action === "buy" ? config.signal.drop_threshold : config.signal.rise_threshold, 0)})`;
      // 缓存信号信息供 ack 对话框用
      const tradeAmount = q.action === "buy"
        ? config.trade.buy_amount_usd
        : config.trade.sell_amount_usd;
      currentSignalForAck = {
        date: today,
        signal_type: sigType,
        action: q.action,
        suggested_shares: tradeAmount / price,
        suggested_price: price,
      };
    } else {
      alertCard.classList.add("hide");
    }
  } else {
    alertCard.classList.add("hide");
  }

  // 顶部更新时间 banner
  const banner = document.getElementById("updated-banner");
  if (state.last_run_at) {
    const d = new Date(state.last_run_at);
    const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
    banner.textContent = `数据更新于 ${fmtLocalTime(state.last_run_at)} (${fmtRelativeTime(state.last_run_at)})`;
    banner.classList.toggle("stale", minutes > STALE_MINUTES);
  }
  document.getElementById("page-sub").textContent =
    new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", weekday: "long" });
}

// ---------------- 渲染: 设置 ----------------

function renderSettings() {
  if (!config) return;
  ["daily", "weekly", "monthly"].forEach(t => {
    document.getElementById("r-" + t).classList.toggle("on", config.signal.type === t);
  });
  document.getElementById("i-drop").value = (Math.abs(config.signal.drop_threshold) * 100).toFixed(1);
  document.getElementById("i-rise").value = (config.signal.rise_threshold * 100).toFixed(1);
  document.getElementById("i-buy").value = config.trade.buy_amount_usd;
  document.getElementById("i-sell").value = config.trade.sell_amount_usd;
}

// ---------------- 渲染: 历史 ----------------

function renderHistory() {
  if (!state) return;
  const q = state.last_quote || {};

  const shares = state.holding_shares || 0;
  const price = q.price || 0;
  const cost = state.avg_cost || 0;
  const cashflow = state.cash_flow || 0;
  const realized = state.realized_profit || 0;
  const currentValue = shares * price;
  const totalAssets = currentValue + realized;

  document.getElementById("m-current").textContent = fmtUsd(currentValue, 0);
  document.getElementById("m-avgcost").textContent = fmtUsd(cost);
  document.getElementById("m-price").textContent = fmtUsd(price);
  document.getElementById("m-cashflow").textContent = fmtUsd(cashflow, 0);
  document.getElementById("m-total").textContent = fmtUsd(totalAssets, 0);
  document.getElementById("m-realized").textContent = (realized >= 0 ? "+" : "") + fmtUsd(realized, 0);

  // 信号列表
  const list = document.getElementById("signal-list");
  list.innerHTML = "";
  const fired = state.fired_signals || [];
  if (fired.length === 0) {
    list.innerHTML = '<div style="padding: 14px 0; text-align: center; color: #999; font-size: 13px;">还没有触发过信号</div>';
    return;
  }
  fired.slice().reverse().slice(0, 30).forEach(s => {
    const row = document.createElement("div");
    row.className = "list-item";
    let statusTag = "";
    if (s.user_acknowledged) statusTag = `<span class="tag-ack">✓ 已成交</span>`;
    else if (s.user_skipped) statusTag = `<span class="tag-skipped">已跳过</span>`;
    const actionTag = s.action === "buy"
      ? `<span class="tag-buy">买</span>`
      : `<span class="tag-sell">卖</span>`;
    const execNote = s.user_acknowledged && s.executed_shares
      ? `<span class="label-mute">${s.executed_shares} 股 @ ${fmtUsd(s.executed_price)}</span>`
      : `<span class="label-mute">@ ${fmtUsd(s.price)}</span>`;
    row.innerHTML = `
      <span style="flex: 0 0 auto;">${s.date}</span>
      ${actionTag}
      ${execNote}
      ${statusTag}
    `;
    list.appendChild(row);
  });
}

// ---------------- 渲染: 通知 ----------------

function renderNotify() {
  if (!config) return;
  const recList = document.getElementById("recipients-list");
  recList.innerHTML = "";

  const grouped = {};
  (config.notifications.pushover?.recipients || []).forEach(r => {
    if (!grouped[r]) grouped[r] = { name: r, channels: [] };
    grouped[r].channels.push("Pushover");
  });
  (config.notifications.email?.to || []).forEach(e => {
    const name = e.split("@")[0];
    if (!grouped[name]) grouped[name] = { name, channels: [] };
    grouped[name].channels.push("邮件");
  });
  Object.values(grouped).forEach(p => {
    const row = document.createElement("div");
    row.className = "opt";
    row.style.justifyContent = "space-between";
    row.innerHTML = `
      <span class="name">${p.name}</span>
      <span class="label-mute">${p.channels.join(" + ")}</span>
    `;
    recList.appendChild(row);
  });

  const chList = document.getElementById("channels-list");
  chList.innerHTML = "";
  const channels = [
    { label: "Pushover (iOS 推送)", desc: "主通道", enabled: config.notifications.pushover?.enabled },
    { label: "邮件 (Gmail)", desc: "备份", enabled: config.notifications.email?.enabled },
  ];
  channels.forEach(c => {
    const row = document.createElement("div");
    row.className = "opt";
    row.style.justifyContent = "space-between";
    row.innerHTML = `
      <div><div>${c.label}</div><div class="label-mute">${c.desc}</div></div>
      <span class="label-mute">${c.enabled ? "开启" : "关闭"}</span>
    `;
    chList.appendChild(row);
  });
}

// ---------------- Tab 切换 ----------------

function switchTab(name) {
  ["today", "settings", "history", "notify"].forEach(t => {
    document.getElementById("tab-" + t).classList.toggle("hide", t !== name);
  });
  document.querySelectorAll(".tab-item").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === name);
  });
  if (name === "today") renderToday();
  if (name === "settings") renderSettings();
  if (name === "history") renderHistory();
  if (name === "notify") renderNotify();
}

// ---------------- 已下单对话框 ----------------

function openAckDialog() {
  if (!currentSignalForAck) {
    showToast("没有待确认的信号");
    return;
  }
  const sig = currentSignalForAck;
  document.getElementById("ack-title").textContent =
    `确认${sig.action === "buy" ? "买入" : "卖出"}成交`;
  document.getElementById("ack-summary").textContent =
    `${{ daily: "每日", weekly: "每周", monthly: "每月" }[sig.signal_type]}信号 · 建议 ${sig.suggested_shares.toFixed(2)} 股 @ ${fmtUsd(sig.suggested_price)}`;
  document.getElementById("ack-shares").value = sig.suggested_shares.toFixed(2);
  document.getElementById("ack-price").value = sig.suggested_price.toFixed(2);
  document.getElementById("modal-ack").classList.remove("hide");
}

function closeAckDialog() {
  document.getElementById("modal-ack").classList.add("hide");
}

async function confirmAck() {
  const sig = currentSignalForAck;
  if (!sig) return;
  const shares = parseFloat(document.getElementById("ack-shares").value);
  const price = parseFloat(document.getElementById("ack-price").value);
  if (!shares || !price || shares <= 0 || price <= 0) {
    showToast("请填写有效的股数和价格");
    return;
  }
  const btn = document.getElementById("ack-confirm-btn");
  btn.disabled = true;
  btn.textContent = "提交中...";
  try {
    await callWorker("/api/ack", {
      date: sig.date, signal_type: sig.signal_type, action: sig.action,
      shares, price,
    });
    closeAckDialog();
    showToast("已成交, 持仓已更新");
    setTimeout(reloadAll, 1500);
  } catch (e) {
    showToast("失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✓ 确认成交";
  }
}

async function skipSignal() {
  if (!currentSignalForAck) return;
  if (!confirm("确认跳过这次信号? (今天不再提醒, 第二天会重新评估)")) return;
  const sig = currentSignalForAck;
  try {
    await callWorker("/api/skip", {
      date: sig.date, signal_type: sig.signal_type, action: sig.action,
    });
    showToast("已跳过");
    setTimeout(reloadAll, 1000);
  } catch (e) {
    showToast("失败: " + e.message);
  }
}

// ---------------- 设置 Tab 写入 config ----------------

async function updateSignalType(t) {
  if (!config) return;
  config.signal.type = t;
  renderSettings();
  try {
    await callWorker("/api/config", { signal_type: t });
    showToast(`信号类型改为${{ daily: "每日", weekly: "每周", monthly: "每月" }[t]}`);
    setTimeout(reloadAll, 1500);
  } catch (e) {
    showToast("写回 config 失败: " + e.message);
  }
}

async function updateThreshold(which, val) {
  const num = parseFloat(val);
  if (isNaN(num)) return;
  const key = which === "drop" ? "drop_threshold" : "rise_threshold";
  const value = which === "drop" ? -Math.abs(num) / 100 : Math.abs(num) / 100;
  try {
    await callWorker("/api/config", { [key]: value });
    showToast(`${which === "drop" ? "买入跌幅" : "卖出涨幅"}阈值已更新`);
    setTimeout(fetchConfig, 1500);
  } catch (e) {
    showToast("失败: " + e.message);
  }
}

async function updateTradeAmount(which, val) {
  const num = parseFloat(val);
  if (isNaN(num) || num <= 0) return;
  const key = which === "buy" ? "buy_amount_usd" : "sell_amount_usd";
  try {
    await callWorker("/api/config", { [key]: num });
    showToast(`${which === "buy" ? "买入" : "卖出"}金额改为 $${num}`);
    setTimeout(fetchConfig, 1500);
  } catch (e) {
    showToast("失败: " + e.message);
  }
}

// ---------------- 手动刷新 ----------------

async function manualRefresh() {
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("spin");
  try {
    await callWorker("/api/refresh", {});
    showToast("已触发后端, 30-60 秒后自动同步");
    // 5 秒后开始轮询新数据
    let tries = 0;
    const oldTime = state?.last_run_at;
    const poll = setInterval(async () => {
      tries++;
      await fetchState();
      if (state?.last_run_at !== oldTime || tries >= 18) {
        clearInterval(poll);
        btn.classList.remove("spin");
        if (state?.last_run_at !== oldTime) {
          renderToday();
          showToast("数据已更新");
        }
      }
    }, 5000);
  } catch (e) {
    btn.classList.remove("spin");
    showToast("刷新失败: " + e.message);
  }
}

// ---------------- 重新加载 ----------------

async function reloadAll() {
  await Promise.all([fetchState(), fetchConfig()]);
  const activeTab = document.querySelector(".tab-item.active")?.dataset.tab || "today";
  switchTab(activeTab);
}

// ---------------- 初始化 ----------------

async function init() {
  await Promise.all([fetchState(), fetchConfig()]);
  renderToday();
  // 每分钟自动重新加载 state.json
  setInterval(async () => {
    await fetchState();
    const activeTab = document.querySelector(".tab-item.active")?.dataset.tab || "today";
    if (activeTab === "today") renderToday();
    else if (activeTab === "history") renderHistory();
  }, AUTO_REFRESH_SECONDS * 1000);
}
init();
