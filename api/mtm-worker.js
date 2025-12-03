// =================================
//       VERCEL MTM WORKER (FIXED)
// =================================
// ✔ No node-fetch import
// ✔ JSON-parse state
// ✔ Export handler for Vercel Cron
// ✔ No setInterval (Vercel kills long processes)

const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ----------------------
// KV Helpers
// ----------------------
async function kvGet(key) {
  try {
    const res = await fetch(`${KV_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    }).then(r => r.json());

    return res?.result ?? null;
  } catch (err) {
    console.log("❌ KV GET Error:", err);
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
    console.log("❌ KV SET Error:", err);
  }
}

async function getLTP(token) {
  let obj = await kvGet(`ltp:${token}`);
  return obj && obj.last_price ? obj.last_price : null;
}

// FIFO closing function
function fifoReduce(baselines, sellQty, sellPrice) {
  let realised = 0;

  for (let block of baselines) {
    if (sellQty <= 0) break;

    if (block.qty <= 0) continue;

    const closeQty = Math.min(block.qty, sellQty);
    realised += (sellPrice - block.price) * closeQty;

    block.qty -= closeQty;
    sellQty -= closeQty;
  }

  baselines = baselines.filter(b => b.qty > 0);

  return { realised, baselines };
}

// =================================
//        MAIN MTM FUNCTION
// =================================
async function computeMTM() {
  console.log("📊 Running MTM...");

  let tradebook = await kvGet("guardian:tradebook");
  if (!Array.isArray(tradebook)) tradebook = [];

  let positions = await kvGet("guardian:positions");
  let rawBaselines = await kvGet("guardian:baselines");

  // Parse baselines
  let baselines = {};
  try {
    if (rawBaselines) baselines = JSON.parse(rawBaselines);
  } catch {
    baselines = {};
  }

  let realised = 0;
  let unrealised = 0;

  // --------------------------
  // Overnight baseline using 9:15 LTP
  // --------------------------
  if (positions && positions.net) {
    for (let p of positions.net) {
      let token = p.instrument_token;
      if (!token || !p.quantity) continue;

      if (!baselines[token] || baselines[token].length === 0) {
        let ltp = await getLTP(token);
        if (ltp != null) {
          baselines[token] = [
            { qty: p.quantity, price: ltp, type: "overnight" }
          ];
        }
      }
    }
  }

  // --------------------------
  // Process tradebook FIFO
  // --------------------------
  for (let t of tradebook) {
    let raw = t.raw || {};
    let token = raw.instrument_token;
    let qty = raw.quantity;
    let price = raw.average_price;
    let isBuy = raw.transaction_type === "BUY";

    if (!token || !qty) continue;
    if (!baselines[token]) baselines[token] = [];

    if (isBuy) {
      baselines[token].push({
        qty,
        price,
        type: "intraday"
      });
    } else {
      let result = fifoReduce(baselines[token], qty, price);
      realised += result.realised;
      baselines[token] = result.baselines;
    }
  }

  // --------------------------
  // Unrealised PNL
  // --------------------------
  for (let token of Object.keys(baselines)) {
    let ltp = await getLTP(token);
    if (ltp == null) continue;

    for (let block of baselines[token]) {
      unrealised += (ltp - block.price) * block.qty;
    }
  }

  let total_pnl = realised + unrealised;

  // --------------------------
  // Save baselines
  // --------------------------
  await kvSet("guardian:baselines", JSON.stringify(baselines));

  // --------------------------
  // Update state object
  // --------------------------
  let rawState = await kvGet("guardian:state");
  let state = {};

  try {
    if (rawState) state = JSON.parse(rawState);
  } catch {
    state = {};
  }

  state.realised = realised;
  state.unrealised = unrealised;
  state.total_pnl = total_pnl;

  await kvSet("guardian:state", JSON.stringify(state));

  return { realised, unrealised, total_pnl };
}

// =================================
//      VERCEL CRON HANDLER
// =================================
export default async function handler(req, res) {
  const result = await computeMTM();

  return res.json({
    ok: true,
    mtm: result
  });
}
