import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Allowed UI origins
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
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type","x-admin-key");
  // ADMIN SECURITY CHECK
const ADMIN_KEY = process.env.ADMIN_SECRET;
if (!req.headers["x-admin-key"] || req.headers["x-admin-key"] !== ADMIN_KEY) {
  return res.status(401).json({
    ok: false,
    detail: "Unauthorized: invalid admin key"
  });
}


  if (req.method === "OPTIONS") return res.status(200).end();

  // -------------------------------------------------------
  // GET — Load config for UI
  // -------------------------------------------------------
  if (req.method === "GET") {
    try {
      // Pipeline: latest_kv_state only
      const pipeline = redis.pipeline();
      pipeline.get("latest_kv_state");

      const [state] = await pipeline.exec();

      let configState = state;

      // fallback: risk:DATE
      if (!configState) {
        const istrDate = new Date().toLocaleDateString("en-CA", {
          timeZone: "Asia/Kolkata",
        });
        configState = await redis.get(`risk:${istrDate}`) || {};
      }

      if (!configState) {
        return res.status(200).json({
          id: "current_config",
          daily_max_loss: 0,
          daily_max_profit: 0,
          consecutive_loss_limit: 0,
          cooldown_after_loss: 0,
          trailing_profit_enabled: false,
          trailing_profit_step: 0,
          min_loss_to_count: 0,
          allow_new: true,
          updated_at: new Date().toISOString(),
        });
      }

      // Build UI config
      const resp = {
        id: "current_config",

        daily_max_loss: configState.max_loss_abs ?? 0,
        daily_max_profit: configState.max_profit_abs ?? 0,
        consecutive_loss_limit: configState.max_consecutive_losses ?? 0,
        cooldown_after_loss: configState.cooldown_min ?? 0,

        trailing_profit_enabled: (configState.trail_step_profit ?? 0) > 0,
        trailing_profit_step: configState.trail_step_profit ?? 0,

        // extras
        min_loss_to_count: configState.min_loss_to_count ?? 0,
        allow_new: configState.allow_new ?? true,

        updated_at: new Date().toISOString(),
      };

      return res.status(200).json(resp);
    } catch (err) {
      console.error("risk-config GET error:", err);
      return res.status(500).json({ detail: err.message });
    }
  }

  // -------------------------------------------------------
  // PUT — Update UI config into KV
  // -------------------------------------------------------
  if (req.method === "PUT") {
    try {
      let body = "";
      await new Promise((resolve) => {
        req.on("data", (chunk) => (body += chunk));
        req.on("end", resolve);
      });

      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch (err) {
        return res.status(400).json({ detail: "Invalid JSON" });
      }

      // Pipeline GET
      const pipeline = redis.pipeline();
      pipeline.get("latest_kv_state");

      const [state] = await pipeline.exec();

      let configState = state;

      if (!configState) {
        const istrDate = new Date().toLocaleDateString("en-CA", {
          timeZone: "Asia/Kolkata",
        });
        configState = await redis.get(`risk:${istrDate}`) || {};
      }

      if (!configState) configState = {};

      // Update allowed fields
      const updated = {
        ...configState,

        max_loss_abs: data.daily_max_loss,
        max_profit_abs: data.daily_max_profit,
        max_consecutive_losses: data.consecutive_loss_limit,
        cooldown_min: data.cooldown_after_loss,
        trail_step_profit: data.trailing_profit_step,

        // extras
        min_loss_to_count: data.min_loss_to_count ?? configState.min_loss_to_count,
        allow_new: data.allow_new ?? configState.allow_new,
      };

      // Save updated config
      await redis.set("latest_kv_state", updated);

      // Send updated response
      return res.status(200).json({
        id: "current_config",
        ...data,
        updated_at: new Date().toISOString(),
      });

    } catch (err) {
      console.error("risk-config PUT error:", err);
      return res.status(500).json({ detail: err.message });
    }
  }

  return res.status(405).json({ detail: "Method not allowed" });
}
