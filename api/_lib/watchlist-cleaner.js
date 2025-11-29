import { kv } from "../api/_lib/kv.js";
import { getPositionsFromKite } from "../api/_lib/kite.js";   // You already have such a helper

// Run daily after market close (or via manual call)
export async function cleanWatchlist() {

  // 1. Fetch current watchlist
  let wlRaw = await kv.get("master:watchlist");
  let wl = [];
  try { wl = JSON.parse(wlRaw) || []; }
  catch (e) { wl = []; }

  if (!Array.isArray(wl)) wl = [];

  // 2. Fetch current open positions
  let positions = [];
  try {
    positions = await getPositionsFromKite();
  } catch (e) {
    console.error("Error fetching positions in cleanWatchlist:", e);
  }

  // 3. Extract tokens still active
  let activeTokens = positions
    .filter(p => Number(p.quantity) !== 0)
    .map(p => Number(p.instrument_token));

  // 4. Filter out tokens not in active positions
  let cleaned = wl.filter(t => activeTokens.includes(Number(t)));

  // 5. Store cleaned
  await kv.set("master:watchlist", JSON.stringify(cleaned));

  return {
    original: wl,
    active: activeTokens,
    cleaned: cleaned
  };
}
