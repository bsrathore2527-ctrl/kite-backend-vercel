
import { kv } from "../_lib/kv.js";

export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({ok:false,error:"POST only"});
  const token=req.headers["x-admin-token"];
  if(!token || token!==process.env.ADMIN_TOKEN) return res.status(401).json({ok:false,error:"Unauthorized"});
  try{
    const { user_id, days } = req.body;
    let profile = await kv.get(`user:${user_id}`);
    if(!profile) return res.json({ok:false,error:"User not exist"});
    const ms = days*86400000;
    profile.valid_until = profile.valid_until + ms;
    profile.active = true;
    await kv.set(`user:${user_id}`, profile);
    return res.json({ok:true});
  }catch(e){
    return res.status(500).json({ok:false,error:e.toString()});
  }
}

export const config = { api: { bodyParser: true } };
