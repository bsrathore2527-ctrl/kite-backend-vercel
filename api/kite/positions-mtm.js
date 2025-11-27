//-------------------------------------------------------
// /api/kite/positions-mtm.js
// FINAL OPTIMIZED VERSION (Option B)
//-------------------------------------------------------

import { kiteConnectClient } from "../../_lib/kite.js";
import { kv } from "../../_lib/kv.js";

export const config = {
  runtime: "nodejs",
};

// Helper: India time
function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

export default async function handler(req) {
  try {
    //---------------------------------------------------
    // 1) Fetch fresh positions from Zerodha
    //---------------------------------------------------
    const kc = await kiteConnectClient();
    const positionsResp = await kc.getPositions();

    const net = Array.isArray(positionsResp.net)
      ? positionsResp.net
      : [];

    //---------------------------------------------------
    // 2) Compute realised, unrealised, total PnL
    //---------------------------------------------------
    let realised = 0;
    let unrealised = 0;

    for (const p of net) {
      // Zerodha gives pnl = realised, unrealised
      if (typeof p.realised === "number") realised += p.realised;
      if (typeof p.unrealised === "number") unrealised += p.unrealised;
    }

    const total_pnl = realised + unrealised;
    const ts = Date.now();

    const mtmObj = {
      realised,
      unrealised,
      total_pnl,
      ts,
    };

    //---------------------------------------------------
    // 3) Write MTM → KV (single source of truth)
    //---------------------------------------------------
    await kv.set("live:mtm", mtmObj);

    //---------------------------------------------------
    // 4) Write POSITIONS → KV (single source of truth)
    //---------------------------------------------------
    await kv.set("live:positions", {
      positions: net,
      ts,
    });

    //---------------------------------------------------
    // 5) Return same response format (backward compatible)
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
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500 }
    );
  }
}
