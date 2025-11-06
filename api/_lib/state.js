// api/_lib/state.js
import { kv } from "./kv.js";

export const STATE_KEY = "guardian:state";

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
