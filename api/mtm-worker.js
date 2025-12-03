// ===========================================
//         Zerodha-style MTM WORKER
//          (Vercel Cron endpoint)
// ===========================================

const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ------------------------
// Helpers
// ------------------------
function safeParse(obj) {
  if (!obj) return {};
  if (typeof obj === "object") return obj;
  try {
    return JSON.parse(obj);
  } catch {
    return {};
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateStrUTC(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate()
  )}`;
}

async function kvGet(key) {
  try {
    const res = await fetch(`${KV_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    }).then((r) => r.json());

    return res?.result ?? null;
  } catch (err) {
    console.log(`❌ KV GET error for ${key}:`, err);
    return null;
  }
}

async function kvSet(key, value) {
  try {
    return fetch(`${KV_URL}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    }).then((r) => r.json());
  } catch (err) {
    console.log(`❌ KV SET error for ${key}:`, err);
  }
}

async function getLTP(token) {
  const data = await kvGet(`ltp:${token}`);
  return data?.last_price ?? null;
}

// FIFO realised on baseline blocks
function fifoReduce(blocks, sellQty, sellPrice) {
  let realised = 0;

  for (const block of blocks) {
    if (sellQty <= 0) break;
    if (block.qty <= 0) continue;

    const closing = Math.min(block.qty, sellQty);
    realised += (sellPrice - block.price) * closing;

    block.qty -= closing;
    sellQty -= closing;
  }

  return {
    realised,
    blocks: blocks.filter((b) => b.qty > 0),
  };
}

// ===========================================
//              MTM ENGINE
// ===========================================
async function computeMTM() {
  console.log("📊 MTM worker (Zerodha mode) starting...");

  // --- today (UTC date; for NSE hours this matches IST date) ---
  const now = new Date();
  const todayStr = dateStrUTC(now);

  // --- tradebook (may be string or array) ---
  let tbRaw = await kvGet("guardian:tradebook");
  let tradebook = tbRaw;
  if (typeof tbRaw === "string") {
    try {
      tradebook = JSON.parse(tbRaw);
    } catch {
      tradebook = [];
    }
  }
  if (!Array.isArray(tradebook)) tradebook = [];

  // --- positions (for overnight open qty) ---
  const positions = safeParse(await kvGet("guardian:positions"));

  // --- baselines + meta (for per-day reset) ---
  let baselinesRaw = await kvGet("guardian:baselines");
  let baselines = safeParse(baselinesRaw);

  let metaRaw = await kvGet("guardian:mtm_meta");
  let meta = safeParse(metaRaw);

  // RESET on new day (Zerodha-style new MTM day)
  if (!meta.date || meta.date !== todayStr) {
    console.log("🔁 New MTM day detected. Resetting baselines & PnL.");
    baselines = {};
    meta = { date: todayStr };
  }

  // --------------------------------------------------
  // 1️⃣ Build set of tokens that have trades TODAY
  // --------------------------------------------------
  const tradesToday = [];
  const tokensWithTradesToday = new Set();

  for (const t of tradebook) {
    const raw = t.raw || {};
    const timeStr =
      raw.exchange_timestamp || raw.fill_timestamp || t.iso_date || null;

    let d = null;
    if (timeStr) {
      d = new Date(timeStr);
    } else if (t.ts) {
      d = new Date(Number(t.ts));
    }

    if (!d) continue;

    const dStr = dateStrUTC(d);
    if (dStr !== todayStr) continue; // ignore previous days

    const token = raw.instrument_token;
    if (!token) continue;

    tradesToday.push(t);
    tokensWithTradesToday.add(token);
  }

  console.log(
    "📅 Trades today:",
    tradesToday.length,
    "Tokens:",
    [...tokensWithTradesToday]
  );

  let realised = 0;
  let unrealised = 0;

  // --------------------------------------------------
  // 2️⃣ Overnight baselines at 9:15 LTP
  //    Only for tokens with NO trades today
  // --------------------------------------------------
  if (positions && Array.isArray(positions.net)) {
    for (const p of positions.net) {
      const token = p.instrument_token;
      const qty = p.quantity;

      if (!token || !qty) continue;

      // Skip if any trade for this token today (pure intraday)
      if (tokensWithTradesToday.has(token)) continue;

      // Only set baseline if not already set for today
      if (!baselines[token] || baselines[token].length === 0) {
        const ltp = await getLTP(token); // should be near 9:15 on first run
        if (ltp != null) {
          baselines[token] = [
            { qty, price: ltp, type: "overnight" }, // Zerodha-style reset
          ];
          console.log(
            "🌅 Overnight baseline set",
            token,
            "qty",
            qty,
            "price",
            ltp
          );
        }
      }
    }
  }

  // --------------------------------------------------
  // 3️⃣ Process TODAY's trades (FIFO realised)
  // --------------------------------------------------
  for (const t of tradesToday) {
    const raw = t.raw || {};
    const token = raw.instrument_token;
    const qty = raw.quantity;
    const execPrice = raw.average_price;
    const isBuy = raw.transaction_type === "BUY";

    if (!token || !qty) continue;

    if (!baselines[token]) baselines[token] = [];

    if (isBuy) {
      // New intraday block
      baselines[token].push({
        qty,
        price: execPrice,
        type: "intraday",
      });
    } else {
      // SELL → realised only for TODAY (blocks are only overnight+today)
      const result = fifoReduce(baselines[token], qty, execPrice);
      realised += result.realised;
      baselines[token] = result.blocks;
    }
  }

  // --------------------------------------------------
  // 4️⃣ Unrealised PnL on OPEN qty using today's baselines
  // --------------------------------------------------
  for (const token of Object.keys(baselines)) {
    const ltp = await getLTP(token);
    if (ltp == null) continue;

    for (const block of baselines[token]) {
      if (block.qty > 0) {
        unrealised += (ltp - block.price) * block.qty;
      }
    }
  }

  const total_pnl = realised + unrealised;

  // --------------------------------------------------
  // 5️⃣ Save baselines + meta + state
  // --------------------------------------------------
  await kvSet("guardian:baselines", baselines);
  await kvSet("guardian:mtm_meta", meta);

  const rawState = await kvGet("guardian:state");
  let state = safeParse(rawState);

  state.realised = realised;
  state.unrealised = unrealised;
  state.total_pnl = total_pnl;

  await kvSet("guardian:state", state);

  console.log("✅ MTM (Zerodha-style):", {
    realised,
    unrealised,
    total_pnl,
  });

  return { realised, unrealised, total_pnl };
}

// ===========================================
//      Vercel Cron / API entrypoint
// ===========================================
export default async function handler(req, res) {
  try {
    const mtm = await computeMTM();
    return res.json({ ok: true, mtm });
  } catch (e) {
    console.error("❌ MTM handler error:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
      }
