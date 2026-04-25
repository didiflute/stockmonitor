// TQQQ Dashboard Backend (Cloudflare Worker) - v3
//
// 多用户支持 (WZ 和 FP), 数据独立存储在 state.json 的 users.{user_id} 下.
// 共享部分: last_quote, fired_signals (信号客观事件)
// 个人部分: holding_shares, avg_cost, cash_flow, realized_profit, acks[], skips[]
//
// 鉴权: 请求头 X-User-Id (wz/fp) + X-Auth-Token (DASHBOARD_PASSWORD)
//
// Secrets:
//   - GITHUB_TOKEN: PAT
//   - GITHUB_REPO: "didiflute/stockmonitor"
//   - DASHBOARD_PASSWORD: 共用密码

const ALLOWED_USERS = new Set(["wz", "fp"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token, X-User-Id",
  "Access-Control-Max-Age": "86400",
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---------- GitHub API ----------

async function ghGetFile(env, path) {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=main`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tqqq-dashboard-worker",
      },
    }
  );
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status}`);
  const data = await r.json();
  const content = atob(data.content.replace(/\s/g, ""));
  return { sha: data.sha, content };
}

async function ghPutFile(env, path, newContent, sha, message) {
  const b64 = btoa(unescape(encodeURIComponent(newContent)));
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tqqq-dashboard-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, content: b64, sha, branch: "main" }),
    }
  );
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`GitHub PUT ${path} failed: ${r.status} ${err}`);
  }
  return await r.json();
}

async function ghTriggerWorkflow(env) {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/check_signal.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tqqq-dashboard-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`workflow_dispatch failed: ${r.status} ${err}`);
  }
  return true;
}

// ---------- State 操作辅助 ----------

function ensureUser(state, userId) {
  if (!state.users) state.users = {};
  if (!state.users[userId]) {
    state.users[userId] = {
      holding_shares: 0,
      avg_cost: 0,
      cash_flow: 0,
      realized_profit: 0,
      acks: [],
      skips: [],
    };
  }
  return state.users[userId];
}

function signalId(date, signal_type, action) {
  return `${date}_${signal_type}_${action}`;
}

// 应用一笔交易, 返回 { delta } 用于撤销
function applyTrade(user, action, shares, price) {
  const oldShares = user.holding_shares || 0;
  const oldCost = user.avg_cost || 0;
  const oldCashFlow = user.cash_flow || 0;
  const oldRealized = user.realized_profit || 0;

  let delta;
  if (action === "buy") {
    const oldTotalCost = oldShares * oldCost;
    const newTotalCost = oldTotalCost + shares * price;
    user.holding_shares = oldShares + shares;
    user.avg_cost = user.holding_shares > 0 ? newTotalCost / user.holding_shares : 0;
    user.cash_flow = oldCashFlow + shares * price;
    delta = {
      delta_shares: shares,
      delta_total_cost: shares * price,
      delta_cash_flow: shares * price,
      delta_realized: 0,
    };
  } else {
    user.holding_shares = oldShares - shares;
    user.cash_flow = oldCashFlow - shares * price;
    user.realized_profit = oldRealized + (price - oldCost) * shares;
    delta = {
      delta_shares: -shares,
      delta_total_cost: -(shares * oldCost),
      delta_cash_flow: -(shares * price),
      delta_realized: (price - oldCost) * shares,
    };
  }
  return delta;
}

// 反向 delta - 用于撤销 ack
function reverseDelta(user, delta) {
  const currentShares = user.holding_shares || 0;
  const currentCost = user.avg_cost || 0;
  const currentTotalCost = currentShares * currentCost;

  const newShares = currentShares - delta.delta_shares;
  const newTotalCost = currentTotalCost - delta.delta_total_cost;

  user.holding_shares = newShares;
  user.avg_cost = newShares > 0 ? newTotalCost / newShares : 0;
  user.cash_flow = (user.cash_flow || 0) - delta.delta_cash_flow;
  user.realized_profit = (user.realized_profit || 0) - delta.delta_realized;
}

// ---------- 路由处理 ----------

