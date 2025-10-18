import { withCors } from "./_lib/cors.js";
import { instance, readAccessToken } from "./_lib/kite.js";

export default withCors(async function handler(req, res) {
  const at = readAccessToken(req);
  if (!at) return res.status(401).json({ error: "Not authenticated" });
  const kc = instance(at);
  try {
    const { net = [] } = await kc.getPositions();
    const sum = (a, b) => a + (Number(b.pnl) || Number(b.unrealised) || 0);
    const realised = net.reduce((acc, p) => acc + (Number(p.realised) || 0), 0);
    const unrealised = net.reduce((acc, p) => acc + (Number(p.unrealised) || 0), 0);
    const pnl = net.reduce(sum, 0) || realised + unrealised;
    res.json({ pnl, realised, unrealised, count: net.length });
  } catch (e) {
    res.status(500).json(e);
  }
});
