// api/admin/set-capital.js
import { getState, setState, todayKey } from "../_lib/kv.js"; // adjust path if needed

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : a;
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  try {
    // Only allow POST for setting capital
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "method not allowed" });
    }

    if (!isAdmin(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Parse JSON body safely
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return res.status(400).json({ ok: false, error: "invalid json", message: e.message });
    }

    const capitalRaw = body && (body.capital ?? body.amount ?? body.value);
    if (capitalRaw === undefined || capitalRaw === null) {
      return res.status(400).json({ ok: false, error: "missing capital" });
    }

    const capital = Number(capitalRaw);
    if (!Number.isFinite(capital) || capital < 0) {
      return res.status(400).json({ ok: false, error: "invalid capital" });
    }

    // load state, update and save
    const s = await getState();
    const newState = {
      ...s,
      capital_day_915: capital,
      admin_override_capital: true,
      admin_override_capital_at: Date.now()
    };

    // setState must be available in your kv.js; if your API uses a different function name adapt here.
    if (typeof setState !== "function") {
      // If setState doesn't exist, try writing back to your KV method name (adjust if needed)
      return res.status(500).json({ ok: false, error: "server misconfigured: setState not available" });
    }

    await setState(newState);

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, capital: newState.capital_day_915 });
  } catch (e) {
    console.error("set-capital error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
