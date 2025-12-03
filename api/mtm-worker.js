// ===========================================
//      Zerodha-style MTM WORKER (FINAL)
// ===========================================

const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// -------------------------------------------------
// SUPER SAFE JSON PARSER — handles double stringify
// -------------------------------------------------
function safeParse(val) {
  if (!val) return {};

  let out = val;

  // Parse repeatedly until it's no longer JSON string
  while (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      break;
    }
  }

  if (typeof out !== "object" || out === null) return {};
  return out;
}

// -------------------------------------------------
function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateStrUTC(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(
    d.getUTCDate()
  )}`;
}

// -------------------------------------------------
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
    return await fetch(`${KV_URL}/set/${key}`, {
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

// -------------------------------------------------
async function getLTP(token) {
  const data = await kvGet(`ltp:${token}`);
  return data?.last_price ?? null;
}

// -------------------------------------------------
// FIFO REDUCE for REALISED PNL (today only)
// -------------------------------------------------
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

// ==================================================
//               MAIN MTM ENGINE
// ==================================================
async function computeMTM() {
  console.log("📊 MTM worker (Zerodha mode) starting...");

  const now = new Date();
  const todayStr = dateStrUTC(now);

  // ---------------------------
  // Load tradebook
  // ---------------------------
  let tbRaw = await kvGet("guardian:tradebook");
  let tradebook = safeParse(tbRaw);
  if (!Array.isArray(tradebook)) tradebook = [];

  // ---------------------------
  // Load positions
  // ---------------------------
  const positions = safeParse(await kvGet("guardian:positions"));

  // ---------------------------
  // Load baselines + meta
  // ---------------------------
  let baselines = safeParse(await kvGet("guardian:baselines"));
  let meta = safeParse(await kvGet("guardian:mtm_meta"));

  // RESET ON NEW DAY
  if (!meta.date || meta.date !== todayStr) {
    console.log("🔁 New MTM day detected. Resetting baselines...");
    baselines = {};
    meta = { date: todayStr };
  }

  // ---------------------------
  // Filter only TODAY’s trades
  // ---------------------------
  const tradesToday = [];
  const tokensToday = new Set();

  for (const t of tradebook) {
    const raw = t.raw || {};
    const ts =
      raw.exchange_timestamp ||
      raw.fill_timestamp ||
      t.iso_date ||
      null;

    let d = ts ? new Date(ts) : t.ts ? new Date(Number(t.ts)) : null;
    if (!d) continue;

    if (dateStrUTC(d) !== todayStr) continue;

    const token = raw.instrument_token;
    if (!token) continue;

    tradesToday.push(t);
    tokensToday.add(token);
  }

  let realised = 0;
  let unrealised = 0;

  // ==================================================
  // 1️⃣ OVERNIGHT BASELINES (9:15 LTP)
  // --------------------------------------------------
  // Only for tokens WITHOUT trades today
  // ==================================================
  if (positions && Array.isArray(positions.net)) {
    for (const p of positions.net) {
      const token = p.instrument_token;
      const qty = p.quantity;

      if (!token || !qty) continue;
      if (tokensToday.has(token)) continue;

      // Only set if empty
      if (!baselines[token] || baselines[token].length === 0) {
        const ltp = await getLTP(token);

        if (ltp != null) {
          baselines[token] = [
            { qty, price: ltp, type: "overnight" },
          ];
          console.log("🌅 Overnight baseline set:", token, qty, "@", ltp);
        }
      }
    }
  }

  // ==================================================
  // 2️⃣ TODAY'S TRADES → FIFO REALISED
  // ==================================================
  for (const t of tradesToday) {
    const raw = t.raw || {};
    const token = raw.instrument_token;
    const qty = raw.quantity;
    const px = raw.average_price;
    const isBuy = raw.transaction_type === "BUY";

    if (!token || !qty) continue;
    if (!baselines[token]) baselines[token] = [];

    if (isBuy) {
      baselines[token].push({ qty, price: px, type: "intraday" });
    } else {
      const out = fifoReduce(baselines[token], qty, px);
      realised += out.realised;
      baselines[token] = out.blocks;
    }
  }

  // ==================================================
  // 3️⃣ UNREALISED = OPEN QTY × (LTP – baseline)
  // ==================================================
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

  // ==================================================
  // 4️⃣ SAVE TO KV (safe JSON)
  // ==================================================
  await kvSet("guardian:baselines", baselines);
  await kvSet("guardian:mtm_meta", meta);

  let state = safeParse(await kvGet("guardian:state"));

  state.realised = realised;
  state.unrealised = unrealised;
  state.total_pnl = total_pnl;

  await kvSet("guardian:state", state);

  console.log("✅ MTM FINAL:", { realised, unrealised, total_pnl });

  return { realised, unrealised, total_pnl };
}

// ==================================================
//              Vercel API entrypoint
// ==================================================
export default async function handler(req, res) {
  try {
    const mtm = await computeMTM();
    res.json({ ok: true, mtm });
  } catch (err) {
    console.error("❌ MTM Error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
