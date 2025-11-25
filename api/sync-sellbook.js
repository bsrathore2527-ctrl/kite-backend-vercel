// api/sync-sellbook.js
// Build SELLBOOK from KV tradebook:
// - group partial fills by trade_id
// - only today's sells (IST)
// - use same ts basis as tradebook
// - attach current MTM and MTM-change

import { kv } from "./_lib/kv.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";

// Get IST calendar date string for a given ms
function istDate(ms) {
  return new Date(ms).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata"
  });
}

export default async function handler(req, res) {
  try {
    // 1) Load tradebook from KV
    let trades = [];
    try {
      const raw = await kv.get(TRADEBOOK_KEY);
      if (Array.isArray(raw)) {
        trades = raw;
      } else if (typeof raw === "string") {
        trades = JSON.parse(raw || "[]");
      } else {
        trades = [];
      }
    } catch {
      trades = [];
    }

    if (!Array.isArray(trades)) trades = [];

    // 2) Get today's IST date
    const todayIST = istDate(Date.now());

    // 3) Load current MTM from state (total_pnl)
    let currentMTM = 0;
    try {
      const s = await kv.get("guardian:state");
      if (s) {
        const state = typeof s === "string" ? JSON.parse(s) : s;
        currentMTM = Number(state.total_pnl ?? 0) || 0;
      }
    } catch {
      currentMTM = 0;
    }

    // 4) Group SELL trades by trade_id using tradebook structure
    const groupedMap = new Map();

    for (const t of trades) {
      const side = (t.side || "").toUpperCase();
      if (side !== "SELL") continue;

      // trade_id is the grouping key (same as tradebook)
      const tradeId = t.trade_id || t.tradeId || null;
      const key =
        tradeId ||
        `${t.tradingsymbol || ""}_${t.ts || ""}`; // fallback if trade_id missing

      const qty = Number(t.qty || t.quantity || 0);
      const price = Number(t.price || 0);
      const ts = Number(t.ts || Date.now());
      const iso = t.iso_date || new Date(ts).toISOString();
      const instrument = t.tradingsymbol || t.symbol || t.instrument || "";

      if (!groupedMap.has(key)) {
        groupedMap.set(key, {
          trade_id: tradeId,
          instrument,
          qty,
          weighted_sum: qty * price,
          last_ts: ts,
          last_iso: iso
        });
      } else {
        const g = groupedMap.get(key);
        g.qty += qty;
        g.weighted_sum += qty * price;
        if (ts > g.last_ts) {
          g.last_ts = ts;
          g.last_iso = iso;
        }
      }
    }

    // 5) Convert grouped map -> grouped sells
    const groupedSells = Array.from(groupedMap.values()).map((g) => {
      const avgPrice =
        g.qty && Number.isFinite(g.weighted_sum / g.qty)
          ? g.weighted_sum / g.qty
          : 0;
      return {
        trade_id: g.trade_id,
        instrument: g.instrument,
        qty: g.qty,
        price: avgPrice,
        time_ms: g.last_ts,
        iso: g.last_iso
      };
    });

    // 6) Filter to today's trades only (IST)
    const todaysSells = groupedSells.filter(
      (g) => istDate(g.time_ms) === todayIST
    );

    // 7) Load existing sellbook from KV
    let sellArr = [];
    try {
      const rawSell = await kv.get(SELLBOOK_KEY);
      if (Array.isArray(rawSell)) {
        sellArr = rawSell;
      } else if (typeof rawSell === "string") {
        sellArr = JSON.parse(rawSell || "[]");
      } else {
        sellArr = [];
      }
    } catch {
      sellArr = [];
    }
    if (!Array.isArray(sellArr)) sellArr = [];

    // 8) Append today's grouped sells, avoid duplicates
    for (const g of todaysSells) {
      const exists = sellArr.some(
        (x) => x.trade_id && g.trade_id && x.trade_id === g.trade_id
      );
      if (exists) continue;

      const last = sellArr.length > 0 ? sellArr[sellArr.length - 1] : null;
      const lastMtm = last ? Number(last.mtm || 0) : 0;

      sellArr.push({
        instrument: g.instrument,
        qty: g.qty,
        price: Number(g.price || 0),
        mtm: currentMTM,
        mtm_change: currentMTM - lastMtm,
        trade_id: g.trade_id,
        time_ms: g.time_ms, // same base as tradebook ts
        iso: g.iso
      });
    }

    // 9) Save back to KV
    await kv.set(SELLBOOK_KEY, sellArr);

    return res.status(200).json({
      ok: true,
      count: sellArr.length,
      sellbook: sellArr
    });
  } catch (err) {
    console.error("sync-sellbook error:", err);
    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
}
