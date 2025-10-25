// api/admin/set-capital.js
import { setState } from "../_lib/kv.js";

/**
 * Safe JSON body parser that works on Vercel Node serverless
 * (it reads the raw request body and JSON.parse's it).
 */
async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (!body) return resolve(null);
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (e) {
        reject(new Error("invalid json"));
      }
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
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    }

    if (!isAdmin(req)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    // parse JSON body (robust across runtimes)
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "invalid json", message: e.message }));
    }

    if (!body || typeof body.capital === "undefined" || body.capital === null) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "missing capital" }));
    }

    // normalise value
    let capital = Number(body.capital);
    if (!Number.isFinite(capital) || capital < 0) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "invalid capital value" }));
    }

    // round to integer rupees
    capital = Math.round(capital);

    // persist using your kv.setState() helper
    const next = await setState({
      capital_day_915: capital,
      admin_override_capital: true,
      admin_override_at: Date.now(),
      admin_override_by: process.env.ADMIN_TOKEN ? "admin" : null // avoid leaking token; just a marker
    });

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, capital: capital, new_state: next }));
  } catch (err) {
    console.error("set-capital error:", err && err.stack ? err.stack : err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
  }
}
