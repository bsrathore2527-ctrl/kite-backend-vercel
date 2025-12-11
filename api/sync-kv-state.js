import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ENGINE_KEY = process.env.RISK_ENGINE_SECRET || null;

// ----------- UTIL: Deduplicate log entries by `ts` key -----------
function dedupeLogs(existing = [], incoming = []) {
  if (!Array.isArray(existing)) existing = [];
  if (!Array.isArray(incoming)) incoming = [];

  const seen = new Set(existing.map((e) => e.ts));
  const merged = [...existing];

  for (const item of incoming) {
    if (item && typeof item === "object" && !seen.has(item.ts)) {
      merged.push(item);
      seen.add(item.ts);
    }
  }

  return merged;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-engine-key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, detail: "Method not allowed" });

  try {
    // ----------- 1) ENGINE AUTH -----------
    if (ENGINE_KEY) {
      const key = req.headers["x-engine-key"];
      if (key !== ENGINE_KEY) {
        return res.status(401).json({ ok: false, detail: "Invalid engine key" });
      }
    }

    // ----------- 2) Parse JSON Body -----------
    let raw = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", resolve);
    });

    let incoming = {};
    try {
      incoming = JSON.parse(raw || "{}");
    } catch (e) {
      return res.status(400).json({ ok: false, detail: "Invalid JSON" });
    }

    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ ok: false, detail: "Invalid state object" });
    }

    // ----------- 3) Fetch Previous State (Pipeline) -----------
    const pipeline = redis.pipeline();
    pipeline.get("latest_kv_state");
    pipeline.get("guardian:tradebook");
    const [prevState, tradebook] = await pipeline.exec();

    const prev = prevState || {};

    // ----------- 4) Merge State with Log Deduping -----------
    const merged = {
      ...prev,
      ...incoming,

      mtm_log: dedupeLogs(prev.mtm_log, incoming.mtm_log),
      config_logs: dedupeLogs(prev.config_logs, incoming.config_logs),
      reset_logs: dedupeLogs(prev.reset_logs, incoming.reset_logs),
      enforce_logs: dedupeLogs(prev.enforce_logs, incoming.enforce_logs),
      connection_logs: dedupeLogs(prev.connection_logs, incoming.connection_logs),

      last_tradebook_count: Array.isArray(tradebook) ? tradebook.length : 0,
      admin_last_enforce_result:
        incoming.admin_last_enforce_result ?? prev.admin_last_enforce_result ?? null,

      synced_at: Date.now(),
    };

    // ----------- 5) Save merged state -----------
    await redis.set("latest_kv_state", merged);

    // ----------- 6) Response -----------
    return res.status(200).json({
      ok: true,
      message: "KV sync complete",
      synced_at: merged.synced_at,
    });

  } catch (err) {
    console.error("sync-kv-state error:", err);
    return res.status(500).json({ ok: false, detail: err.message });
  }
}
