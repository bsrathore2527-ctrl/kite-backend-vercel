import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Allowed admin origins
const allowed = [
  "https://boho.trading",
  "https://www.boho.trading",
  "https://bohoapp.com",
  "https://www.bohoapp.com",
  "http://localhost:3000",
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type ,x-admin-key");
  // ADMIN SECURITY CHECK
const ADMIN_KEY = process.env.ADMIN_SECRET;
if (!req.headers["x-admin-key"] || req.headers["x-admin-key"] !== ADMIN_KEY) {
  return res.status(401).json({
    ok: false,
    detail: "Unauthorized: invalid admin key"
  });
}


  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ detail: "Method not allowed" });

  try {
    // -----------------------------------------------------
    // 1️⃣ Pipeline → fetch latest_kv_state
    // -----------------------------------------------------
    const pipeline = redis.pipeline();
    pipeline.get("latest_kv_state");

    const [rawState] = await pipeline.exec();
    let state = rawState;

    // fallback → risk:DATE
    if (!state) {
      const istrDate = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });
      state = await redis.get(`risk:${istrDate}`) || {};
    }

    if (!state) {
      return res.status(400).json({
        ok: false,
        detail: "No KV state found to reset.",
      });
    }

    // -----------------------------------------------------
    // 2️⃣ Prepare updated reset state
    // -----------------------------------------------------
    const now = Date.now();

    const resetEntry = {
      time: now,
      reason: "manual_reset",
    };

    const updatedState = {
      ...state,

      // reset PnL
      realised: 0,
      unrealised: 0,
      total_pnl: 0,

      // reset positions
      last_net_positions: {},
      trade_count_today: 0,

      // remove cooldown
      cooldown_active: false,
      cooldown_until: 0,
      consecutive_losses: 0,

      // reset trip status
      tripped_day: false,
      trip_reason: null,

      // Restore loss floor using capital
      active_loss_floor: -(state.max_loss_abs ?? 0),
      remaining_to_max_loss: state.max_loss_abs ?? 0,

      // Keep capital override
      capital_day_915: state.capital_day_915 ?? 20000,

      // Logs
      reset_logs: [...(state.reset_logs ?? []), resetEntry],
    };

    // -----------------------------------------------------
    // 3️⃣ Save updated state
    // -----------------------------------------------------
    await redis.set("latest_kv_state", updatedState);

    return res.status(200).json({
      ok: true,
      message: "Day reset successful.",
      timestamp: now,
      updated_state: updatedState,
    });

  } catch (err) {
    console.error("reset-day error:", err);
    return res.status(500).json({ ok: false, detail: err.message });
  }
}
