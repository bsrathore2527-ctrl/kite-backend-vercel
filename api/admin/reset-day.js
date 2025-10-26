// api/admin/reset-day.js
import { setState, todayKey } from "../_lib/kv.js";

function isAdmin(req){
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res){
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method not allowed" });
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Unauthorized" });

  try {
    const next = await setState({
      tripped_day: false,
      block_new_orders: false,
      consecutive_losses: 0,
      trip_reason: null
    });
    res.json({ ok:true, state: next });
  } catch(e){
    res.status(500).json({ ok:false, error:e.message });
  }
}
