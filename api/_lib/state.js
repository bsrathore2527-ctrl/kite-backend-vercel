// api/_lib/state.js
// Thin state wrapper backed by Upstash Redis (re-uses your kv helper)
import { kv } from "./kv.js"; // expects api/_lib/kv.js to exist

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
  return (await kv.get(key)) || {};
}

export async function setState(patch = {}) {
  const key = `risk:${todayKey()}`;
  const cur = (await kv.get(key)) || {};
  const next = { ...cur, ...patch };
  await kv.set(key, next);
  return next;
}
