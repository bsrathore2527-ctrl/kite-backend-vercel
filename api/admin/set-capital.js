// api/admin/set-capital.js
// Store an admin override for capital_day_915 in KV so api/state.js will pick it up.
// Expects POST { capital: number } and Authorization: Bearer <ADMIN_TOKEN> header.

import { todayKey, kv } from "../_lib/kv.js"; // adjust path if needed
import { json } from 'micro'; // optional - if not using micro you can parse req body yourself

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    if (!isAdmin(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // parse body (compatible with Vercel / Node fetch)
    let body = {};
    try {
      body = await (async () => {
        if (req.headers["content-type"] && req.headers["content-type"].includes("application/json")) {
          return await new Promise((resolve, reject) => {
            let data = "";
            req.on && req.on("data", chunk => data += chunk);
            req.on && req.on("end", () => {
              try { resolve(JSON.parse(data || "{}")); } catch(e) { reject(e); }
            });
            // in some serverless runtimes req may already be consumed - fallback:
            if (!req.on) resolve({});
          });
        }
        return {};
      })();
    } catch (e) {
      // try fallback: maybe server framework already parsed body as req.body
      body = req.body || {};
    }

    const rawCapital = body.capital;
    if (rawCapital === undefined || rawCapital === null) {
      return res.status(400).json({ ok: false, error: "Missing 'capital' in request body" });
    }
    const capital = Number(rawCapital);
    if (!Number.isFinite(capital) || capital < 0) {
      return res.status(400).json({ ok: false, error: "Invalid 'capital' value" });
    }

    const key = `risk:${todayKey()}`;
    const payload = {
      admin_override_capital: true,
      capital_day_915: capital,
      set_at: Date.now()
    };

    // write to KV (replace previous override for today)
    await kv.set(key, payload);

    return res.status(200).json({ ok: true, capital_day_915: capital, key });
  } catch (err) {
    console.error("set-capital error:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
