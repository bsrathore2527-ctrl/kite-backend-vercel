import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Allowed UI domains
const allowed = [
  "https://boho.trading",
  "https://www.boho.trading",
  "https://bohoapp.com",
  "https://www.bohoapp.com",
  "http://localhost:3000" // dev
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
    // 1️⃣ Use pipeline to fetch tradebook in ONE request
    // -------------------------------------------------------
    const pipeline = redis.pipeline();
    pipeline.get("guardian:tradebook");

    const [tradebookRaw] = await pipeline.exec();

    // Fallback if null
    const tradebook = Array.isArray(tradebookRaw) ? tradebookRaw : [];

    // -------------------------------------------------------
    // 2️⃣ Convert to UI-friendly format
    // -------------------------------------------------------
    const trades = tradebook.map((t) => ({
      id: t.trade_id ?? null,
      symbol: t.tradingsymbol,
      side: t.side,                // BUY / SELL
      qty: t.qty,
      price: t.raw?.average_price ?? 0,

      timestamp: t.ts,
      exchange_timestamp: t.raw?.exchange_timestamp ?? null,

      order_id: t.raw?.order_id ?? null,
      exchange_order_id: t.raw?.exchange_order_id ?? null,
      exchange: t.raw?.exchange ?? null,
      product: t.raw?.product ?? null,
    }));

    // -------------------------------------------------------
    // 3️⃣ Sort newest → oldest
    // -------------------------------------------------------
    trades.sort((a, b) => b.timestamp - a.timestamp);

    // -------------------------------------------------------
    // 4️⃣ Final output
    // -------------------------------------------------------
    return res.status(200).json({
      id: "trades",
      count: trades.length,
      trades,
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error("trades pipeline error:", err);
    return res.status(500).json({ detail: err.message });
  }
}
