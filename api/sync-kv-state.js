import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Optional: Risk Engine secret key for safety
const ENGINE_KEY = process.env.RISK_ENGINE_SECRET || null;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-engine-key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, detail: "Method not allowed" });

  try {
    // -----------------------------------------------
    // 1️⃣ ENGINE AUTH (optional but recommended)
    // -----------------------------------------------
    if (ENGINE_KEY) {
      const key = req.headers["x-engine-key"];
      if (key !== ENGINE_KEY) {
        return res.status(401).json({ ok: false, detail: "Invalid engine key" });
      }
    }

    // -----------------------------------------------
    // 2️⃣ Parse incoming JSON
    // -----------------------------------------------
    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", resolve);
    });

    let incoming = {};
    try {
      incoming = JSON.parse(body || "{}");
    } catch (err) {
      return res.status(400).json({ ok: false, detail: "Invalid JSON" });
    }

    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ ok: false, detail: "Empty or invalid state" });
    }

    // -----------------------------------------------
    // 3️⃣ Pipeline read: get previous state
    // -----------------------------------------------
    const pipeline = redis.pipeline();
    pipeline.get("latest_kv_state");
    pipeline.get("guardian:tradebook");
    const [oldState, tradebook] = await pipeline.exec();

    // -----------------------------------------------
    // 4️⃣ Merge logs, mtm logs, resets, enforce logs
    // (Risk engine sends incremental values)
    // -----------------------------------------------
    const prev = oldState || {};

    const merged = {
      ...prev,
      ...incoming,

      // merge arrays safely
      mtm_log: [
        ...(prev.mtm_log ?? []),
        ...(incoming.mtm_log ?? [])
      ],

      config_logs: [
        ...(prev.config_logs ?? []),
        ...(incoming.config_logs ?? [])
      ],

      reset_logs: [
        ...(prev.reset_logs ?? []),
        ...(incoming.reset_logs ?? [])
      ],

      enforce_logs: [
        ...(prev.enforce_logs ?? []),
        ...(incoming.enforce_logs ?? [])
      ],

      connection_logs: [
        ...(prev.connection_logs ?? []),
        ...(incoming.connection_logs ?? [])
      ],

      admin_last_enforce_result:
        incoming.admin_last_enforce_result ?? prev.admin_last_enforce_result ?? null,

      // tradebook stays separate
      last_tradebook_count: Array.isArray(tradebook) ? tradebook.length : 0,

      synced_at: Date.now()
    };

    // -----------------------------------------------
    // 5️⃣ Store the merged state
    // -----------------------------------------------
    await redis.set("latest_kv_state", merged);

    // -----------------------------------------------
    // 6️⃣ Respond OK
    // -----------------------------------------------
    return res.status(200).json({
      ok: true,
      message: "KV sync complete",
      synced_at: merged.synced_at
    });

  } catch (err) {
    console.error("sync-kv-state error:", err);
    return res.status(500).json({ ok: false, detail: err.message });
  }
}
