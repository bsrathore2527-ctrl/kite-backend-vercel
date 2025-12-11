import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Allowed frontend origins
const allowed = [
  "https://boho.trading",
  "https://www.boho.trading",
  "https://bohoapp.com",
  "https://www.bohoapp.com",
  "http://localhost:3000", // dev
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
    // 1️⃣ Pipeline fetch: latest_kv_state + tradebook
    // -------------------------------------------------------
    const pipeline = redis.pipeline();

    pipeline.get("latest_kv_state");
    pipeline.get("guardian:tradebook");

    const [state, tradebookRaw] = await pipeline.exec();

    // Fallback tradebook
    const tradebook = Array.isArray(tradebookRaw) ? tradebookRaw : [];

    // Fallback state -> risk:DATE
    let finalState = state;

    if (!finalState) {
      const istrDate = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });

      finalState = await redis.get(`risk:${istrDate}`) || {};
    }

    if (!finalState) {
      return res.status(200).json({
        id: "logs",
        count: 0,
        logs: [],
        updated_at: new Date().toISOString(),
      });
    }

    // -------------------------------------------------------
    // 2️⃣ Extract logs safely (ensure arrays)
    // -------------------------------------------------------
    const mtmLog = finalState.mtm_log || [];
    const configLogs = finalState.config_logs || [];
    const resetLogs = finalState.reset_logs || [];
    const enforceLogs = finalState.enforce_logs || [];
    const connectionLogs = finalState.connection_logs || [];
    const adminResult = finalState.admin_last_enforce_result || null;

    // -------------------------------------------------------
    // 3️⃣ Convert MTM logs → UI format
    // -------------------------------------------------------
    const mtmUI = mtmLog.map((m) => ({
      ts: m.ts,
      type: "mtm",
      detail: {
        realised: m.realised,
        unrealised: m.unrealised,
        total: m.total,
      },
    }));

    // -------------------------------------------------------
    // 4️⃣ Convert tradebook → UI logs
    // -------------------------------------------------------
    const tradeUI = tradebook.map((t) => ({
      ts: t.ts,
      type: "trade",
      detail: {
        symbol: t.tradingsymbol,
        side: t.side,
        qty: t.qty,
        price: t.raw?.average_price ?? 0,
        order_id: t.raw?.order_id ?? null,
        exchange_order_id: t.raw?.exchange_order_id ?? null,
        exchange: t.raw?.exchange ?? null,
        product: t.raw?.product ?? null,
      },
    }));

    // -------------------------------------------------------
    // 5️⃣ Config logs → UI
    // -------------------------------------------------------
    const configUI = configLogs.map((c) => ({
      ts: c.time,
      type: "config_change",
      detail: c.patch,
    }));

    // -------------------------------------------------------
    // 6️⃣ Reset logs → UI
    // -------------------------------------------------------
    const resetUI = resetLogs.map((r) => ({
      ts: r.time,
      type: "reset_day",
      detail: { reason: r.reason },
    }));

    // -------------------------------------------------------
    // 7️⃣ Connection logs → UI
    // -------------------------------------------------------
    const connectionUI = connectionLogs.map((c) => ({
      ts: c.time,
      type: "connection_event",
      detail: c,
    }));

    // -------------------------------------------------------
    // 8️⃣ Enforcement logs → UI
    // -------------------------------------------------------
    const enforceUI = enforceLogs.map((e) => ({
      ts: e.time,
      type: "enforce_event",
      detail: e,
    }));

    // -------------------------------------------------------
    // 9️⃣ Admin enforce summary → UI
    // -------------------------------------------------------
    const adminEnforceUI = adminResult
      ? [{
          ts: adminResult.at,
          type: "admin_enforce",
          detail: adminResult,
        }]
      : [];

    // -------------------------------------------------------
    // 🔟 Combine logs
    // -------------------------------------------------------
    const allLogs = [
      ...mtmUI,
      ...tradeUI,
      ...configUI,
      ...resetUI,
      ...connectionUI,
      ...enforceUI,
      ...adminEnforceUI,
    ];

    // -------------------------------------------------------
    // 11️⃣ Sort newest → oldest
    // -------------------------------------------------------
    allLogs.sort((a, b) => b.ts - a.ts);

    // -------------------------------------------------------
    // 12️⃣ Final response
    // -------------------------------------------------------
    return res.status(200).json({
      id: "logs",
      count: allLogs.length,
      logs: allLogs,
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error("logs pipeline error:", err);
    return res.status(500).json({ detail: err.message });
  }
}
