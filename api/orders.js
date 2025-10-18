import { withCors } from "./_lib/cors.js";
import { instance, readAccessToken } from "./_lib/kite.js";

export default withCors(async function handler(req, res) {
  const at = readAccessToken(req);
  if (!at) return res.status(401).json({ error: "Not authenticated" });
  const kc = instance(at);
  try {
    const orders = await kc.getOrders();
    res.json(orders);
  } catch (e) {
    res.status(500).json(e);
  }
});
