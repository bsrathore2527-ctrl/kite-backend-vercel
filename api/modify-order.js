import { withCors } from "./_lib/cors.js";
import { instance, readAccessToken } from "./_lib/kite.js";

export default withCors(async function handler(req, res) {
  try {
    if (process.env.KILL_ALL === "1") {
      return res.status(423).json({ error: "Trading disabled (Kill Switch ON)", code: "KILL_SWITCH_ENABLED" });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).end("Method Not Allowed");
    }

    const at = readAccessToken(req);
    if (!at) return res.status(401).json({ error: "Not authenticated" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const {
      order_id,
      variety = "regular",
      quantity,
      price,
      order_type,     // optional change (e.g., LIMIT → MARKET)
      trigger_price,  // for SL/SL-M
      validity,       // DAY/IOC
      disclosed_quantity,
    } = body;

    if (!order_id) return res.status(400).json({ error: "order_id is required" });

    const kc = instance(at);

    const params = {
      quantity: quantity !== undefined ? Number(quantity) : undefined,
      price: price !== undefined ? Number(price) : undefined,
      order_type,
      trigger_price: trigger_price !== undefined ? Number(trigger_price) : undefined,
      validity,
      disclosed_quantity: disclosed_quantity !== undefined ? Number(disclosed_quantity) : undefined,
    };

    const resp = await kc.modifyOrder(variety, order_id.toString(), params);
    return res.json(resp);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || "Modify failed", details: e });
  }
});
