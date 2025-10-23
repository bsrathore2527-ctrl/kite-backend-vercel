// DEBUG: show masked stored token (temporary)
if (path === "/api/debug/token" && req.method === "GET") {
  const s = await getState();
  const t = s?.access_token || "";
  const masked = t ? (t.slice(0,6) + "…" + t.slice(-6)) : "";
  return ok(res, { has_token: !!t, token_masked: masked });
}

// DEBUG: clear stored token (temporary) — use only to force re-login
if (path === "/api/debug/clear" && req.method === "POST") {
  const s = await getState();
  const next = { ...s }; delete next.access_token;
  await setState(next);
  return ok(res, { cleared: true });
}// api/hub.js
import { loginUrl, generateSession, instance } from "./_lib/kite.js";
import { getState, setState } from "./_lib/state.js";
import { todayKey, IST } from "./_lib/kv.js";

function send(res, code, body) { res.status(code).setHeader("Cache-Control","no-store").json(body); }
const ok = (res, body={}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg="Bad request") => send(res, 400, { ok:false, error: msg });
const unauth = (res) => send(res, 401, { ok:false, error:"Unauthorized" });
const nope = (res) => send(res, 405, { ok:false, error:"Method not allowed" });

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: IST }));
}

function pickEquityFunds(margins) {
  const eq = margins?.equity ?? margins ?? {};
  const avail = eq.available ?? {};
  const balance = Number(
    avail.live_balance ??
    eq.net ??
    avail.cash ??
    eq.cash ??
    eq.balance ??
    0
  );
  return { raw: margins, equity: eq, balance };
}

async function cancelAllPendings(kc){
  try {
    const orders = await kc.getOrders();
    const pend = (orders || []).filter(o => ["OPEN","TRIGGER PENDING","TRIGGERPENDING"].includes((o.status||"").toUpperCase()));
    let canceled = 0;
    for (const o of pend) {
      try {
        if (o.order_id) await kc.cancelOrder(o.variety || "regular", o.order_id);
        else if (o.order_id) await kc.cancelOrder(o.order_id);
        canceled++;
      } catch (e) {}
    }
    return canceled;
  } catch (e) { return 0; }
}

async function exitAllNetPositions(kc){
  try {
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let squared = 0;
    for (const p of net) {
      const qty = Number(p.net_quantity ?? p.quantity ?? 0);
      if (!qty) continue;
      const side = qty > 0 ? "SELL" : "BUY";
      const abs = Math.abs(qty);
      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NSE",
          tradingsymbol: p.tradingsymbol || p.trading_symbol || p.instrument_token,
          transaction_type: side,
          quantity: abs,
          product: p.product || "MIS",
          order_type: "MARKET",
          validity: "DAY"
        });
        squared++;
      } catch (e) {}
    }
    return squared;
  } catch (e) { return 0; }
}

