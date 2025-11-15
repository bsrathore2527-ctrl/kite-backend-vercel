// api/_lib/state.js
import { kv } from "./kv.js";

export const STATE_KEY = "guardian:state";

/**
 * Read the persisted guardian state from KV.
 * - Returns an object (possibly empty) and never throws.
 */
export async function getState() {
  try {
    const raw = await kv.get(STATE_KEY);
    if (!raw) return {};
    // If SDK returns an object already, just return it
    if (typeof raw === "object") return raw;
    // If it's a string, and looks like JSON, try to parse
    if (typeof raw === "string") {
      const s = raw.trim();
      if (s.startsWith("{") || s.startsWith("[")) {
        try {
          return JSON.parse(s);
        } catch (e) {
          console.warn("getState: invalid JSON in KV, returning empty object", e && e.message ? e.message : e);
          return {};
        }
      }
      // If it's obviously a "[object Object]" or some stringified non-json, log and return {}
      console.warn("getState: KV value not JSON, returning empty object. KV value head:", s.slice(0,80));
      return {};
    }
    // Anything else — return empty state
    return {};
  } catch (err) {
    console.error("getState error", err && err.stack ? err.stack : err);
    return {};
  }
}

/**
 * Set the persisted guardian state to KV (overwrites).
 * Always stringifies the state to ensure a stable representation.
 */
export async function setState(state) {
  try {
    // Always stringify to guarantee valid JSON is stored
    await kv.set(STATE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error("setState error", err && err.stack ? err.stack : err);
    throw err;
  }
}

/**
 * updateState(updater, opts)
 *
 * Safe optimistic update helper:
 * - Calls getState() to read current state
 * - Calls updater(currentState) -> newState (updater may be async)
 * - Writes newState to KV with a tiny internal _meta.updated_at stamp
 * - Reads back to confirm the write "stuck" (by comparing updated_at)
 * - Retries a few times if a concurrent writer interfered
 *
 * Usage:
 * await updateState(async (s) => {
 *   s.counter = (s.counter || 0) + 1;
 *   return s;
 * });
 *
 * The helper is intentionally conservative (default 5 retries).
 */
export async function updateState(updater, opts = {}) {
  const maxRetries = typeof opts.maxRetries === "number" ? opts.maxRetries : 5;
  if (typeof updater !== "function") throw new Error("updateState requires an updater function");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const before = await getState();

      // Clone to avoid accidental mutation of returned object
      const cloned = JSON.parse(JSON.stringify(before || {}));

      // Let updater produce the next state (allow async)
      const nextCandidate = await updater(cloned);

      if (!nextCandidate || typeof nextCandidate !== "object") {
        throw new Error("updateState updater must return an object");
      }

      // Stamp with a monotonic-ish value so we can verify our write
      const stamp = Date.now();

      // Preserve previous meta but ensure updated_at is ours
      nextCandidate._meta = Object.assign({}, nextCandidate._meta || {}, { updated_at: stamp });

      // Write to KV
      await kv.set(STATE_KEY, JSON.stringify(nextCandidate));

      // Read back to verify
      const afterRaw = await kv.get(STATE_KEY);
      let after;
      if (typeof afterRaw === "object") after = afterRaw;
      else if (typeof afterRaw === "string") {
        try { after = JSON.parse(afterRaw); } catch (e) { after = null; }
      } else after = null;

      const wroteStamp = after && after._meta && after._meta.updated_at ? Number(after._meta.updated_at) : null;
      if (wroteStamp === stamp) {
        // success: our write remained
        return after;
      } else {
        // somebody else overwrote between our set and read — retry
        console.warn(`updateState: race detected on attempt ${attempt}, retrying...`);
        // small backoff (avoid tight loop)
        await new Promise(r => setTimeout(r, 20 * attempt));
        continue;
      }
    } catch (err) {
      // If last attempt, throw
      if (attempt === maxRetries) {
        console.error("updateState: final attempt failed", err && err.stack ? err.stack : err);
        throw err;
      }
      // otherwise retry with small delay
      console.warn(`updateState attempt ${attempt} failed, retrying...`, err && err.message ? err.message : err);
      await new Promise(r => setTimeout(r, 30 * attempt));
    }
  }
  // If loop exhausts (shouldn't happen), throw
  throw new Error("updateState: exhausted retries");
}
