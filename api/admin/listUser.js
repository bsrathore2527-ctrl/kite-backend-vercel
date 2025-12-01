
import { kv } from "../_lib/kv.js";

export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({ok:false,error:"POST only"});
  const token=req.headers["x-admin-token"];
  if(!token || token!==process.env.ADMIN_TOKEN) return res.status(401).json({ok:false,error:"Unauthorized"});
  try{
    const list = await kv.get("users:list") || [];
    const users=[];
    for(const id of list){
      const profile = await kv.get(`user:${id}`) || null;
      users.push({id, profile});
    }
    return res.json({ok:true, users});
  }catch(e){
    return res.status(500).json({ok:false,error:e.toString()});
  }
}

export const config = { api: { bodyParser: true } };
