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
  "http://localhost:3000"
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type",x-admin-key");
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
    // ---------------------------------------------
    // 1️⃣ Read latest KV state (pipeline)
    // ---------------------------------------------
    const pipeline = redis.pipeline();
    pipeline.get("latest_kv_state");

    const [state] = await pipeline.exec();
    if (!state) {
      return res.status(400).json({ ok: false, detail: "State missing" });
    }

    const now = Date.now();

    // ---------------------------------------------
    // 2️⃣ Add admin enforce log entry
    // ---------------------------------------------
    const entry = {
      time: now,
      action: "cancel_orders",
      by: "admin",
      message: "Admin cancelled all open orders"
    };

    const updated = {
      ...state,
      enforce_logs: [...(state.enforce_logs ?? []), entry],
      admin_last_enforce_result: {
        cancelled: 1,
        squared: 0,
        at: now,
        reason: "admin_cancel"
      },
      block_new_orders: true // prevents further placement
    };

    // ---------------------------------------------
    // 3️⃣ Save updated enforce state
    // ---------------------------------------------
    await redis.set("latest_kv_state", updated);

    return res.status(200).json({
      ok: true,
      message: "Cancel signal sent. Risk engine will cancel all open orders.",
      at: now
    });

  } catch (err) {
    console.error("cancel.js error:", err);
    return res.status(500).json({ ok: false, detail: err.message });
  }
}