function computeActiveFloor(s) {
  const cap = Number(s.capital_day_915 || 0);
  const maxPct = s.max_loss_pct ?? 10;
  const step = s.trail_step_profit ?? 5000;
  const realised = Number(s.realised || 0);
  const baseFloor = -(cap * (maxPct/100));
  const steps = Math.max(0, Math.floor(Math.max(0, realised) / step));
  const trailFloor = -(steps * step);
  return Math.max(baseFloor, trailFloor);
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;

    // ---------- KITE login start ----------
    // TEMP debug login route — replace original /api/login block
if (path === "/api/login" && req.method === "GET") {
  try {
    const urlStr = loginUrl(); // generate the Zerodha login URL
    // return as JSON so we can inspect it directly (temporary)
    return ok(res, { login_url: urlStr });
  } catch (e) {
    console.error("LOGIN URL ERR", e);
    return bad(res, e.message || "Login init failed");
  }
}

    // ---------- KITE callback ----------
    if (path === "/api/callback" && req.method === "GET") {
      try {
        const params = url.searchParams;
        const request_token = params.get("request_token");
        console.log("CALLBACK HIT:", { request_token, search: url.search });
        if (!request_token) {
          console.warn("Missing request_token in callback:", url.href);
          const redirectTo = (process.env.POST_LOGIN_REDIRECT || "/admin.html") + "?kite=missing_request_token";
          res.writeHead(302, { Location: redirectTo });
          res.end();
          return;
        }
        const data = await generateSession(request_token);
        console.log("GENERATE SESSION:", { ok: !!data?.access_token });
        const redirectTo = process.env.POST_LOGIN_REDIRECT || "/admin.html";
        res.writeHead(302, { Location: redirectTo });
        res.end();
      } catch (e) {
        console.error("CALLBACK ERROR:", e);
        return bad(res, e.message || "Auth failed");
      }
      return;
    }

    // ---------- STATE (public) ----------
    if (path === "/api/state" && req.method === "GET") {
      try {
        const admin = isAdmin(req);
        const s = await getState();
        const safe = {
          capital_day_915: s.capital_day_915 || 0,
          realised: s.realised || 0,
          unrealised: s.unrealised || 0,
          current_balance: s.current_balance || 0,
          tripped_day: !!s.tripped_day,
          tripped_week: !!s.tripped_week,
          tripped_month: !!s.tripped_month,
          block_new_orders: !!s.block_new_orders,
          consecutive_losses: s.consecutive_losses || 0,
          cooldown_until: s.cooldown_until || 0,
          profit_lock_10: !!s.profit_lock_10,
          profit_lock_20: !!s.profit_lock_20,
          expiry_flag: !!s.expiry_flag,
          max_loss_pct: s.max_loss_pct ?? 10,
          trail_step_profit: s.trail_step_profit ?? 5000,
          cooldown_min: s.cooldown_min ?? 15,
          max_consecutive_losses: s.max_consecutive_losses ?? 3,
          allow_new_after_lock10: s.allow_new_after_lock10 ?? false,
          week_max_loss_pct: s.week_max_loss_pct ?? null,
          month_max_loss_pct: s.month_max_loss_pct ?? null
        };
        const now = new Date().toLocaleTimeString("en-IN", { timeZone: IST, hour12: false });
        // check kite connectivity
        let kite_ok = "";
        try {
          const kc = await instance();
          kite_ok = "ok";
        } catch (e) {
          kite_ok = "";
        }
        return ok(res, { time: now, admin, kite_status: kite_ok, state: safe, key: todayKey() });
      } catch (e) {
        console.error("STATE ERR", e); return bad(res, e.message || String(e));
      }
    }

    // ---------- KITE proxy routes ----------
    if (path.startsWith("/api/kite/")) {
      const seg = path.replace("/api/kite/", "");
      let kc;
      try { kc = await instance(); } catch (e) { return bad(res, "Invalid api_key or access_token."); }

      if (req.method === "GET" && seg === "funds") {
        try {
          const m = await (kc.getMargins?.() ?? kc.margins?.());
          const picked = pickEquityFunds(m || {});
          return ok(res, { funds: picked.equity, balance: picked.balance });
        } catch (e) { return bad(res, e.message || "Funds fetch failed"); }
      }

      if (req.method === "GET" && seg === "positions") {
        try { const p = await kc.getPositions(); return ok(res, { positions: p }); } catch (e) { return bad(res, e.message || "Positions failed"); }
      }

      if (req.method === "GET" && seg === "orders") {
        try { const o = await kc.getOrders(); return ok(res, { orders: o }); } catch (e) { return bad(res, e.message || "Orders failed"); }
      }

      if (req.method === "GET" && seg === "profile") {
        try { const p = await kc.getProfile?.(); return ok(res, { profile: p || true }); } catch (e) { return bad(res, e.message || "Profile failed"); }
      }

      if (req.method === "POST" && seg === "cancel-all") {
        if (!isAdmin(req)) return unauth(res);
        const canceled = await cancelAllPendings(kc);
        return ok(res, { canceled });
      }

      if (req.method === "POST" && seg === "exit-all") {
        if (!isAdmin(req)) return unauth(res);
        await setState({ tripped_day:true, block_new_orders:true });
        try {
          const c = await cancelAllPendings(kc);
          const sres = await exitAllNetPositions(kc);
          return ok(res, { canceled: c, squared_off: sres });
        } catch (e) {
          return ok(res, { message: "Day killed flag set. Could not reach kite to enforce." });
        }
      }

      return nope(res);
    }

    // ---------- ADMIN routes ----------
    if (path.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return unauth(res);
      const seg = path.replace("/api/admin/", "");
      const cur = await getState();

      if (req.method === "POST" && seg === "rules-set") {
        const b = req.body || await (async ()=>{ try{ const buf = await new Promise(r=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(Buffer.from(d))); }); return JSON.parse(buf.toString()); }catch{return {}; } })();
        const next = { ...cur };
        ["max_loss_pct","trail_step_profit","cooldown_min","max_consecutive_losses","allow_new_after_lock10","expiry_flag","week_max_loss_pct","month_max_loss_pct"].forEach(k => { if (b[k] !== undefined) next[k] = b[k]; });
        await setState(next);
        return ok(res, { saved:true });
      }

      if (req.method === "POST" && seg === "kill") {
        await setState({ tripped_day:true, block_new_orders:true });
        try {
          const kc = await instance();
          const canceled = await cancelAllPendings(kc);
          const squared = await exitAllNetPositions(kc);
          return ok(res, { message:"Day killed. New orders blocked. Auto-enforcement executed.", canceled, squared });
        } catch (e) {
          return ok(res, { message:"Day killed flag set. Could not reach kite to enforce." });
        }
      }

      if (req.method === "POST" && seg === "unlock") {
        const next = { ...cur, block_new_orders:false, tripped_day:false };
        await setState(next);
        return ok(res, { message:"New orders allowed (per rules)." });
      }

      return nope(res);
    }

    // ---------- GUARDIAN cron ----------
    if (path === "/api/guardian") {
      try {
        const s = await getState();
        try {
          if (s.block_new_orders) {
            try { const kc = await instance(); await cancelAllPendings(kc); } catch {}
          }
        } catch {}
        try {
          const kc = await instance();
          const m = await (kc.getMargins?.() ?? kc.margins?.());
          const { balance } = pickEquityFunds(m || {});
          if (balance > 0) { await setState({ current_balance: balance }); }
          if (!s.capital_day_915) {
            const now = istNow();
            const h = now.getHours(), min = now.getMinutes();
            const after915 = (h > 9) || (h === 9 && min >= 15);
            if (after915 && balance > 0) { await setState({ capital_day_915: balance }); }
          }
          const unreal = await (async ()=>{ try{ const p = await kc.getPositions(); const net = p?.net || []; return net.reduce((a,x)=>a + Number(x.pnl||0),0); }catch{return 0;} })();
          const curState = await getState();
          const realised = Number(curState.realised || 0);
          const totalPnL = realised + Number(unreal || 0);
          const floor = computeActiveFloor(curState);
          if (totalPnL <= floor) {
            try {
              await setState({ tripped_day:true, block_new_orders:true });
              await cancelAllPendings(kc);
              await exitAllNetPositions(kc);
            } catch(e){}
            return ok(res, { tick: new Date().toISOString(), breached:true, floor, totalPnL });
          }
          await setState({ unrealised: unreal });
          return ok(res, { tick: new Date().toISOString(), breached:false, floor, totalPnL });
        } catch (e) {
          return ok(res, { tick: new Date().toISOString(), note:"kite not connected", error: e.message });
        }
      } catch (e) { return bad(res, e.message || String(e)); }
    }

    // ---------- ENFORCE ----------
    if (path === "/api/enforce") {
      try {
        const state = await getState();
        const kc = await instance();
        let canceled=0, squared=0;
        try {
          const orders = await kc.getOrders();
          const open = (orders||[]).filter(o => ["OPEN","TRIGGER PENDING","TRIGGERPENDING"].includes((o.status||"").toUpperCase()));
          for (const o of open) {
            try { if (o.order_id) { await kc.cancelOrder(o.variety || "regular", o.order_id); canceled++; } } catch {}
          }
        } catch {}
        if (state.block_new_orders || state.tripped_day) {
          try {
            const pos = await kc.getPositions();
            const net = pos?.net || [];
            for (const p of net) {
              const q = Number(p.net_quantity || 0);
              if (!q) continue;
              const side = q > 0 ? "SELL" : "BUY";
              try {
                await kc.placeOrder("regular", {
                  exchange: p.exchange || "NSE",
                  tradingsymbol: p.tradingsymbol || p.trading_symbol,
                  transaction_type: side,
                  quantity: Math.abs(q),
                  order_type: "MARKET",
                  product: p.product || "MIS",
                  variety: "regular"
                });
                squared++;
              } catch(e){}
            }
          } catch(e){}
        }
        const cur = await getState();
        const realised = Number(cur.realised || 0);
        const now = Date.now();
        if (realised < 0 && !cur.cooldown_until) {
          const COOLDOWN_MIN = cur.cooldown_min ?? 15;
          cur.cooldown_until = now + COOLDOWN_MIN * 60 * 1000;
          cur.block_new_orders = true;
          await setState(cur);
        } else if (cur.cooldown_until && now > cur.cooldown_until) {
          cur.cooldown_until = 0; cur.block_new_orders = false; await setState(cur);
        }
        return ok(res, { canceled, squared, cooldown_until: cur.cooldown_until || 0, block_new_orders: !!cur.block_new_orders });
      } catch (e) { return bad(res, e.message || String(e)); }
    }

    // unknown
    return send(res, 404, { ok:false, error:"Unknown route" });
  } catch (e) {
    console.error("HUB ERR", e);
    return send(res, 500, { ok:false, error: e.message || String(e) });
  }
    }
