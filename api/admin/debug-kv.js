import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  const raw = await kv.get("guardian:sell_orders");
  return res.status(200).json({
    raw,
    typeof_raw: typeof raw
  });
}
