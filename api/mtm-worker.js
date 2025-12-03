// ===============================
//       MTM WORKER (FINAL)
// ===============================
// ✔ FIFO realised PNL
// ✔ Multi-baseline per instrument
// ✔ Overnight baseline at 9:15 LTP
// ✔ Intraday baseline using execution price
// ✔ Uses raw.average_price for real exec
// ✔ Reads LTP from ticker-worker
// ✔ Writes to guardian:baselines + guardian:state


const KV_URL = process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// -------------------------------
// KV Helpers
// -------------------------------
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

// -------------------------------
// Fetch LTP for a token
// -------------------------------
async function getLTP(token) {
  let obj = await kvGet(`ltp:${token}`);
  return obj?.last_price ?? null;
}

// -------------------------------
// FIFO reduce qty in baselines
// -------------------------------
function fifoReduce(baselines, sellQty, sellPrice) {
  let realised = 0;

  for (let block of baselines) {
    if (sellQty <= 0) break;

    if (block.qty <= 0) continue;

    let closeQty = Math.min(block.qty, sellQty);
    realised += (sellPrice - block.price) * closeQty;

    block.qty -= closeQty;
    sellQty -= closeQty;
  }

  // Remove zero-qty blocks
  return { realised, remainingBlocks: baselines.filter(b => b.qty > 0) };
}

// -------------------------------
// MTM FUNCTION
// -------------------------------
async function computeMTM() {
  console.log("📊 Running MTM worker...");

  let tradebook = await kvGet("guardian:tradebook");
  if (!Array.isArray(tradebook)) tradebook = [];

  let positions = await kvGet("guardian:positions"); // optional
  let baselines = await kvGet("guardian:baselines") || {};

  let realised = 0;
  let unrealised = 0;

  // -------------------------------
  // STEP 1: Build initial baselines
  // -------------------------------
  // Overnight qty baseline (LTP at 9:15)
  if (positions && positions.net) {
    for (let p of positions.net) {
      if (!p.instrument_token || !p.quantity) continue;

      let token = p.instrument_token;

      // If baseline doesn't exist, create overnight block
      if (!baselines[token] || baselines[token].length === 0) {
        let ltp = await getLTP(token); // 9:15 LTP from ticker-worker

        if (ltp != null) {
          baselines[token] = [
            { qty: p.quantity, price: ltp, type: "overnight" }
          ];
        }
      }
    }
  }

  // -------------------------------
  // STEP 2: Process trades FIFO
  // -------------------------------
  for (let t of tradebook) {
    const raw = t.raw || {};
    let token = raw.instrument_token;
    let qty = raw.quantity;
    let isBuy = raw.transaction_type === "BUY";
    let execPrice = raw.average_price;

    if (!token || !qty) continue;

    // Ensure baseline array exists
    if (!baselines[token]) baselines[token] = [];

    if (isBuy) {
      // Add new intraday baseline block
      baselines[token].push({
        qty: qty,
        price: execPrice,
        type: "intraday"
      });
    } else {
      // SELL → FIFO reduce baseline blocks
      let { realised: r, remainingBlocks } = fifoReduce(
        baselines[token],
        qty,
        execPrice
      );

      realised += r;
      baselines[token] = remainingBlocks;
    }
  }

  // -------------------------------
  // STEP 3: Compute Unrealised PNL
  // -------------------------------
  for (let token of Object.keys(baselines)) {
    let ltp = await getLTP(token);
    if (ltp == null) continue;

    for (let block of baselines[token]) {
      if (block.qty > 0) {
        unrealised += (ltp - block.price) * block.qty;
      }
    }
  }

  let total_pnl = realised + unrealised;

  // -------------------------------
  // STEP 4: Write results to KV
  // -------------------------------
  await kvSet("guardian:baselines", baselines);

  // update guardian:state
  let state = await kvGet("guardian:state") || {};
  state.realised = realised;
  state.unrealised = unrealised;
  state.total_pnl = total_pnl;

  await kvSet("guardian:state", state);

  console.log("📊 MTM Done:", { realised, unrealised, total_pnl });
}

// Run every minute
setInterval(computeMTM, 60000);

computeMTM();
