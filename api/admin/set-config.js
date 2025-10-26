// api/admin/set-config.js
import { setState } from "../_lib/kv.js";

/**
 * Robust JSON body parser for Node serverless (Vercel)
 */
async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      if (!body) return resolve(null);
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("invalid json")); }
    });
    req.on("error", (err) => reject(err));
  });
}

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7).trim() : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    }

    if (!isAdmin(req)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "invalid json" }));
    }

    if (!body || (typeof body.cooldown_on_profit === "undefined" && typeof body.min_loss_to_count === "undefined")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "missing fields" }));
    }

    // sanitize inputs
    const patch = {};
    if (typeof body.cooldown_on_profit !== "undefined") {
      patch.cooldown_on_profit = !!body.cooldown_on_profit;
    }
    if (typeof body.min_loss_to_count !== "undefined") {
      const v = Number(body.min_loss_to_count);
      patch.min_loss_to_count = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    }

    const next = await setState(patch);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, new_state: next }));
  } catch (err) {
    console.error("set-config error:", err && err.stack ? err.stack : err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
  }
}