async function handleAck(body, userId, env) {
  const { date, signal_type, action, shares, price } = body;
  if (!date || !signal_type || !action || shares === undefined || price === undefined) {
    return jsonResp({ error: "missing fields" }, 400);
  }
  if (action !== "buy" && action !== "sell") {
    return jsonResp({ error: "action must be buy or sell" }, 400);
  }

  const { sha, content } = await ghGetFile(env, "state.json");
  const state = JSON.parse(content);
  const user = ensureUser(state, userId);

  // 卖出验证: 不能卖超过持仓
  if (action === "sell" && Number(shares) > (user.holding_shares || 0)) {
    return jsonResp({
      error: `卖出股数超过持仓 (你只有 ${user.holding_shares} 股)`,
    }, 400);
  }

  const sigId = signalId(date, signal_type, action);

  // 幂等: 已经 ack 过就直接返回, 不重复扣股
  const existing = user.acks.find((a) => a.signal_id === sigId);
  if (existing) {
    return jsonResp({ ok: true, message: "already acknowledged", state });
  }

  // 移除 skip 标记 (如果之前跳过了, 现在改主意要 ack)
  user.skips = user.skips.filter((s) => s.signal_id !== sigId);

  // 应用交易
  const delta = applyTrade(user, action, Number(shares), Number(price));

  // 记录 ack
  user.acks.push({
    signal_id: sigId,
    date,
    signal_type,
    action,
    executed_shares: Number(shares),
    executed_price: Number(price),
    acknowledged_at: new Date().toISOString(),
    delta,
  });

  await ghPutFile(env, "state.json", JSON.stringify(state, null, 2), sha,
    `chore: ${userId} ack ${signal_type} ${action} ${shares}@${price}`);
  return jsonResp({ ok: true, state });
}

async function handleUndoAck(body, userId, env) {
  const { date, signal_type, action } = body;
  if (!date || !signal_type || !action) {
    return jsonResp({ error: "missing fields" }, 400);
  }
  const { sha, content } = await ghGetFile(env, "state.json");
  const state = JSON.parse(content);
  const user = ensureUser(state, userId);

  const sigId = signalId(date, signal_type, action);
  const idx = user.acks.findIndex((a) => a.signal_id === sigId);
  if (idx === -1) {
    return jsonResp({ error: "找不到这条 ack 记录" }, 404);
  }
  const ack = user.acks[idx];

  // 反向 delta
  if (ack.delta) reverseDelta(user, ack.delta);

  // 移除 ack 记录
  user.acks.splice(idx, 1);

  await ghPutFile(env, "state.json", JSON.stringify(state, null, 2), sha,
    `chore: ${userId} undo ack ${signal_type} ${action}`);
  return jsonResp({ ok: true, state });
}

async function handleSkip(body, userId, env) {
  const { date, signal_type, action } = body;
  if (!date || !signal_type || !action) {
    return jsonResp({ error: "missing fields" }, 400);
  }
  const { sha, content } = await ghGetFile(env, "state.json");
  const state = JSON.parse(content);
  const user = ensureUser(state, userId);

  const sigId = signalId(date, signal_type, action);
  // 幂等: 已经 skip 过就直接返回
  if (user.skips.find((s) => s.signal_id === sigId)) {
    return jsonResp({ ok: true, message: "already skipped" });
  }
  user.skips.push({
    signal_id: sigId,
    date,
    signal_type,
    action,
    skipped_at: new Date().toISOString(),
  });

  await ghPutFile(env, "state.json", JSON.stringify(state, null, 2), sha,
    `chore: ${userId} skip ${signal_type} ${action}`);
  return jsonResp({ ok: true, state });
}

async function handleUndoSkip(body, userId, env) {
  const { date, signal_type, action } = body;
  if (!date || !signal_type || !action) {
    return jsonResp({ error: "missing fields" }, 400);
  }
  const { sha, content } = await ghGetFile(env, "state.json");
  const state = JSON.parse(content);
  const user = ensureUser(state, userId);

  const sigId = signalId(date, signal_type, action);
  user.skips = user.skips.filter((s) => s.signal_id !== sigId);

  await ghPutFile(env, "state.json", JSON.stringify(state, null, 2), sha,
    `chore: ${userId} undo skip ${signal_type} ${action}`);
  return jsonResp({ ok: true, state });
}

