// api/admin/set_capital.js
import { kv, todayKey } from "../_lib/kv.js";
import { checkAdmin } from "../_lib/admin-utils.js";

function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });

export default async function handler(req, res) {
  try {
    if (!checkAdmin(req, process.env.ADMIN_TOKEN)) return send(res, 401, { ok: false, error: "unauthorized" });
    if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });

    const { capital } = req.body || {};
    if (capital === undefined || Number.isNaN(Number(capital))) return bad(res, "invalid capital");

    const key = `risk:${todayKey()}`;
    const cur = (await kv.get(key)) || {};
    const next = { ...cur, capital_day_915: Number(capital) };
    await kv.set(key, next);

    return ok(res, { capital_day_915: next.capital_day_915 });
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || String(e) });
  }
}
