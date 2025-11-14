// api/_lib/state.js
import { kv } from "./kv.js";

export const STATE_KEY = "guardian:state:v1";

const DEFAULT_STATE = {
  capital: 0,
  realised: 0,
  unrealised: 0,
  total_pnl: 0,
  max_loss_pct: 10,
  trail_step_profit: 0,
  cooldown_minutes: 0,
  tradebook: [],
  last_updated_ms: 0
};

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mergeDefaults(raw) {
  if (!raw || typeof raw !== "object") raw = {};
  const s = { ...DEFAULT_STATE, ...raw };
  s.capital = safeNum(s.capital, DEFAULT_STATE.capital);
  s.realised = safeNum(s.realised, DEFAULT_STATE.realised);
  s.unrealised = safeNum(s.unrealised, DEFAULT_STATE.unrealised);
  s.total_pnl = safeNum(s.total_pnl, DEFAULT_STATE.total_pnl);
  s.max_loss_pct = safeNum(s.max_loss_pct, DEFAULT_STATE.max_loss_pct);
  s.trail_step_profit = safeNum(s.trail_step_profit, DEFAULT_STATE.trail_step_profit);
  s.cooldown_minutes = safeNum(s.cooldown_minutes, DEFAULT_STATE.cooldown_minutes);
  s.tradebook = Array.isArray(s.tradebook) ? s.tradebook : DEFAULT_STATE.tradebook.slice();
  s.last_updated_ms = safeNum(s.last_updated_ms, Date.now());
  return s;
}

export async function getState() {
  try {
    const raw = await kv.get(STATE_KEY);
    let parsed = raw;
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
    }
    return mergeDefaults(parsed);
  } catch (e) {
    return mergeDefaults(null);
  }
}

export async function setState(patch = {}) {
  const current = await getState();
  const merged = { ...current, ...patch, last_updated_ms: Date.now() };
  const normalized = mergeDefaults(merged);
  await kv.set(STATE_KEY, JSON.stringify(normalized));
  return normalized;
}
