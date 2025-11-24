import { kv } from "../kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";

export default async function handler(req, res) {
  try {
    let data = await kv.get(SELLBOOK_KEY);
    if (!Array.isArray(data)) data = [];

    data.sort((a, b) => (b.time_ms ?? 0) - (a.time_ms ?? 0));

    const cleaned = data.map(s => ({
      instrument: s.instrument,
      qty: s.qty,
      time: s.time,
      mtm: s.mtm,
      mtm_change: s.mtm_change
    }));

    return res.status(200).json({ ok: true, sellbook: cleaned });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
