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
    // 1️⃣ Load KV State
    // -------------------------------------------------------
    let state = await redis.get("latest_kv_state");

    if (!state) {
      const date = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      });
      state = await redis.get(`risk:${date}`) || {};
    }

    // -------------------------------------------------------
    // 2️⃣ Individual Logs (ensure arrays exist)
    // -------------------------------------------------------
    const mtmLog = state.mtm_log || [];
    const configLogs = state.config_logs || [];
    const resetLogs = state.reset_logs || [];
    const enforceLogs = state.enforce_logs || [];
    const connectionLogs = state.connection_logs || [];

    // admin_last_enforce_result → convert to log if present
    const adminEnforce = state.admin_last_enforce_result
      ? [{
          ts: state.admin_last_enforce_result.at,
          type: "admin_enforce",
          detail: state.admin_last_enforce_result
        }]
      : [];

    // -------------------------------------------------------
    // 3️⃣ Load tradebook logs from guardian:tradebook
    // -------------------------------------------------------
    const tradebook = (await redis.get("guardian:tradebook")) || [];

    // Convert each trade entry into UI log format
    const tradeLogs = tradebook.map(t => ({
      ts: t.ts,
      type: "trade",
      detail: {
        symbol: t.tradingsymbol,
        side: t.side,
        qty: t.qty,
        price: t.raw?.average_price ?? 0,
        exchange_timestamp: t.raw?.exchange_timestamp || null,
      }
    }));

    // -------------------------------------------------------
    // 4️⃣ Convert mtm_log to UI log format
    // -------------------------------------------------------
    const mtmLogsUI = mtmLog.map(m => ({
      ts: m.ts,
      type: "mtm",
      detail: {
        realised: m.realised,
        unrealised: m.unrealised,
        total: m.total,
      },
    }));

    // -------------------------------------------------------
    // 5️⃣ Convert config_logs → UI
    // -------------------------------------------------------
    const configLogsUI = configLogs.map(c => ({
      ts: c.time,
      type: "config_change",
      detail: c.patch,
    }));

    // -------------------------------------------------------
    // 6️⃣ Reset logs → UI
    // -------------------------------------------------------
    const resetLogsUI = resetLogs.map(r => ({
      ts: r.time,
      type: "reset_day",
      detail: { reason: r.reason },
    }));

    // -------------------------------------------------------
    // 7️⃣ Connection logs → UI
    // -------------------------------------------------------
    const connectionLogsUI = connectionLogs.map(c => ({
      ts: c.time,
      type: "connection_event",
      detail: c,
    }));

    // -------------------------------------------------------
    // 8️⃣ Enforcement logs → UI
    // -------------------------------------------------------
    const enforceLogsUI = enforceLogs.map(e => ({
      ts: e.time,
      type: "enforce_event",
      detail: e,
    }));

    // -------------------------------------------------------
    // 9️⃣ Combine all logs
    // -------------------------------------------------------
    const allLogs = [
      ...mtmLogsUI,
      ...tradeLogs,
      ...configLogsUI,
      ...resetLogsUI,
      ...connectionLogsUI,
      ...enforceLogsUI,
      ...adminEnforce
    ];

    // -------------------------------------------------------
    // 🔟 Sort newest → oldest
    // -------------------------------------------------------
    allLogs.sort((a, b) => b.ts - a.ts);

    // -------------------------------------------------------
    // 11️⃣ Return final output
    // -------------------------------------------------------
    return res.status(200).json({
      id: "logs",
      count: allLogs.length,
      logs: allLogs,
      updated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error("logs error:", err);
    return res.status(500).json({ detail: err.message });
  }
}
