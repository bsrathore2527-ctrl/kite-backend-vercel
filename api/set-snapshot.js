import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    await kv.set("snapshot:NIFTY25D0925500PE", {
      qty: 75,
      close_price: 9.85,
      token: 10707970,
    });

    await kv.set("snapshot:date", new Date().toISOString().slice(0, 10));

    return res.json({ ok: true, msg: "Snapshot written!" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
