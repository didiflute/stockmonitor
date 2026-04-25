// TQQQ 网格信号 PWA Dashboard
// state.json 和 config.yaml 由 deploy_pages.yml 复制到同目录, 直接读相对路径
const STATE_URL = "./state.json";
const CONFIG_URL = "./config.yaml";
const HISTORY_URL = "./state.json";

const STALE_MINUTES = 15; // 超过此时长的数据标记为过期

let state = null;
let config = null;

// ---------------- 数据获取 ----------------
async function fetchState() {
  try {
    const resp = await fetch(STATE_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    state = await resp.json();
  } catch (e) {
    document.getElementById("page-sub").textContent = "无法连接到后端: " + e.message;
    return null;
  }
  return state;
}

async function fetchConfig() {
  try {
    const resp = await fetch(CONFIG_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const text = await resp.text();
    config = parseSimpleYaml(text);
  } catch (e) {
    config = {
      signal: { type: "weekly", drop_threshold: -0.07, rise_threshold: 0.08 },
      trade: { buy_amount_usd: 500, sell_amount_usd: 500 },
      notifications: {
        email: { enabled: true, to: ["wendizeng11@gmail.com"] },
        wechat: { enabled: true, recipients: ["wendi"] },
        sms: { enabled: false, to: [] },
      },
    };
  }
  return config;
}

// 极简 YAML 解析 (仅满足我们这个 config.yaml 结构, 不通用)
function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ obj: root, indent: -1 }];
  const lines = text.split("\n");
  let pendingKey = null;
  let pendingArr = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = rawLine.match(/^ */)[0].length;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    if (line.trim().startsWith("- ")) {
      const val = line.trim().slice(2).trim();
      if (Array.isArray(parent)) parent.push(parseScalar(val));
      continue;
    }

    const m = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, , key, valRaw] = m;
    if (valRaw === "" || valRaw === undefined) {
      // either object or list follows
      const child = {};
      parent[key] = child;
      stack.push({ obj: child, indent });
      // peek next non-empty line — if starts with "-" at deeper indent => array
      // 简化: 探测下一行是否为 "- "
    } else {
      parent[key] = parseScalar(valRaw);
    }
  }
  // 修复: 如果某个 key 的下一层是 list of "- xxx", 把空对象转成数组
  return convertListChildren(root);
}

function parseScalar(s) {
  s = s.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "[]") return [];
  return s;
}

function convertListChildren(obj) {
  if (Array.isArray(obj)) return obj;
  if (typeof obj !== "object" || obj === null) return obj;
  for (const key of Object.keys(obj)) {
    obj[key] = convertListChildren(obj[key]);
  }
  return obj;
}

// ---------------- 渲染: 今日 ----------------
function fmtUsd(n, frac = 2) {
  if (n === null || n === undefined || isNaN(n)) return "$--";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
}
function fmtPct(n, frac = 2) {
  if (n === null || n === undefined || isNaN(n)) return "--";
  return (n * 100).toFixed(frac) + "%";
}

