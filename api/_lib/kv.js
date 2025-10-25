// api/_lib/kv.js
import { Redis } from "@upstash/redis";

export const IST = "Asia/Kolkata";

export function todayKey(d = new Date()) {
  const now = new Date(d.toLocaleString("en-US", { timeZone: IST }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Try to initialise Upstash Redis if env vars exist.
// If not, use an in-memory fallback to avoid crashes in serverless environment.
let kvClient = null;
let usingUpstash = false;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    kvClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    usingUpstash = true;
  } catch (e) {
    console.error("Upstash init failed:", e && e.message ? e.message : e);
    kvClient = null;
    usingUpstash = false;
  }
}

// simple in-memory fallback (not persistent across cold starts)
const _inMemoryStore = {};

export const kv = kvClient; // may be null if not configured

// helper to safe-get key from either upstash or memory
async function _rawGet(key) {
  if (usingUpstash && kvClient) {
    try {
      return await kvClient.get(key);
    } catch (e) {
      console.error("kv.get error:", e && e.message ? e.message : e);
      // fall through to in-memory fallback (best-effort)
    }
  }
  // fallback
  return _inMemoryStore[key];
}

// helper to safe-set key in either upstash or memory
async function _rawSet(key, value) {
  if (usingUpstash && kvClient) {
    try {
      // Upstash Redis expects JSON-serializable values; set will store object fine
      await kvClient.set(key, value);
      return true;
    } catch (e) {
      console.error("kv.set error:", e && e.message ? e.message : e);
      // fall back to in-memory if remote failed
    }
  }
  _inMemoryStore[key] = value;
  return true;
}

/**
 * getState - returns stored state object for today
 * returns {} when nothing found
 */
export async function getState() {
  const key = `risk:${todayKey()}`;
  try {
    const val = await _rawGet(key);
    // If Upstash returns stringified JSON, Upstash client already returns parsed objects,
    // but ensure we return object
    if (!val) return {};
    if (typeof val === "string") {
      try { return JSON.parse(val); } catch(e) { return {}; }
    }
    return val;
  } catch (e) {
    console.error("getState failed:", e && e.message ? e.message : e);
    return {};
  }
}

/**
 * setState - merge patch onto existing state and persist
 * returns the next state object
 */
export async function setState(patch = {}) {
  const key = `risk:${todayKey()}`;
  try {
    const cur = (await _rawGet(key)) || {};
    const current = (typeof cur === "string") ? (() => {
      try { return JSON.parse(cur); } catch(e){ return {}; }
    })() : cur || {};

    const next = { ...current, ...patch };
    await _rawSet(key, next);
    return next;
  } catch (e) {
    console.error("setState failed:", e && e.message ? e.message : e);
    // best-effort: merge into memory fallback
    const cur2 = _inMemoryStore[key] || {};
    const next2 = { ...cur2, ...patch };
    _inMemoryStore[key] = next2;
    return next2;
  }
}
