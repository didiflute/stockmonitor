// TQQQ 网格信号 PWA Dashboard v3
//
// 多用户独立数据 (WZ / FP), 通过 X-User-Id header 区分.
// 共享: last_quote, fired_signals (信号事件)
// 个人: users[uid] = { holdings, acks, skips }

const WORKER_URL = "https://stockmonitor.wendizeng11.workers.dev";

// 直接从 GitHub 仓库读, 跳过 Pages 重新部署 - 数据更新更快 (省 2-4 分钟)
const STATE_URL = "https://raw.githubusercontent.com/didiflute/stockmonitor/main/state.json";
const CONFIG_URL = "https://raw.githubusercontent.com/didiflute/stockmonitor/main/config.yaml";
const STALE_MINUTES = 15;
const AUTO_REFRESH_SECONDS = 60;
const USER_NAMES = { wz: "Wendi", fp: "老公" };

let state = null;
let config = null;
let currentUserId = localStorage.getItem("tqqq_user_id") || "";
let dashboardPassword = localStorage.getItem("tqqq_password") || "";
let currentSignalForAck = null;

// ---------------- 工具 ----------------

function fmtUsd(n, frac = 2) {
  if (n === null || n === undefined || isNaN(n)) return "$--";
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: frac, maximumFractionDigits: frac });
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
function showToast(text, durationMs = 2200) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.remove("hide");
  setTimeout(() => t.classList.add("hide"), durationMs);
}
function closeModal(id) {
  document.getElementById(id).classList.add("hide");
}
function showConfirm(title, message, onYes) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-message").textContent = message;
  const btn = document.getElementById("confirm-yes-btn");
  btn.onclick = () => {
    closeModal("modal-confirm");
    onYes();
  };
  document.getElementById("modal-confirm").classList.remove("hide");
}
function getMe() {
  return state?.users?.[currentUserId] || {
    holding_shares: 0, avg_cost: 0, cash_flow: 0, realized_profit: 0,
    acks: [], skips: [],
  };
}
function signalId(date, signal_type, action) {
  return `${date}_${signal_type}_${action}`;
}

// ---------------- Worker API ----------------

async function callWorker(endpoint, body = {}) {
  if (!dashboardPassword || !currentUserId) {
    promptLogin();
    throw new Error("需要登录");
  }
  const r = await fetch(`${WORKER_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": dashboardPassword,
      "X-User-Id": currentUserId,
    },
    body: JSON.stringify(body),
  });
  if (r.status === 401) {
    localStorage.removeItem("tqqq_password");
    dashboardPassword = "";
    promptLogin();
    throw new Error("密码错误");
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "unknown" }));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return await r.json();
}

// ---------------- 登录 ----------------

let pickedUser = currentUserId || "";
function pickUser(uid) {
  pickedUser = uid;
  document.getElementById("pick-wz").classList.toggle("selected", uid === "wz");
  document.getElementById("pick-fp").classList.toggle("selected", uid === "fp");
}

function promptLogin() {
  pickedUser = currentUserId || "";
  if (currentUserId) pickUser(currentUserId);
  document.getElementById("modal-login").classList.remove("hide");
  setTimeout(() => document.getElementById("login-password-input").focus(), 100);
}

async function submitLogin() {
  if (!pickedUser) {
    showToast("请先选择身份");
    return;
  }
  const pwd = document.getElementById("login-password-input").value;
  if (!pwd) {
    showToast("请输入密码");
    return;
  }
  // 用 /api/auth 验证
  try {
    const r = await fetch(`${WORKER_URL}/api/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": pwd,
        "X-User-Id": pickedUser,
      },
      body: "{}",
    });
    if (r.status === 401) {
      showToast("密码错误");
      return;
    }
    if (!r.ok) {
      showToast("Worker 连接失败 - 检查 WORKER_URL");
      return;
    }
    currentUserId = pickedUser;
    dashboardPassword = pwd;
    localStorage.setItem("tqqq_user_id", currentUserId);
    localStorage.setItem("tqqq_password", pwd);
    closeModal("modal-login");
    showToast(`已登录为 ${USER_NAMES[currentUserId]}`);
    updateUserAvatar();
    reloadAll();
  } catch (e) {
    showToast("无法连接: " + e.message);
  }
}

function updateUserAvatar() {
  const btn = document.getElementById("user-avatar");
  if (currentUserId) {
    btn.textContent = currentUserId.toUpperCase();
    btn.classList.toggle("fp", currentUserId === "fp");
  } else {
    btn.textContent = "?";
  }
}

