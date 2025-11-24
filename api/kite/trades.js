import { getState, setState } from "../state.js";
import { kv } from "../kv.js";
import instance from "../kite.js";

const SELLBOOK_KEY = "guardian:sell_orders";

function toIST(ts) {
  try {
    const d = new Date(ts);
    return new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export default async function handler(req, res) {
  try {
    const state = await getState();

    // Try LIVE trades from kite
    let trades = null;
    let live_ok = false;

    try {
      const kc = await instance();
      trades = await kc.getTrades();
      live_ok = true;
    } catch (e) {
      // fallback to KV for UI only
      const raw = await kv.get("guardian:trades_raw");
      trades = Array.isArray(raw) ? raw : [];
      live_ok = false;
    }

    // -------- SELLBOOK WRITER (only if live_ok) ----------
    if (live_ok && Array.isArray(trades)) {
      // Load existing sellbook
      let sellbook = await kv.get(SELLBOOK_KEY);
      if (!Array.isArray(sellbook)) sellbook = [];

      const last = sellbook.length > 0 ? sellbook[0] : null;

      // filter raw SELL trades
      const sellTrades = trades.filter(t => t.transaction_type === "SELL");

      for (const t of sellTrades) {
        const order_id = t.order_id;
        const already = sellbook.find(s => s.order_id === order_id);
        if (already) continue;

        const mtm = state.total_pnl ?? 0;
        const mtm_change = last ? mtm - last.mtm : 0;

        const entry = {
          order_id,
          instrument: t.tradingsymbol,
          qty: t.quantity,
          time: toIST(t.exchange_timestamp),
          mtm,
          mtm_change,
          time_ms: Date.now()
        };

        sellbook.unshift(entry);
      }

      await kv.set(SELLBOOK_KEY, sellbook);
    }

    // -------- GROUPED TRADEBOOK FOR UI --------
    const grouped = {};
    for (const t of trades) {
      const id = t.order_id;
      if (!grouped[id]) {
        grouped[id] = {
          tradingsymbol: t.tradingsymbol,
          quantity: 0,
          transaction_type: t.transaction_type,
          average_price: t.average_price,
          exchange_timestamp: t.exchange_timestamp
        };
      }
      grouped[id].quantity += t.quantity;
    }

    const finalList = Object.values(grouped).map(t => ({
      tradingsymbol: t.tradingsymbol,
      quantity: t.quantity,
      transaction_type: t.transaction_type,
      average_price: t.average_price,
      time: toIST(t.exchange_timestamp)
    }));

    finalList.sort((a, b) => new Date(b.time) - new Date(a.time));

    return res.status(200).json({
      ok: true,
      source: live_ok ? "kite" : "fallback",
      trades: finalList
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
