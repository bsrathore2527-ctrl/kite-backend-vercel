
export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({ok:false,error:"POST only"});
  const { token } = req.body || {};
  if(!token || token!==process.env.ADMIN_TOKEN) return res.status(401).json({ok:false,error:"Unauthorized"});
  return res.json({ok:true});
}

export const config = { api: { bodyParser: true } };
