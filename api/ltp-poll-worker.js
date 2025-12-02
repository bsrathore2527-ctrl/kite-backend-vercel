// api/ltp-poll-worker.js
import { kv } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export const config = {
  runtime: "nodejs20",
};

async function loadTradebookSymbols() {
  try {
    const raw = await kv.get("guardian:tradebook");
    if (!raw) return [];

    let arr = [];
    try { arr = JSON.parse(raw); } catch {}

    const symbols = arr
      .map(t => t.tradingsymbol)
      .filter(Boolean);

    return [...new Set(symbols)];
  } catch (err) {
    console.error("Tradebook load error:", err);
    return [];
  }
}

async function buildInstrumentMap(kc) {
  const exchanges = ["NFO", "NSE", "BSE"];
  const map = {};

  for (const ex of exchanges) {
    try {
      const list = await kc.getInstruments(ex);
      for (const inst of list) {
        map[inst.tradingsymbol] = {
          token: inst.instrument_token,
          exchange: inst.exchange,
        };
      }
    } catch (err) {
      console.error(`Instrument load failed for ${ex}:`, err);
    }
  }

  return map;
}

export default async function handler(req, res) {
  try {
    const kc = await instance(); // uses your access token automatically

    // -----------------------------
    // 1️⃣ FETCH OPEN POSITIONS
    // -----------------------------
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    const posSymbols = net
      .filter(p => p.tradingsymbol)
      .map(p => p.tradingsymbol);

    // -----------------------------
    // 2️⃣ FETCH CLOSED TRADES
    // -----------------------------
    const tradeSymbols = await loadTradebookSymbols();

    // All unique symbols needed
    const allSymbols = [...new Set([...posSymbols, ...tradeSymbols])];

    if (!allSymbols.length) {
      return res.json({ ok: true, message: "No symbols to fetch LTP for." });
    }

    // -----------------------------
    // 3️⃣ RESOLVE INSTRUMENT TOKENS
    // -----------------------------
    const instMap = await buildInstrumentMap(kc);

    const instrumentList = allSymbols
      .map(sym => {
        const inst = instMap[sym];
        if (!inst) return null;
        return {
          tradingsymbol: sym,
          exchange: inst.exchange,
          token: inst.token
        };
      })
      .filter(Boolean);

    if (!instrumentList.length) {
      return res.json({ ok: false, error: "Could not resolve any instrument tokens." });
    }

    // -----------------------------
    // 4️⃣ FETCH QUOTES FOR ALL INSTRUMENTS
    // -----------------------------
    const quoteArgs = instrumentList.map(i => ({
      exchange: i.exchange,
      tradingsymbol: i.tradingsymbol
    }));

    const quotes = await kc.getQuote(quoteArgs);
    const now = Date.now();

    // -----------------------------
    // 5️⃣ WRITE LTP TO KV
    // -----------------------------
    const writeOps = [];
    for (const key in quotes) {
      const q = quotes[key];
      if (!q?.instrument_token) continue;

      writeOps.push(
        kv.set(`ltp:${q.instrument_token}`, {
          token: q.instrument_token,
          tradingsymbol: q.tradingsymbol,
          exchange: q.exchange,
          last_price: q.last_price,
          time: now
        })
      );
    }

    await Promise.allSettled(writeOps);

    return res.json({
      ok: true,
      fetched: instrumentList.length,
      stored: writeOps.length,
      time: new Date(now).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }),
    });

  } catch (err) {
    console.error("LTP Worker Error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
