// api/_lib/kv.js
import { Redis } from "@upstash/redis";

export const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

export const IST = "Asia/Kolkata";

export function todayKey(d = new Date()) {
  const now = new Date(d.toLocaleString("en-US", { timeZone: IST }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getState() {
  const key = `risk:${todayKey()}`;
  try {
    return (await kv.get(key)) || {};
  } catch (e) {
    console.error("kv.get error:", e?.message || e);
    return {};
  }
}

export async function setState(patch = {}) {
  const key = `risk:${todayKey()}`;
  try {
    const cur = (await kv.get(key)) || {};
    const next = { ...cur, ...patch };
    await kv.set(key, next);
    return next;
  } catch (e) {
    console.error("kv.set error:", e?.message || e);
    throw e;
  }
}
