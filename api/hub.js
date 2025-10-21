// api/hub.js
import { instance } from "./_lib/kite.js";
import { getState, setState } from "./_lib/state.js";
import { todayKey, IST } from "./_lib/kv.js";

function send(res, code, body) { res.status(code).setHeader("Cache-Control","no-store").json(body); }
const ok   = (res, body={}) => send(res, 200, { ok: true, ...body });
const bad  = (res, msg="Bad request") => send(res, 400, { ok:false, error: msg });
const unauth = (res) => send(res, 401, { ok:false, error:"Unauthorized" });
const nope = (res) => send(res, 405, { ok:false, error:"Method not allowed" });

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

async function kite() { return await instance(); }
function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: IST }));
}

// ---- Robust funds parser (works across Zerodha payload variants)
function pickEquityFunds(margins) {
  // Zerodha returns { equity: { available: { cash, live_balance, ... }, net, cash, balance, ... } }
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

// ---------- helpers ----------
async function getOrdersSafe(kc){ try{ return await kc.getOrders(); }catch{ return []; } }

async function cancelAllPendings(kc){
  const orders = await getOrdersSafe(kc);
  const pend = orders.filter(o => ["OPEN","TRIGGER PENDING"].includes(o.status));
  let canceled = 0;
  for (const o of pend) {
    try {
      try { await kc.cancelOrder(o.variety || "regular", o.order_id); }
      catch { await kc.cancelOrder(o.order_id, o.variety || "regular"); }
      canceled++;
    } catch {}
  }
  return canceled;
}

async function exitAllNetPositions(kc){
  const pos = await kc.getPositions(); // {net:[]}
  const net = pos?.net || [];
  let squared = 0;
  for (const p of net) {
    const qty = Number(p.quantity ?? p.net_quantity ?? 0);
    if (!qty) continue;
    const side = qty > 0 ? "SELL" : "BUY";
    const absQty = Math.abs(qty);
    try {
      await kc.placeOrder("regular", {
        exchange: p.exchange || "NSE",
        tradingsymbol: p.tradingsymbol,
        transaction_type: side,
        quantity: absQty,
        product: p.product || "MIS",
        order_type: "MARKET",
        validity: "DAY"
      });
      squared++;
    } catch {}
  }
  return squared;
}

async function getLiveMtm(kc){
  try {
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    return net.reduce((a,p)=> a + Number(p.pnl || 0), 0);
  } catch { return 0; }
}

function computeActiveFloor(s){
  const cap = Number(s.capital_day_915 || 0);
  const maxPct = s.max_loss_pct ?? 10;
  const step = s.trail_step_profit ?? 5000;
  const realised = Number(s.realised || 0);
  const baseFloor = -(cap * (maxPct/100));
  const steps = Math.max(0, Math.floor(Math.max(0, realised) / step));
  const trailFloor = -(steps * step);
  return Math.max(baseFloor, trailFloor); // negative
}

async function enforceShutdown(kc, reason = "limit"){
  const key = `risk:${todayKey()}`;
  const guardKey = `${key}:enforcing`;
  if (await kv.get(guardKey)) return { skipped:true, reason:"in_progress" };
  await kv.set(guardKey, Date.now(), { ex: 60 }); // 60s guard

  try {
    const canceled = await cancelAllPendings(kc);
    const squared_off = await exitAllNetPositions(kc);
    const s = await getState();
    s.tripped_day = true;
    s.block_new_orders = true;
    s.last_enforce_at = Date.now();
    s.last_enforce_reason = reason;
    await setState(s);
    return { canceled, squared_off };
  } finally {
    // guard auto-expires
  }
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;

    // KITE group (live calls)
    if (path.startsWith("/api/kite/")) {
      const seg = path.replace("/api/kite/", "");
      const kc = await kite();

      if (req.method === "GET" && seg === "funds") {
        try {
          const m = await (kc.getMargins?.() ?? kc.margins?.());
          const { balance, equity } = pickEquityFunds(m);
          return ok(res, { funds: equity, balance });
        } catch (e) { return bad(res, e.message || "Funds fetch failed"); }
      }

      if (req.method === "GET" && seg === "positions") {
        const p = await kc.getPositions();
        return ok(res, { positions: p });
      }

      if (req.method === "GET" && seg === "orders") {
        const o = await kc.getOrders();
        return ok(res, { orders: o });
      }

      if (req.method === "GET" && seg === "profile") {
        try {
          const prof = await kc.getProfile?.();
          return ok(res, { profile: prof || true });
        } catch (e) { return bad(res, e.message || "Profile fetch failed"); }
      }

      if (req.method === "POST" && seg === "cancel-all") {
        if (!isAdmin(req)) return unauth(res);
        const canceled = await cancelAllPendings(kc);
        return ok(res, { canceled });
      }

      if (req.method === "POST" && seg === "exit-all") {
        if (!isAdmin(req)) return unauth(res);
        const resu = await enforceShutdown(kc, "manual_exit_all");
        return ok(res, resu);
      }

      return nope(res);
    }

    // ADMIN group
    if (path.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return unauth(res);
      const seg = path.replace("/api/admin/", "");
      const cur = await getState();

      if (req.method === "POST" && seg === "rules-set") {
        const b = req.body || {};
        const next = { ...cur };
        [
          "max_loss_pct","trail_step_profit","cooldown_min",
          "max_consecutive_losses","allow_new_after_lock10",
          "expiry_flag","week_max_loss_pct","month_max_loss_pct"
        ].forEach(k => { if (b[k] !== undefined) next[k] = b[k]; });
        await setState(next);
        return ok(res, { saved:true });
      }

      if (req.method === "POST" && seg === "kill") {
        await setState({ tripped_day:true, block_new_orders:true });
        const kc = await kite();
        const resu = await enforceShutdown(kc, "kill");
        return ok(res, { message:"Day killed. New orders blocked. Auto-enforcement executed.", ...resu });
      }

      if (req.method === "POST" && seg === "unlock") {
        const next = { ...cur, block_new_orders:false, tripped_day:false };
        await setState(next);
        return ok(res, { message:"New orders allowed (per rules)." });
      }

      return nope(res);
    }

    // GUARDIAN cron — auto-capture capital @ 09:15 IST; cache current balance; enforce daily loss
    if (path === "/api/guardian") {
      const s = await getState();
      const now = istNow();

      // 1) Police revenge orders if blocked
      try {
        if (s.block_new_orders) {
          const kc = await kite();
          await cancelAllPendings(kc);
        }
      } catch {}

      try {
        const kc = await kite();

        // 2) Cache current balance + auto set capital at first valid tick ≥ 09:15
        try {
          const m = await (kc.getMargins?.() ?? kc.margins?.());
          const { balance } = pickEquityFunds(m);
          if (balance > 0) {
            await setState({ current_balance: balance });
          }
          if (!s.capital_day_915) {
            const hour = now.getHours(), min = now.getMinutes();
            const after915 = (hour > 9) || (hour === 9 && min >= 15);
            if (after915 && balance > 0) {
              await setState({ capital_day_915: balance });
            }
          }
        } catch {}

        // 3) Daily loss enforcement (no profit-lock enforcement)
        const unreal = await getLiveMtm(kc);
        const realised = Number((await getState()).realised || 0); // re-read
        const totalPnL = realised + unreal;
        const floor = computeActiveFloor(await getState());

        if (totalPnL <= floor) {
          const resu = await enforceShutdown(kc, "daily_loss");
          return ok(res, { tick: now.toISOString(), breached:true, floor, totalPnL, ...resu });
        }

        await setState({ unrealised: unreal });
        return ok(res, { tick: now.toISOString(), breached:false, floor, totalPnL });
      } catch (e) {
        // Not logged in: still tick; UI will use cached current_balance/unrealised
        return ok(res, { tick: now.toISOString(), note:"kite not connected or error", error: e.message });
      }
    }

    return bad(res, "Unknown route");
  } catch (e) {
    return send(res, 500, { ok:false, error: e.message || String(e) });
  }
}
