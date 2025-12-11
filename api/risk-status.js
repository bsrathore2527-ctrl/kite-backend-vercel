import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Allowed CORS origins
const allowed = [
  "https://boho.trading",
  "https://www.boho.trading",
  "https://bohoapp.com",
  "https://www.bohoapp.com",
  "http://localhost:3000" // optional for local dev
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ detail: "Method not allowed" });

  try {
    // Load latest KV state synced by risk-engine
    let state = await redis.get("latest_kv_state");

    // Fallback (if sync-kv-state hasn't been used)
    if (!state) {
      const date = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });
      state = await redis.get(`risk:${date}`);
    }

    if (!state) {
      // Empty response, safe defaults
      return res.status(200).json({
        id: "current_status",
        realised: 0,
        unrealised: 0,
        total_pnl: 0,
        consecutive_losses: 0,
        in_cooldown: false,
        cooldown_remaining_minutes: 0,
        max_loss_hit: false,
        violations: [],
        trade_count_today: 0,
        updated_at: new Date().toISOString(),
      });
    }

    // ----------------------------
    // 1️⃣ Compute cooldown remaining
    // ----------------------------
    let cooldown_remaining_minutes = 0;

    if (state.cooldown_active && state.cooldown_until) {
      const now = Date.now();
      const diffMs = state.cooldown_until - now;
      cooldown_remaining_minutes = diffMs > 0
        ? Math.floor(diffMs / 60000)
        : 0;
    }

    // ----------------------------
    // 2️⃣ Count today's trades from guardian:tradebook
    // ----------------------------
    const tradebook = (await redis.get("guardian:tradebook")) || [];

    // IST midnight boundaries
    const nowIST = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const d = new Date(nowIST);
    d.setHours(0, 0, 0, 0);
    const startIST = d.getTime();
    const endIST = startIST + 24 * 60 * 60 * 1000 - 1;

    const trade_count_today = tradebook.filter(t =>
      t.ts >= startIST && t.ts <= endIST
    ).length;

    // ----------------------------
    // 3️⃣ Violations list
    // ----------------------------
    const violations = [];
    if (state.trip_reason) violations.push(state.trip_reason);

    // ----------------------------
    // 4️⃣ Construct risk-status structure
    // ----------------------------
    const result = {
      id: "current_status",

      // PnL
      realised: state.realised ?? 0,
      unrealised: state.unrealised ?? 0,
      total_pnl: state.total_pnl ?? 0,

      // Loss streak
      consecutive_losses: state.consecutive_losses ?? 0,

      // Cooldown
      in_cooldown: state.cooldown_active ?? false,
      cooldown_remaining_minutes,

      // Trip / block logic
      max_loss_hit: state.tripped_day ?? false,
      violations,

      // Trades today
      trade_count_today,

      updated_at: new Date().toISOString(),
    };

    return res.status(200).json(result);
  } catch (err) {
    console.error("risk-status error:", err);
    return res.status(500).json({ detail: err.message });
  }
}
