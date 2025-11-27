//-------------------------------------------------------
// /api/kite/positions-mtm.js
// FINAL - Compatible with your project (instance(), kv)
//-------------------------------------------------------

export const config = {
  runtime: "nodejs",
};

import { instance } from "../_lib/kite.js";
import { kv } from "../_lib/kv.js";

// Helper IST time
function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

export default async function handler(req) {
  try {
    //---------------------------------------------------
    // 1) Get authenticated Zerodha client
    //---------------------------------------------------
    const kc = await instance();

    //---------------------------------------------------
    // 2) Get latest positions from Zerodha
    //---------------------------------------------------
    const positionsResp = await kc.getPositions();
    const net = Array.isArray(positionsResp.net)
      ? positionsResp.net
      : [];

    //---------------------------------------------------
    // 3) Compute MTM using Zerodha fields
    //---------------------------------------------------
    let realised = 0;
    let unrealised = 0;

    for (const p of net) {
      if (typeof p.realised === "number") realised += p.realised;
      if (typeof p.unrealised === "number") unrealised += p.unrealised;
    }

    const total_pnl = realised + unrealised;
    const ts = Date.now();

    const mtm = {
      realised,
      unrealised,
      total_pnl,
      ts,
    };

    //---------------------------------------------------
    // 4) Write MTM → KV
    //---------------------------------------------------
    await kv.set("live:mtm", mtm);

    //---------------------------------------------------
    // 5) Write raw positions → KV
    //---------------------------------------------------
    await kv.set("live:positions", {
      positions: net,
      ts,
    });

    //---------------------------------------------------
    // 6) Return MTM (backwards-compatible format)
    //---------------------------------------------------
    return new Response(
      JSON.stringify({
        ok: true,
        realised,
        unrealised,
        total_pnl,
        ts,
        live_mtm_written: true,
      }),
      { status: 200 }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(err),
      }),
      { status: 500 }
    );
  }
}
