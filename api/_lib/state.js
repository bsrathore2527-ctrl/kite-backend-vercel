// api/_lib/state.js
// Minimal wrapper to read/write the persisted app state from KV (Upstash).
// Exports getState() and setState(state).

import { kv } from "./kv.js"; // same helper your project already uses

export const STATE_KEY = "guardian:state";

export async function getState() {
  try {
    const raw = await kv.get(STATE_KEY);
    if (!raw) return {};
    // If raw is stored as JSON string, parse; if it's stored as object, return directly
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch (e) {
        // fallback: attempt to read as JSON-in-JSON
        return {};
      }
    }
    // assume object
    return raw;
  } catch (err) {
    console.error("getState error", err && err.stack ? err.stack : err);
    return {};
  }
}

export async function setState(state) {
  try {
    // Some projects store objects directly; others prefer JSON string.
    // Upstash kv.set accepts objects in many SDKs, but stringify to be safe.
    await kv.set(STATE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error("setState error", err && err.stack ? err.stack : err);
    throw err;
  }
}
