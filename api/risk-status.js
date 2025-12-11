import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ detail: "Method not allowed" });

  try {
    // -------------------------------------------------------
    // 1️⃣ Use pipeline to fetch everything in ONE Redis call
    // -------------------------------------------------------
    const pipeline = redis.pipeline();

    pipeline.get("latest_kv_state");
    pipeline.get("guardian:tradebook");

    const [state, tradebookRaw] = await pipeline.exec();

    // pipeline returns raw arrays sometimes → fallback
    const tradebook = Array.isArray(tradebookRaw) ? tradebookRaw : [];

    // Fallback in case latest_kv_state is not present
    let finalState = state;

    if (!finalState) {
      const istrDate = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });

      finalState = await redis.get(`risk:${istrDate}`) || {};
    }

    if (!finalState) {
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

    // -------------------------------------------------------
    // 2️⃣ Compute cooldown remaining
    // -------------------------------------------------------
    let cooldown_remaining_minutes = 0;
    if (finalState.cooldown_active && finalState.cooldown_until) {
      const now = Date.now();
      const diff = finalState.cooldown_until - now;
      cooldown_remaining_minutes = diff > 0 ? Math.floor(diff / 60000) : 0;
    }

    // -------------------------------------------------------
    // 3️⃣ Count trades executed today (IST)
    // -------------------------------------------------------
    const nowIST = new Date().toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
    });
    const d = new Date(nowIST);
    d.setHours(0, 0, 0, 0);
    const startIST = d.getTime();
    const endIST = startIST + 24 * 60 * 60 * 1000 - 1;

    const trade_count_today = tradebook.filter((t) => {
      return t.ts >= startIST && t.ts <= endIST;
    }).length;

    // -------------------------------------------------------
    // 4️⃣ Prepare violations
    // -------------------------------------------------------
    const violations = [];
    if (finalState.trip_reason) violations.push(finalState.trip_reason);

    // -------------------------------------------------------
    // 5️⃣ Build final response object
    // -------------------------------------------------------
    const response = {
      id: "current_status",

      realised: finalState.realised ?? 0,
      unrealised: finalState.unrealised ?? 0,
      total_pnl: finalState.total_pnl ?? 0,

      consecutive_losses: finalState.consecutive_losses ?? 0,

      in_cooldown: finalState.cooldown_active ?? false,
      cooldown_remaining_minutes,

      max_loss_hit: finalState.tripped_day ?? false,
      violations,

      trade_count_today,

      updated_at: new Date().toISOString(),
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("risk-status pipeline error:", err);
    return res.status(500).json({ detail: err.message });
  }
}
