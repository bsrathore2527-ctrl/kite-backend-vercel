import { Redis } from "@upstash/redis";

// Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// CORS domains
const allowed = [
  "https://boho.trading",
  "https://bohoapp.com",
  "https://www.boho.trading",
  "https://www.bohoapp.com",
];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // get today's date (IST)
    const date = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });

    const key = `risk:${date}`;

    const risk = await redis.get(key);

    if (!risk) {
      return res.status(200).json({ ok: true, logs: [] });
    }

    // Prepare unified logs array
    const logs = [];

    // 1. MTM logs
    if (risk.mtm_log) {
      risk.mtm_log.forEach((e) =>
        logs.push({
          ts: e.ts,
          type: "mtm",
          message: `MTM updated → total: ${e.total}`,
          details: e,
        })
      );
    }

    // 2. Config logs
    if (risk.config_logs) {
      risk.config_logs.forEach((e) =>
        logs.push({
          ts: e.time,
          type: "config_change",
          message: "Configuration updated",
          details: e.patch,
        })
      );
    }

    // 3. Reset logs
    if (risk.reset_logs) {
      risk.reset_logs.forEach((e) =>
        logs.push({
          ts: e.time,
          type: "reset",
          message: `Day Reset → reason: ${e.reason}`,
          details: e,
        })
      );
    }

    // 4. Trip events
    if (risk.tripped_day && risk.trip_reason) {
      logs.push({
        ts: risk.mtm_last_update,
        type: "trip",
        message: `Day Tripped → ${risk.trip_reason}`,
      });
    }

    // 5. Enforcement logs
    if (risk.admin_last_enforce_result) {
      const e = risk.admin_last_enforce_result;
      logs.push({
        ts: e.at,
        type: "enforce",
        message: `Enforcement → ${e.reason}`,
        details: e,
      });
    }

    // Sort newest → oldest
    logs.sort((a, b) => b.ts - a.ts);

    return res.status(200).json({
      ok: true,
      logs,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
