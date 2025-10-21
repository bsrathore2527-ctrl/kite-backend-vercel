// api/_lib/state.js
// Centralized Guardian state manager
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// We’ll store the entire system state in one key
const KEY = "guardian:state";

// Read state
export async function getState() {
  const raw = await redis.get(KEY);
  if (!raw) return {};
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error("State parse error:", err);
    return {};
  }
}

// Write (replace) state
export async function setState(newState) {
  await redis.set(KEY, JSON.stringify(newState));
  return true;
}
