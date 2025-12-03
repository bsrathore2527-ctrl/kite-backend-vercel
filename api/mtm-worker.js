// ===========================================
//             FINAL MTM WORKER
//        VERCEL CRON COMPATIBLE
// ===========================================
// ✔ FIFO realised PNL
// ✔ Separate baseline blocks
// ✔ Overnight baseline from 9:15 LTP
// ✔ Intraday baseline from raw.average_price
// ✔ Uses ticker-worker LTP format
// ✔ Writes to guardian:baselines + guardian:state
// ✔ Safe JSON parsing for all KV values
// ✔ No node-fetch required (uses Vercel fetch)

// -------------------------------------------
// ENV Vars from Vercel
// -------------------------------------------
const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// -------------------------------------------
// SAFE JSON PARSER
// -------------------------------------------
function safeParse(obj) {
  if (!obj) return {};
  if (typeof obj === "object") return obj;
  try {
    return JSON.parse(obj);
  } catch {
    return {};
  }
}

// -------------------------------------------
// KV Helpers
// -------------------------------------------
async function kvGet(key) {
  try {
    const res = await fetch(`${KV_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    }).then(r => r.json());

    return res?.result ?? null;
  } catch (err) {
    console.log(`❌ KV GET error for key: ${key}`, err);
    return null;
  }
}

async function kvSet(key, value) {
  try {
    return fetch(`${KV_URL}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(value)
    }).then(r => r.json());
  } catch (err) {
    console.log(`❌ KV SET error for key: ${key}`, err);
  }
}

// -------------------------------------------
// LTP Fetcher from ticker-worker
// -------------------------------------------
async function getLTP(token) {
  const data = await kvGet(`ltp:${token}`);
  return data?.last_price ?? null;
}

// -------------------------------------------
// FIFO Realised Calculation
// -------------------------------------------
function fifoReduce(blocks, sellQty, sellPrice) {
  let realised = 0;

  for (let block of blocks) {
    if (sellQty <= 0) break;
    if (block.qty <= 0) continue;

    const closing = Math.min(block.qty, sellQty);

    realised += (sellPrice - block.price) * closing;

    block.qty -= closing;
    sellQty -= closing;
  }

  // keep only blocks with qty
  blocks = blocks.filter(b => b.qty > 0);

  return { realised, blocks };
}

// ===========================================
//                MTM ENGINE
// ===========================================
async function computeMTM() {
  console.log("📊 MTM worker started...");

  // Load tradebook
  let rawTradebook = await kvGet("guardian:tradebook");
  let tradebook = Array.isArray(rawTradebook) ? rawTradebook : [];

  // Load positions
  let positions = safeParse(await kvGet("guardian:positions"));

  // Load baselines (may be string or object)
  let baselines = safeParse(await kvGet("guardian:baselines"));

  let realised = 0;
  let unrealised = 0;

  // ----------------------------------------------------
  // 1️⃣ OVERNIGHT BASELINES USING 9:15 LTP
  // ----------------------------------------------------
  if (positions && positions.net) {
    for (let p of positions.net) {
      const token = p.instrument_token;
      const qty = p.quantity;

      if (!token || !qty) continue;

      if (!baselines[token] || baselines[token].length === 0) {
        let ltp = await getLTP(token);
        if (ltp != null) {
          baselines[token] = [
            { qty: qty, price: ltp, type: "overnight" }
          ];
        }
      }
    }
  }

  // ----------------------------------------------------
  // 2️⃣ PROCESS INTRADAY TRADES (FIFO)
  // ----------------------------------------------------
  for (let t of tradebook) {
    let raw = t.raw || {};

    const token = raw.instrument_token;
    const qty = raw.quantity;
    const execPrice = raw.average_price;
    const isBuy = raw.transaction_type === "BUY";

    if (!token || !qty) continue;

    if (!baselines[token]) baselines[token] = [];

    if (isBuy) {
      // intraday entry → create new baseline block
      baselines[token].push({
        qty,
        price: execPrice,
        type: "intraday"
      });
    } else {
      // SELL → FIFO close
      let result = fifoReduce(baselines[token], qty, execPrice);
      realised += result.realised;
      baselines[token] = result.blocks;
    }
  }

  // ----------------------------------------------------
  // 3️⃣ UNREALISED PNL = Σ((LTP - baseline_price) × qty)
  // ----------------------------------------------------
  for (let token of Object.keys(baselines)) {
    const ltp = await getLTP(token);
    if (ltp == null) continue;

    for (let block of baselines[token]) {
      unrealised += (ltp - block.price) * block.qty;
    }
  }

  const total_pnl = realised + unrealised;

  // ----------------------------------------------------
  // 4️⃣ SAVE BASELINES
  // ----------------------------------------------------
  await kvSet("guardian:baselines", JSON.stringify(baselines));

  // ----------------------------------------------------
  // 5️⃣ SAVE MTM TO STATE
  // ----------------------------------------------------
  let rawState = await kvGet("guardian:state");
  let state = safeParse(rawState);

  state.realised = realised;
  state.unrealised = unrealised;
  state.total_pnl = total_pnl;

  await kvSet("guardian:state", JSON.stringify(state));

  console.log("📊 MTM Completed:", { realised, unrealised, total_pnl });

  return { realised, unrealised, total_pnl };
}

// ===========================================
//     VERCEL CRON ENTRYPOINT (REQUIRED)
// ===========================================
export default async function handler(req, res) {
  const mtm = await computeMTM();

  return res.json({
    ok: true,
    mtm
  });
}
