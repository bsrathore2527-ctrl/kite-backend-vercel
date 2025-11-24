// api/kite/trades.js
// Returns today's trades — grouped by order_id, stores sell MTM.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";

// local live mtm getter
async function getLiveM2M() {
  try {
    const raw = await kv.get("guardian:state");
    if (!raw) return 0;
    const obj = JSON.parse(raw);
    const s = obj.state || obj;
    const v = Number(s.unrealised ?? 0);
    return isNaN(v) ? 0 : v;
  } catch {
    return 0;
  }
}

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function toNumberOrNull(v) {
  const n=Number(v); return Number.isFinite(n)?n:null;
}

function normalizeTsToMs(ts){
  if(ts==null) return null;
  if(typeof ts==="number"){
    if(String(Math.trunc(ts)).length===10) return ts*1000;
    return ts;
  }
  const s=String(ts).trim();
  if(/^\d+$/.test(s)){
    const n=Number(s);
    if(String(Math.trunc(n)).length===10) return n*1000;
    return n;
  }
  const p=Date.parse(s);
  return isNaN(p)?null:p;
}

function normalizeTrade(t){
  if(!t) return t;
  const out={...t};
  const cands=[out.avg_price,out.average_price,out.trade_price,out.price,out.last_price];
  let price=null;
  for(const c of cands){ const n=toNumberOrNull(c); if(n){ price=n; break; } }
  out.price_normalized=price;

  const ts= out._ts||out.trade_time||out.timestamp||out.exchange_timestamp||out.order_timestamp||out.created_at;
  const ms=normalizeTsToMs(ts);
  out._ts=ms||null;
  out._iso= out._ts? new Date(out._ts).toISOString():null;
  return out;
}

function groupTradesByOrderId(trades){
  const map=new Map();
  for(const t of trades){
    const oid=t.order_id||t.orderid||t.order||"UNKNOWN";
    const qty=Number(t.quantity)||0;
    const px=Number(t.price_normalized)||0;
    if(!map.has(oid)){
      map.set(oid,{
        order_id:oid,
        tradingsymbol:t.tradingsymbol,
        transaction_type:t.transaction_type,
        quantity:qty,
        weighted_price_sum:qty*px,
        _ts:t._ts,
        _iso:t._iso
      });
    } else {
      const e=map.get(oid);
      e.quantity+=qty;
      e.weighted_price_sum+=qty*px;
      if(t._ts>e._ts){ e._ts=t._ts; e._iso=t._iso; }
    }
  }
  return Array.from(map.values()).map(e=>{
    e.avg_price = e.quantity? e.weighted_price_sum/e.quantity : null;
    delete e.weighted_price_sum;
    return e;
  });
}

async function storeSellOrder(trade){
  try{
    const raw=await kv.get(SELLBOOK_KEY);
    let arr=[];
    try{ arr=JSON.parse(raw||"[]"); }catch{}
    if(arr.some(e=> e.order_id===trade.order_id)) return;

    const mtm=await getLiveM2M();
    const last=arr[arr.length-1];
    const change= last? mtm-last.mtm:0;

    arr.push({
      order_id:trade.order_id,
      instrument:trade.tradingsymbol,
      time:trade.exchange_timestamp||new Date().toISOString(),
      mtm, change
    });
    await kv.set(SELLBOOK_KEY, JSON.stringify(arr));
  }catch(e){ console.error("storeSellOrder",e); }
}

export default async function handler(req,res){
  try{
    if(isAdmin(req)&&req.query?.raw==="1"){
      const raw=await kv.get(TRADEBOOK_KEY)||"[]";
      let arr=[]; try{arr=JSON.parse(raw);}catch{}
      return res.status(200).json({ok:true, source:"kv", raw:true, trades:arr});
    }

    try{
      const raw=await kv.get(TRADEBOOK_KEY)||"[]";
      let arr=[]; try{arr=JSON.parse(raw);}catch{}
      if(arr.length){
        const norm=arr.slice(-200).map(normalizeTrade);
        const grouped=groupTradesByOrderId(norm);
        return res.status(200).json({ok:true, source:"kv", trades:grouped});
      }
    }catch(e){}

    try{
      const kc=await instance();
      const trades=await kc.getTrades()||[];
      if(trades.length){
        const norm=trades.slice(-200).map(normalizeTrade);
        const grouped=groupTradesByOrderId(norm);

        for (const g of grouped) {
          if (g.transaction_type === "SELL") {
            await storeSellOrder({ order_id: g.order_id, quantity: g.quantity, tradingsymbol: g.tradingsymbol, _ts: g._ts });
          }
        }
        }

        return res.status(200).json({ok:true, source:"kite", trades:grouped});
      }
    }catch(e){}

    return res.status(200).json({ok:true, source:"empty", trades:[]});
  }catch(err){
    return res.status(500).json({ok:false, error:String(err)});
  }
}
