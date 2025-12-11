import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Allowed frontend domains
const allowed = [
  "https://boho.trading",
  "https://www.boho.trading",
  "https://bohoapp.com",
  "https://www.bohoapp.com",
  "http://localhost:3000" // optional for dev
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // --- Load KV state (synced or from risk:DATE) ---
    let state = await redis.get("latest_kv_state");

    if (!state) {
      const date = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });
      state = await redis.get(`risk:${date}`) || {};
    }

    // ----------------------------------------------------------
    // GET → Return RiskConfig object for UI
    // ----------------------------------------------------------
    if (req.method === "GET") {
      const capital = state.capital_day_915 ?? 3000;

      const config = {
        id: "current_config",

        // Required by UI
        daily_max_loss: state.max_loss_abs ?? (capital * (state.max_loss_pct ?? 10) / 100),
        daily_max_profit: state.max_profit_abs ?? (capital * (state.max_profit_pct ?? 10) / 100),
        consecutive_loss_limit: state.max_consecutive_losses ?? 3,
        cooldown_after_loss: state.cooldown_min ?? 15,
        trailing_profit_enabled: (state.trail_step_profit ?? 0) > 0,
        trailing_profit_step: state.trail_step_profit ?? 0,

        // Optional extras the UI ignores safely
        min_loss_to_count: state.min_loss_to_count ?? 0,
        allow_new: state.allow_new ?? true,
        side_lock: state.side_lock ?? null,

        updated_at: new Date().toISOString(),
      };

      return res.status(200).json(config);
    }

    // ----------------------------------------------------------
    // PUT → Update config inside KV
    // The UI sends fields: daily_max_loss, daily_max_profit, ...
    // ----------------------------------------------------------
    if (req.method === "PUT") {
      let body = "";

      await new Promise((resolve) => {
        req.on("data", (chunk) => (body += chunk));
        req.on("end", resolve);
      });

      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch (err) {
        return res.status(400).json({ detail: "Invalid JSON" });
      }

      // Build updated state
      const updated = {
        ...state,

        max_loss_abs: data.daily_max_loss,
        max_profit_abs: data.daily_max_profit,
        max_consecutive_losses: data.consecutive_loss_limit,
        cooldown_min: data.cooldown_after_loss,
        trail_step_profit: data.trailing_profit_step,

        // optional
        min_loss_to_count: data.min_loss_to_count ?? state.min_loss_to_count,
        allow_new: data.allow_new ?? state.allow_new,
      };

      // Persist changes
      await redis.set("latest_kv_state", updated);

      // Return updated config in UI format
      const response = {
        id: "current_config",
        ...data,
        updated_at: new Date().toISOString(),
      };

      return res.status(200).json(response);
    }

    return res.status(405).json({ detail: "Method not allowed" });

  } catch (err) {
    console.error("risk-config error:", err);
    return res.status(500).json({ detail: err.message });
  }
}