function toggleUserMenu() {
  showConfirm(
    `当前: ${USER_NAMES[currentUserId] || "未登录"}`,
    "切换到另一个用户 / 退出登录?",
    () => {
      localStorage.removeItem("tqqq_user_id");
      localStorage.removeItem("tqqq_password");
      currentUserId = "";
      dashboardPassword = "";
      promptLogin();
    }
  );
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !document.getElementById("modal-login").classList.contains("hide")) {
    submitLogin();
  }
});

// ---------------- 数据加载 ----------------

async function fetchState() {
  try {
    const r = await fetch(STATE_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    state = await r.json();
  } catch (e) {
    document.getElementById("page-sub").textContent = "无法读 state.json";
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
        pushover: { enabled: true, recipients: [] },
        email: { enabled: true, to: [] },
      },
    };
  }
  return config;
}

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
      top.parent[top.key].push(parseScalar(val));
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
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "[]") return [];
  return s.replace(/^["']|["']$/g, "");
}

// ---------------- 渲染: 今日 ----------------

function renderToday() {
  if (!state || !config || !currentUserId) return;
  const me = getMe();
  const q = state.last_quote || {};
  const sigType = config.signal.type;
  document.getElementById("signal-type-pill").textContent =
    { daily: "每日", weekly: "每周", monthly: "每月" }[sigType] + " 信号";

  const shares = me.holding_shares || 0;
  const price = q.price || 0;
  const value = shares * price;
  const cost = me.avg_cost || 0;
  const pnl = value - shares * cost;
  document.getElementById("h-shares").textContent = shares.toFixed(0) + " 股";
  document.getElementById("h-value").textContent = fmtUsd(value, 0);
  const pnlEl = document.getElementById("h-pnl");
  pnlEl.textContent = (pnl >= 0 ? "+" : "") + fmtUsd(pnl, 0);
  pnlEl.classList.toggle("up", pnl >= 0);
  pnlEl.classList.toggle("down", pnl < 0);

  document.getElementById("current-price").textContent = fmtUsd(price);
  const dayChangeEl = document.getElementById("day-change");
  if (q.change_rate !== undefined) {
    const sign = q.change_rate >= 0 ? "↑ " : "↓ ";
    dayChangeEl.textContent = sign + fmtPct(Math.abs(q.change_rate));
    dayChangeEl.classList.toggle("up", q.change_rate >= 0);
    dayChangeEl.classList.toggle("down", q.change_rate < 0);
  }

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

  // 信号警告卡: 当前用户是否未操作?
  const alertCard = document.getElementById("alert-card");
  if (q.action === "buy" || q.action === "sell") {
    const today = new Date().toISOString().slice(0, 10);
    const sid = signalId(today, sigType, q.action);
    const acked = (me.acks || []).find(a => a.signal_id === sid);
    const skipped = (me.skips || []).find(s => s.signal_id === sid);
    if (!acked && !skipped) {
      alertCard.classList.remove("hide");
      const actionLabel = q.action === "buy" ? "买入" : "卖出";
      document.getElementById("alert-action").textContent = "已触发" + actionLabel;
      document.getElementById("alert-meta").textContent =
        `${{ daily: "每日", weekly: "每周", monthly: "每月" }[sigType]}信号`;
      document.getElementById("alert-desc").textContent =
        `变化率 ${fmtPct(q.change_rate)} (阈值 ${fmtPct(q.action === "buy" ? config.signal.drop_threshold : config.signal.rise_threshold, 0)})`;
      const tradeAmount = q.action === "buy" ? config.trade.buy_amount_usd : config.trade.sell_amount_usd;
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
  if (!state || !currentUserId) return;
  const me = getMe();
  const q = state.last_quote || {};

  const shares = me.holding_shares || 0;
  const price = q.price || 0;
  const cost = me.avg_cost || 0;
  const realized = me.realized_profit || 0;
  const totalAssets = shares * cost;        // 总资产 = cost basis (你投入的本金)
  const currentValue = shares * price;       // 现有资产 = 市值
  const unrealized = currentValue - totalAssets;  // 浮动盈亏

  document.getElementById("m-shares").textContent = shares.toFixed(2) + " 股";
  document.getElementById("m-avgcost").textContent = fmtUsd(cost);
  document.getElementById("m-total").textContent = fmtUsd(totalAssets, 0);
  document.getElementById("m-current").textContent = fmtUsd(currentValue, 0);
  document.getElementById("m-unrealized").textContent = (unrealized >= 0 ? "+" : "") + fmtUsd(unrealized, 0);
  const unrealizedEl = document.getElementById("m-unrealized");
  unrealizedEl.classList.toggle("up", unrealized >= 0);
  unrealizedEl.classList.toggle("down", unrealized < 0);
  document.getElementById("m-realized").textContent = (realized >= 0 ? "+" : "") + fmtUsd(realized, 0);

  // 信号记录: 把所有 fired_signals 跟我的 acks/skips 合并显示
  const list = document.getElementById("signal-list");
  list.innerHTML = "";
  const fired = state.fired_signals || [];
  if (fired.length === 0) {
    list.innerHTML = '<div style="padding: 14px 0; text-align: center; color: #999; font-size: 13px;">还没有触发过信号</div>';
    return;
  }
  fired.slice().reverse().slice(0, 30).forEach(s => {
    const sid = signalId(s.date, s.signal_type, s.action);
    const myAck = (me.acks || []).find(a => a.signal_id === sid);
    const mySkip = (me.skips || []).find(sk => sk.signal_id === sid);

    const row = document.createElement("div");
    row.className = "list-item";

    const actionTag = s.action === "buy"
      ? `<span class="tag-buy">买</span>`
      : `<span class="tag-sell">卖</span>`;

    let detailText, statusEl, undoBtn = "";
    if (myAck) {
      detailText = `${myAck.executed_shares} 股 × ${fmtUsd(myAck.executed_price)}`;
      statusEl = `<span class="tag-ack">✓ 已成交</span>`;
      undoBtn = `<button class="undo-btn" onclick="undoAck('${s.date}','${s.signal_type}','${s.action}')">↺</button>`;
    } else if (mySkip) {
      detailText = `@ ${fmtUsd(s.price)}`;
      statusEl = `<span class="tag-skipped">已跳过</span>`;
      undoBtn = `<button class="undo-btn" onclick="undoSkip('${s.date}','${s.signal_type}','${s.action}')">↺</button>`;
    } else {
      detailText = `@ ${fmtUsd(s.price)}`;
      statusEl = `<span class="tag-pending">未操作</span>`;
    }

    row.innerHTML = `
      <span style="font-size: 12px;">${s.date}</span>
      ${actionTag}
      <span class="label-mute">${detailText}</span>
      ${statusEl}
      ${undoBtn}
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
    row.innerHTML = `<span class="name">${p.name}</span><span class="label-mute">${p.channels.join(" + ")}</span>`;
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
    row.innerHTML = `<div><div>${c.label}</div><div class="label-mute">${c.desc}</div></div><span class="label-mute">${c.enabled ? "开启" : "关闭"}</span>`;
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

// ---------------- 已下单 ----------------

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
  document.getElementById("ack-warning").classList.add("hide");
  document.getElementById("modal-ack").classList.remove("hide");
  validateAckForm();
}

function validateAckForm() {
  if (!currentSignalForAck) return;
  const sig = currentSignalForAck;
  const shares = parseFloat(document.getElementById("ack-shares").value);
  const warningEl = document.getElementById("ack-warning");
  const btn = document.getElementById("ack-confirm-btn");

  if (sig.action === "sell") {
    const me = getMe();
    if (shares > (me.holding_shares || 0)) {
      warningEl.textContent = `⚠ 你只有 ${me.holding_shares} 股, 不能卖 ${shares} 股`;
      warningEl.classList.remove("hide");
      btn.disabled = true;
      return;
    }
  }
  warningEl.classList.add("hide");
  btn.disabled = false;
}

async function confirmAck() {
  const sig = currentSignalForAck;
  if (!sig) return;
  const shares = parseFloat(document.getElementById("ack-shares").value);
  const price = parseFloat(document.getElementById("ack-price").value);
  if (!shares || !price || shares <= 0 || price <= 0) {
    showToast("请填写有效数字");
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
    closeModal("modal-ack");
    showToast("已成交, 持仓已更新");
    setTimeout(reloadAll, 1200);
  } catch (e) {
    showToast("失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✓ 确认成交";
  }
}

async function skipSignal() {
  if (!currentSignalForAck) return;
  const sig = currentSignalForAck;
  showConfirm(
    "跳过本次信号?",
    "今天不再提醒你这条信号. 之后如果想反悔, 在历史 Tab 点 ↺ 撤销.",
    async () => {
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
  );
}

// ---------------- 撤销 ----------------

async function undoAck(date, signal_type, action) {
  showConfirm(
    "撤销这次成交?",
    `这会把持仓恢复到下单前的状态. 确认撤销?`,
    async () => {
      try {
        await callWorker("/api/undo-ack", { date, signal_type, action });
        showToast("已撤销");
        setTimeout(reloadAll, 1000);
      } catch (e) {
        showToast("失败: " + e.message);
      }
    }
  );
}

async function undoSkip(date, signal_type, action) {
  showConfirm(
    "撤销跳过?",
    "这条信号会重新出现在今日 Tab.",
    async () => {
      try {
        await callWorker("/api/undo-skip", { date, signal_type, action });
        showToast("已撤销");
        setTimeout(reloadAll, 1000);
      } catch (e) {
        showToast("失败: " + e.message);
      }
    }
  );
}

// ---------------- 编辑持仓 ----------------

function openHoldingsEditor() {
  const me = getMe();
  document.getElementById("hd-shares").value = me.holding_shares || 0;
  document.getElementById("hd-cost").value = me.avg_cost || 0;
  document.getElementById("hd-realized").value = me.realized_profit || 0;
  document.getElementById("modal-holdings").classList.remove("hide");
}

async function confirmHoldings() {
  const shares = parseFloat(document.getElementById("hd-shares").value);
  const cost = parseFloat(document.getElementById("hd-cost").value);
  const payload = {
    holding_shares: shares,
    avg_cost: cost,
    // cash_flow 用本金值 (= shares × cost), 让 worker 内部记账起点正确
    cash_flow: shares * cost,
    realized_profit: parseFloat(document.getElementById("hd-realized").value),
  };
  const btn = document.getElementById("holdings-confirm-btn");
  btn.disabled = true;
  btn.textContent = "保存中...";
  try {
    await callWorker("/api/set-holdings", payload);
    closeModal("modal-holdings");
    showToast("持仓已更新");
    setTimeout(reloadAll, 1200);
  } catch (e) {
    showToast("失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

// ---------------- 设置写入 ----------------

async function updateSignalType(t) {
  if (!config) return;
  config.signal.type = t;
  renderSettings();
  try {
    await callWorker("/api/config", { signal_type: t });
    showToast(`信号类型改为 ${{ daily: "每日", weekly: "每周", monthly: "每月" }[t]}`);
    setTimeout(reloadAll, 1500);
  } catch (e) {
    showToast("失败: " + e.message);
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
  showToast("已触发后端, 整个链路约 2-5 分钟...", 5000);
  try {
    await callWorker("/api/refresh", {});
    const oldTime = state?.last_run_at;
    let tries = 0;
    const MAX_TRIES = 60;       // 60 × 10s = 10 分钟超时
    const INTERVAL = 10000;     // 每 10 秒查一次
    const poll = setInterval(async () => {
      tries++;
      await fetchState();
      if (state?.last_run_at !== oldTime) {
        clearInterval(poll);
        btn.classList.remove("spin");
        renderToday();
        showToast("数据已更新 ✓");
      } else if (tries >= MAX_TRIES) {
        clearInterval(poll);
        btn.classList.remove("spin");
        showToast("超过 10 分钟没等到更新, 可能后端排队了。下次自动刷新会带上新数据", 4000);
      } else if (tries % 6 === 0) {
        // 每 1 分钟更新一次进度提示
        const minutes = Math.floor((tries * INTERVAL) / 60000);
        showToast(`等待中... (已等 ${minutes} 分钟, 链路最长 5 分钟左右)`, 3000);
      }
    }, INTERVAL);
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
  // 注册 Service Worker (Network First 策略, 防止 iOS PWA 顽固缓存)
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      // 检查是否有新版本可用
      reg.update();
    } catch (e) {
      console.warn("SW register failed:", e);
    }
  }

  updateUserAvatar();
  if (!currentUserId || !dashboardPassword) {
    promptLogin();
    return;
  }
  await Promise.all([fetchState(), fetchConfig()]);
  renderToday();
  setInterval(async () => {
    await fetchState();
    const activeTab = document.querySelector(".tab-item.active")?.dataset.tab || "today";
    if (activeTab === "today") renderToday();
    else if (activeTab === "history") renderHistory();
  }, AUTO_REFRESH_SECONDS * 1000);

  // PWA 重新获得焦点时立即刷新 (iOS 后台会暂停 setInterval)
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden && currentUserId && dashboardPassword) {
      await fetchState();
      const activeTab = document.querySelector(".tab-item.active")?.dataset.tab || "today";
      switchTab(activeTab);
    }
  });
}
init();
