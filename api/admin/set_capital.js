// api/admin/set-capital.js
import { kv, todayKey } from "../_lib/kv.js";

function send(res, code, body = {}) {
  return res.status(code).setHeader("Cache-Control", "no-store").json(body);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });

    // simple admin token check (your other admin endpoints use Authorization header)
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const expected = process.env.ADMIN_TOKEN || ""; // if you enforce server-side token
    if (expected && auth !== expected) {
      // if you store token locally only, you may allow this without server check
      return send(res, 401, { ok: false, error: "Unauthorized" });
    }

    const body = (req.body && typeof req.body === "object") ? req.body : JSON.parse(req.body || "{}");
    const val = Number(body.capital);
    if (!Number.isFinite(val) || val < 0) {
      return send(res, 400, { ok: false, error: "Invalid capital value" });
    }

    const key = `risk:${todayKey()}`;
    const state = (await kv.get(key)) || {};
    state.capital_day_915 = val;
    state.admin_override_capital = true;
    state.admin_override_at = Date.now();
    await kv.set(key, state);

    return send(res, 200, { ok: true, capital_day_915: val });
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
