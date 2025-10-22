// api/_lib/state.js
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const KEY = "guardian:state";

export async function getState() {
  const raw = await redis.get(KEY);
  if (!raw) return {};
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch (e) { console.error("state parse err", e); return {}; }
}

export async function setState(newState) {
  await redis.set(KEY, JSON.stringify(newState));
  return true;
}