function renderToday() {
  if (!state || !config) return;
  const q = state.last_quote || {};
  const sigType = config.signal.type;
  document.getElementById("signal-type-pill").textContent =
    { daily: "每日信号", weekly: "每周信号", monthly: "每月信号" }[sigType] || sigType;

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

  // 触发预测
  document.getElementById("buy-trigger").textContent = fmtUsd(q.buy_trigger_price);
  document.getElementById("sell-trigger").textContent = fmtUsd(q.sell_trigger_price);
  if (q.buy_trigger_price && price) {
    const dist = (q.buy_trigger_price / price - 1) * 100;
    document.getElementById("buy-distance").textContent = `还需跌 ${(-dist).toFixed(1)}%`;
  }
  if (q.sell_trigger_price && price) {
    const dist = (q.sell_trigger_price / price - 1) * 100;
    document.getElementById("sell-distance").textContent = `还需涨 ${dist.toFixed(1)}%`;
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
    if (fired && !fired.user_acknowledged) {
      alertCard.classList.remove("hide");
      const actionLabel = q.action === "buy" ? "买入" : "卖出";
      document.getElementById("alert-action").textContent = "已触发" + actionLabel;
      document.getElementById("alert-meta").textContent =
        `${{ daily: "每日", weekly: "每周", monthly: "每月" }[sigType]}信号`;
      document.getElementById("alert-desc").textContent =
        `变化率 ${fmtPct(q.change_rate)} (阈值 ${fmtPct(q.action === "buy" ? config.signal.drop_threshold : config.signal.rise_threshold, 0)})`;
    } else {
      alertCard.classList.add("hide");
    }
  } else {
    alertCard.classList.add("hide");
  }

  // 更新时间 + 过期提示
  if (state.last_run_at) {
    const ts = new Date(state.last_run_at);
    const minutes = Math.floor((Date.now() - ts.getTime()) / 60000);
    document.getElementById("updated-at").textContent =
      `更新于 ${ts.toLocaleString("zh-CN")} (${minutes} 分钟前)`;
    const stale = document.getElementById("stale-banner");
    if (minutes > STALE_MINUTES) {
      stale.textContent = `⚠ 数据已 ${minutes} 分钟未更新, 后端可能没在跑`;
      stale.classList.remove("hide");
    } else {
      stale.classList.add("hide");
    }
    document.getElementById("page-sub").textContent =
      new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  }
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
  if (!state || !config) return;
  const q = state.last_quote || {};

  const shares = state.holding_shares || 0;
  const price = q.price || 0;
  const cost = state.avg_cost || 0;
  const cashflow = state.cash_flow || 0;
  const currentValue = shares * price;
  const totalAssets = currentValue + (cashflow > 0 ? 0 : 0); // 简化: 由后端维护

  document.getElementById("m-current").textContent = fmtUsd(currentValue, 0);
  document.getElementById("m-avgcost").textContent = fmtUsd(cost);
  document.getElementById("m-price").textContent = fmtUsd(price);
  document.getElementById("m-cashflow").textContent = fmtUsd(cashflow, 0);
  document.getElementById("m-total").textContent = fmtUsd(totalAssets, 0);
  // XIRR 由后端算 (持仓变化 + 现金流时间序列), 此处显示 state.xirr 字段
  if (state.xirr !== undefined && state.xirr !== null) {
    document.getElementById("m-xirr").textContent = fmtPct(state.xirr, 1);
  }

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
    const ack = s.user_acknowledged ? '<span class="label-mute">✓ 已下单</span>' : "";
    row.innerHTML = `
      <span>${s.date}</span>
      <span class="${s.action === 'buy' ? 'tag-buy' : 'tag-sell'}">${s.action === 'buy' ? '买' : '卖'}</span>
      <span class="label-mute">${fmtUsd(s.price)}</span>
      ${ack}
    `;
    list.appendChild(row);
  });
}

// ---------------- 渲染: 通知 ----------------
function renderNotify() {
  if (!config) return;
  const recList = document.getElementById("recipients-list");
  recList.innerHTML = "";

  const allRecipients = new Set();
  (config.notifications.email?.to || []).forEach(e => allRecipients.add("email:" + e));
  (config.notifications.wechat?.recipients || []).forEach(r => allRecipients.add("wechat:" + r));

  const grouped = {};
  Array.from(allRecipients).forEach(s => {
    const [chan, val] = s.split(":");
    const key = chan === "email" ? val.split("@")[0] : val;
    if (!grouped[key]) grouped[key] = { name: key, channels: [] };
    grouped[key].channels.push(chan);
  });

  Object.values(grouped).forEach(p => {
    const row = document.createElement("div");
    row.className = "opt";
    row.style.justifyContent = "space-between";
    row.innerHTML = `
      <span class="name">${p.name}</span>
      <span class="label-mute">${p.channels.length} 渠道</span>
    `;
    recList.appendChild(row);
  });

  const chList = document.getElementById("channels-list");
  chList.innerHTML = "";
  const channels = [
    { key: "email", label: "邮件 (Gmail)", desc: "最可靠", enabled: config.notifications.email?.enabled },
    { key: "wechat", label: "微信 (Server酱)", desc: "实时推送", enabled: config.notifications.wechat?.enabled },
    { key: "sms", label: "短信 (Twilio)", desc: "未启用", enabled: config.notifications.sms?.enabled },
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

// ---------------- 占位的交互 ----------------
function acknowledge() {
  alert("已记录 — 下次刷新会同步到 GitHub。(v1 是只读，实际状态以后端为准)");
}
function skipSignal() {
  alert("已跳过本次。(v1 是只读，后端按已通知规则继续工作)");
}
function updateSignalType(t) {
  if (!config) return;
  config.signal.type = t;
  renderSettings();
  alert("提示：在 Dashboard 改的设置只是预览。真正生效需要在 GitHub 编辑 config.yaml。");
}

// ---------------- 初始化 ----------------
async function init() {
  await Promise.all([fetchState(), fetchConfig()]);
  renderToday();
  // 每 60 秒刷新一次 (state.json 是后端写的, 我们只读)
  setInterval(async () => {
    await fetchState();
    const activeTab = document.querySelector(".tab-item.active").dataset.tab;
    switchTab(activeTab);
  }, 60000);
}
init();
