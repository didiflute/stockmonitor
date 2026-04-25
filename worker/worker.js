// TQQQ Dashboard Backend (Cloudflare Worker)
//
// 处理 dashboard 的写操作: 标记信号已下单/跳过、改配置、触发刷新.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
  "Access-Control-Max-Age": "86400",
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

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

function applyTradeToState(state, action, shares, price) {
  const next = JSON.parse(JSON.stringify(state));
  const oldShares = next.holding_shares || 0;
  const oldCost = next.avg_cost || 0;
  const oldCashFlow = next.cash_flow || 0;
  const oldRealized = next.realized_profit || 0;

  if (action === "buy") {
    const oldTotalCost = oldShares * oldCost;
    const newTotalCost = oldTotalCost + shares * price;
    next.holding_shares = oldShares + shares;
    next.avg_cost = next.holding_shares > 0 ? newTotalCost / next.holding_shares : 0;
    next.cash_flow = oldCashFlow + shares * price;
  } else if (action === "sell") {
    next.holding_shares = oldShares - shares;
    next.cash_flow = oldCashFlow - shares * price;
    next.realized_profit = oldRealized + (price - oldCost) * shares;
  }
  return next;
}

function patchConfigYaml(yamlText, updates) {
  let out = yamlText;
  if (updates.signal_type !== undefined) {
    out = out.replace(
      /(\n\s*type:\s*)(daily|weekly|monthly)(\s*(?:#.*)?\n)/,
      `$1${updates.signal_type}$3`
    );
  }
  if (updates.drop_threshold !== undefined) {
    out = out.replace(
      /(\n\s*drop_threshold:\s*)(-?\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.drop_threshold}$3`
    );
  }
  if (updates.rise_threshold !== undefined) {
    out = out.replace(
      /(\n\s*rise_threshold:\s*)(-?\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.rise_threshold}$3`
    );
  }
  if (updates.buy_amount_usd !== undefined) {
    out = out.replace(
      /(\n\s*buy_amount_usd:\s*)(\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.buy_amount_usd}$3`
    );
  }
  if (updates.sell_amount_usd !== undefined) {
    out = out.replace(
      /(\n\s*sell_amount_usd:\s*)(\d+(?:\.\d+)?)(\s*(?:#.*)?\n)/,
      `$1${updates.sell_amount_usd}$3`
    );
  }
  return out;
}

async function handleAck(body, env) {
  const { date, signal_type, action, shares, price } = body;
  if (!date || !signal_type || !action || shares === undefined || price === undefined) {
    return jsonResp({ error: "missing fields" }, 400);
  }
  if (action !== "buy" && action !== "sell") {
    return jsonResp({ error: "action must be buy or sell" }, 400);
  }
  const { sha, content } = await ghGetFile(env, "state.json");
  const state = JSON.parse(content);
  const sig = (state.fired_signals || []).find(
    (s) => s.date === date && s.signal_type === signal_type && s.action === action
  );
  if (sig) {
    sig.user_acknowledged = true;
    sig.user_skipped = false;
    sig.executed_shares = Number(shares);
    sig.executed_price = Number(price);
    sig.executed_at = new Date().toISOString();
  }
  const updated = applyTradeToState(state, action, Number(shares), Number(price));
  updated.fired_signals = state.fired_signals;
  const newJson = JSON.stringify(updated, null, 2);
  await ghPutFile(env, "state.json", newJson, sha, `chore: ack ${signal_type} ${action} ${shares}@${price}`);
  return jsonResp({ ok: true, state: updated });
}

async function handleSkip(body, env) {
  const { date, signal_type, action } = body;
  if (!date || !signal_type || !action) {
    return jsonResp({ error: "missing fields" }, 400);
  }
  const { sha, content } = await ghGetFile(env, "state.json");
  const state = JSON.parse(content);
  const sig = (state.fired_signals || []).find(
    (s) => s.date === date && s.signal_type === signal_type && s.action === action
  );
  if (sig) {
    sig.user_skipped = true;
    sig.skipped_at = new Date().toISOString();
  }
  await ghPutFile(env, "state.json", JSON.stringify(state, null, 2), sha, `chore: skip ${signal_type} ${action}`);
  return jsonResp({ ok: true, state });
}

async function handleConfig(body, env) {
  const { sha, content } = await ghGetFile(env, "config.yaml");
  const newYaml = patchConfigYaml(content, body);
  if (newYaml === content) return jsonResp({ ok: true, changed: false });
  await ghPutFile(env, "config.yaml", newYaml, sha, `chore: update config`);
  return jsonResp({ ok: true, changed: true });
}

async function handleRefresh(env) {
  await ghTriggerWorkflow(env);
  return jsonResp({ ok: true, message: "workflow triggered" });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const auth = request.headers.get("X-Auth-Token");
    if (auth !== env.DASHBOARD_PASSWORD) {
      return jsonResp({ error: "unauthorized" }, 401);
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
          return await handleAck(body, env);
        case "/api/skip":
          return await handleSkip(body, env);
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
