// api/hub.js
// Single gateway for all API routes: kite, admin, state/guardian.
// This file merges routing so you only need one serverless function under /api/*
// It still uses your low-level library files for KV, Kite client, state persistence and enforce routines.

import { instance as kiteInstance } from "./_lib/kite.js";
import { kv, todayKey } from "./_lib/kv.js";
import { getState as getPersistedState, setState as persistState, STATE_KEY } from "./_lib/state.js";
import { isAdminFromReq, requireAdmin } from "./_lib/auth.js";
import * as enforce from "./enforce.js"; // expecting exports like cancelPending, squareOffAll (best-effort)
import * as fs from "fs"; // not used, but kept if you need file ops server-side

/* small response helpers */
function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });
const nope = (res) => bad(res, "Method not allowed");
const unauth = (res) => requireAdmin(res);

function nowMs() { return Date.now(); }
function safeNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function formatIst(ms = Date.now()) {
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* Helpers that were commonly used in repo */
async function getLiveKiteInfoSafe() {
  // Best-effort: returns { kite_status, funds, positions, error }
  const out = { kite_status: "unknown", funds: null, positions: null, error: null };
  try {
    const kc = await kiteInstance();
    if (!kc) {
      out.kite_status = "no_client";
      out.error = "kite client not available";
      return out;
    }
    out.kite_status = "ok";
    try {
      const funds = (typeof kc.getFunds === "function") ? await kc.getFunds() : (typeof kc.get_funds === "function" ? await kc.get_funds() : null);
      if (funds) out.funds = funds;
    } catch (e) {
      out.funds = { error: String(e && e.message ? e.message : e) };
    }
    try {
      const positions = (typeof kc.getPositions === "function") ? await kc.getPositions() : (typeof kc.get_positions === "function" ? await kc.get_positions() : null);
      if (positions) out.positions = positions;
    } catch (e) {
      out.positions = { error: String(e && e.message ? e.message : e) };
    }
    return out;
  } catch (e) {
    out.kite_status = "error";
    out.error = String(e && e.message ? e.message : e);
    return out;
  }
}

/* Loss metrics (kept consistent with previous logic) */
function computeLossMetrics(persisted) {
  const capital = safeNum(persisted.capital ?? 0, 0);
  const max_loss_pct = safeNum(persisted.max_loss_pct ?? 0, 0);
  const realised = safeNum(persisted.realised ?? 0, 0);
  const unrealised = safeNum(persisted.unrealised ?? 0, 0);
  const total_pnl = realised + unrealised;

  const max_loss_abs = Math.round(capital * (max_loss_pct / 100));
  const active_loss_floor = realised - max_loss_abs;
  const remaining_to_max_loss = (total_pnl >= 0) ? (max_loss_abs - total_pnl) : (max_loss_abs + total_pnl);

  return {
    capital_day_915: capital,
    max_loss_abs,
    active_loss_floor,
    remaining_to_max_loss
  };
}

/* HTTP route dispatch */
export default async function handler(req, res) {
  try {
    const rawUrl = (req.url || req.path || (req.headers && (req.headers["x-now-route"] || req.headers["x-vercel-path"]))) || "";
    // normalize: remove query part for route decisions
    const qIndex = rawUrl.indexOf("?");
    const route = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const method = (req.method || "GET").toUpperCase();
    const query = req.query || (req._parsedUrl && req._parsedUrl.query) || {};
    const body = req.body || {};

    // Admin routes are gated centrally
    if (route.startsWith("/api/admin/") && !isAdminFromReq(req)) {
      return unauth(res);
    }

    // --- State / Guardian endpoint ---
    if (route === "/api/guardian" || route === "/api/state" || route === "/api/state/") {
      if (method !== "GET") return nope(res);
      // persisted normalized state
      const persisted = await getPersistedState();
      // compute loss metrics
      const computed = computeLossMetrics(persisted || {});
      // try live kite info
      const kiteInfo = await getLiveKiteInfoSafe();

      const persistedLastMtm = persisted?.last_mtm;
      const last_mtm = (typeof persistedLastMtm !== "undefined" && persistedLastMtm !== null)
        ? Number(persistedLastMtm)
        : Number.isFinite((persisted?.total_pnl ?? 0)) ? (persisted?.total_pnl ?? 0) : 0;
      const last_mtm_ts = (typeof persisted?.last_mtm_ts !== "undefined" && persisted?.last_mtm_ts !== null)
        ? Number(persisted.last_mtm_ts)
        : (persisted?.last_updated_ms || nowMs());

      const now = nowMs();
      const mergedState = {
        ...persisted,
        ...computed,
        live_balance: persisted?.live_balance ?? null,
        last_mtm,
        last_mtm_ts
      };

      return res.status(200).json({
        ok: true,
        time_utc: new Date(now).toISOString(),
        time_ist: formatIst(now),
        time_ms: now,
        kite_status: kiteInfo.kite_status || "unknown",
        kite: kiteInfo,
        state: mergedState
      });
    }

    // --- KITE: trades ---
    if (route.startsWith("/api/kite/trades")) {
      // require admin (trades are sensitive)
      if (!isAdminFromReq(req)) return unauth(res);

      // debug raw persisted state
      if ((query && query.raw === "1") || (body && body.raw === "1")) {
        const raw = await kv.get(STATE_KEY);
        return ok(res, { raw });
      }

      // canonical persisted tradebook
      const persisted = await getPersistedState();
      const tradebook = Array.isArray(persisted?.tradebook) ? persisted.tradebook : [];

      // Optionally: merge live kite trades with persisted tradebook here if you need to.
      // For safety, we return persisted tradebook as the source of truth.
      return ok(res, { tradebook });
    }

    // --- KITE: funds ---
    if (route.startsWith("/api/kite/funds")) {
      if (!isAdminFromReq(req)) return unauth(res);
      try {
        const kc = await kiteInstance();
        if (!kc) return bad(res, "kite_not_configured");
        // call preferred function if available
        const funds = (typeof kc.getFunds === "function") ? await kc.getFunds() : (typeof kc.get_funds === "function" ? await kc.get_funds() : null);
        return ok(res, { funds });
      } catch (e) {
        console.error("kite/funds error:", e && e.stack ? e.stack : e);
        return send(res, 500, { ok: false, error: "kite_error", detail: String(e && e.message ? e.message : e) });
      }
    }

    // --- ADMIN: set-config ---
    if (route.startsWith("/api/admin/set-config")) {
      if (method !== "POST" && method !== "PUT") return nope(res);
      const inBody = method === "POST" ? (req.body || {}) : (req.query || {});
      const patch = {};
      if (inBody.max_loss_pct !== undefined) patch.max_loss_pct = Number(inBody.max_loss_pct);
      if (inBody.trail_step_profit !== undefined) patch.trail_step_profit = Number(inBody.trail_step_profit);
      if (inBody.cooldown_minutes !== undefined) patch.cooldown_minutes = Number(inBody.cooldown_minutes);
      // add more validated fields as needed
      const updated = await persistState(patch);
      return ok(res, { state: updated });
    }

    // --- ADMIN: set-capital ---
    if (route.startsWith("/api/admin/set-capital")) {
      if (method !== "POST" && method !== "PUT") return nope(res);
      const inBody = method === "POST" ? (req.body || {}) : (req.query || {});
      const capital = Number(inBody.capital);
      if (!Number.isFinite(capital)) return bad(res, "invalid_capital");
      const updated = await persistState({ capital });
      return ok(res, { state: updated });
    }

    // --- ADMIN: cancel-pending (helpful maintenance endpoint) ---
    if (route.startsWith("/api/admin/cancel-pending")) {
      if (method !== "POST" && method !== "GET") return nope(res);
      // best-effort: call enforce.cancelPending if present, otherwise try via kc
      try {
        if (typeof enforce.cancelPending === "function") {
          const out = await enforce.cancelPending();
          return ok(res, { cancelled: out });
        } else {
          const kc = await kiteInstance();
          if (!kc) return bad(res, "kite_not_configured");
          // naive cancel attempt
          const orders = (await kc.getOrders?.()) || [];
          const pending = orders.filter(o => o.status === "OPEN" || o.status === "TRIGGER PENDING");
          const outs = [];
          for (const p of pending) {
            try {
              await kc.cancelOrder(p.order_id);
              outs.push(p.order_id);
            } catch (e) {
              console.warn("cancel order fail", p.order_id, e && e.message ? e.message : e);
            }
          }
          return ok(res, { cancelled: outs });
        }
      } catch (e) {
        console.error("cancel-pending error:", e && e.stack ? e.stack : e);
        return send(res, 500, { ok: false, error: "cancel_error", detail: String(e && e.message ? e.message : e) });
      }
    }

    // --- ADMIN: square-off (close positions) ---
    if (route.startsWith("/api/admin/square-off")) {
      if (method !== "POST" && method !== "GET") return nope(res);
      try {
        if (typeof enforce.squareOffAll === "function") {
          const out = await enforce.squareOffAll();
          return ok(res, { result: out });
        } else {
          // best-effort naive square-off: attempt to place market orders opposite to holdings (dangerous).
          return bad(res, "no_enforce_impl");
        }
      } catch (e) {
        console.error("square-off error:", e && e.stack ? e.stack : e);
        return send(res, 500, { ok: false, error: "squareoff_error", detail: String(e && e.message ? e.message : e) });
      }
    }

    // Fallback: not found
    return send(res, 404, { ok: false, error: "not_found" });

  } catch (e) {
    console.error("hub catch error:", e && e.stack ? e.stack : e);
    return send(res, 500, { ok: false, error: "server_error", detail: String(e && e.message ? e.message : e) });
  }
                            }
