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

    const variety = (req.query.variety || "regular").toString();
    const order_id = (req.query.order_id || req.body?.order_id);
    if (!order_id) return res.status(400).json({ error: "order_id is required" });

    const kc = instance(at);
    const resp = await kc.cancelOrder(variety, order_id.toString());
    return res.json(resp);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || "Cancel failed", details: e });
  }
});
