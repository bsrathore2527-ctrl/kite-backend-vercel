import { kv } from "@vercel/kv";

// send JSON helper
const send = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
};

// parse JSON body helper
async function getBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

// build today's KV risk key
const getTodayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `risk:${y}-${m}-${day}`;
};

export default async function handler(req, res) {
  const url = req.url;
  const method = req.method;

  try {
    // --------------------------------------------------
    // 1) /api/dashboard → read KV "risk:YYYY-MM-DD"
    // --------------------------------------------------
    if (url === "/api/dashboard") {
      const key = getTodayKey();
      const state = await kv.get(key);

      const ui = {
        ok: true,
        time: new Date().toLocaleTimeString(),
        kite_status: state?.kite_status ?? "error",
        state: state || {}
      };

      return send(res, 200, ui);
    }

    // --------------------------------------------------
    // 2) /api/tradebook
    // --------------------------------------------------
    if (url === "/api/tradebook") {
      const tb = await kv.get("guardian_tradebook");
      return send(res, 200, tb || []);
    }

    // --------------------------------------------------
    // 3) /api/admin/login-zerodha
    // --------------------------------------------------
    if (url === "/api/admin/login-zerodha") {
      const loginUrl = process.env.KITE_LOGIN_URL || "";
      res.statusCode = 200;
      res.end(loginUrl);
      return;
    }

    // --------------------------------------------------
    // 4) /api/admin/kill
    // --------------------------------------------------
    if (url === "/api/admin/kill" && method === "POST") {
      await kv.set("guardian_command", {
        type: "kill",
        at: Date.now()
      });
      return send(res, 200, { ok: true });
    }

    // --------------------------------------------------
    // 5) /api/admin/cancel
    // --------------------------------------------------
    if (url === "/api/admin/cancel" && method === "POST") {
      await kv.set("guardian_command", {
        type: "cancel",
        at: Date.now()
      });
      return send(res, 200, { ok: true });
    }

    // --------------------------------------------------
    // 6) /api/admin/reset-day
    // --------------------------------------------------
    if (url === "/api/admin/reset-day" && method === "POST") {
      await kv.set("guardian_reset_day", { at: Date.now() });
      return send(res, 200, { ok: true });
    }

    // --------------------------------------------------
    // 7) /api/admin/save-config
    // --------------------------------------------------
    if (url === "/api/admin/save-config" && method === "POST") {
      const cfg = await getBody(req);
      await kv.set("guardian_cfg", cfg);
      return send(res, 200, { ok: true, saved: cfg });
    }

    // --------------------------------------------------
    // NOT FOUND
    // --------------------------------------------------
    return send(res, 404, { ok: false, error: "Not Found" });

  } catch (err) {
    return send(res, 500, { ok: false, error: err.message });
  }
}