async function handleSetHoldings(body, userId, env) {
  const { holding_shares, avg_cost, cash_flow, realized_profit } = body;
  const { sha, content } = await ghGetFile(env, "state.json");
  const state = JSON.parse(content);
  const user = ensureUser(state, userId);

  if (holding_shares !== undefined) user.holding_shares = Number(holding_shares);
  if (avg_cost !== undefined) user.avg_cost = Number(avg_cost);
  if (cash_flow !== undefined) user.cash_flow = Number(cash_flow);
  if (realized_profit !== undefined) user.realized_profit = Number(realized_profit);

  await ghPutFile(env, "state.json", JSON.stringify(state, null, 2), sha,
    `chore: ${userId} set holdings`);
  return jsonResp({ ok: true, state });
}

async function handleConfig(body, env) {
  const { sha, content } = await ghGetFile(env, "config.yaml");
  const newYaml = patchConfigYaml(content, body);
  if (newYaml === content) return jsonResp({ ok: true, changed: false });
  await ghPutFile(env, "config.yaml", newYaml, sha, "chore: update config");
  return jsonResp({ ok: true, changed: true });
}

async function handleRefresh(env) {
  await ghTriggerWorkflow(env);
  return jsonResp({ ok: true, message: "workflow triggered" });
}

// ---------- config.yaml regex patch ----------

function patchConfigYaml(yamlText, updates) {
  let out = yamlText;
  if (updates.signal_type !== undefined) {
    out = out.replace(/(\n\s*type:\s*)(daily|weekly|monthly)(\s*(?:#.*)?\n)/,
      `$1${updates.signal_type}$3`);
  }
  if (updates.drop_threshold !== undefined) {
    out = out.replace(/(\n\s*drop_threshold:\s*)(-?\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.drop_threshold}$3`);
  }
  if (updates.rise_threshold !== undefined) {
    out = out.replace(/(\n\s*rise_threshold:\s*)(-?\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.rise_threshold}$3`);
  }
  if (updates.buy_amount_usd !== undefined) {
    out = out.replace(/(\n\s*buy_amount_usd:\s*)(\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.buy_amount_usd}$3`);
  }
  if (updates.sell_amount_usd !== undefined) {
    out = out.replace(/(\n\s*sell_amount_usd:\s*)(\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.sell_amount_usd}$3`);
  }
  return out;
}

// ---------- 主入口 ----------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 鉴权: X-Auth-Token (密码) + X-User-Id (身份)
    const auth = request.headers.get("X-Auth-Token");
    const userId = (request.headers.get("X-User-Id") || "").toLowerCase();

    if (auth !== env.DASHBOARD_PASSWORD) {
      return jsonResp({ error: "unauthorized" }, 401);
    }

    // /api/refresh /api/config 是共享操作, 不需要 user
    const isShared = url.pathname === "/api/refresh"
                  || url.pathname === "/api/config"
                  || url.pathname === "/api/auth";

    if (!isShared && !ALLOWED_USERS.has(userId)) {
      return jsonResp({ error: "invalid user_id (must be wz or fp)" }, 400);
    }

    let body = {};
    try {
      if (request.method === "POST") body = await request.json();
    } catch {
      return jsonResp({ error: "invalid JSON" }, 400);
    }

    try {
      switch (url.pathname) {
        case "/api/auth":
          return jsonResp({ ok: true });
        case "/api/ack":
          return await handleAck(body, userId, env);
        case "/api/undo-ack":
          return await handleUndoAck(body, userId, env);
        case "/api/skip":
          return await handleSkip(body, userId, env);
        case "/api/undo-skip":
          return await handleUndoSkip(body, userId, env);
        case "/api/set-holdings":
          return await handleSetHoldings(body, userId, env);
        case "/api/config":
          return await handleConfig(body, env);
        case "/api/refresh":
          return await handleRefresh(env);
        default:
          return jsonResp({ error: "not found" }, 404);
      }
    } catch (e) {
      return jsonResp({ error: String(e.message || e) }, 500);
    }
  },
};

// 测试用导出
export { applyTrade, reverseDelta, signalId, ensureUser, patchConfigYaml };
