import { Redis } from "@upstash/redis";
export const kv = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});
export const IST = "Asia/Kolkata";
export const todayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: IST }); // YYYY-MM-DD
export const nowIST = () => new Date(new Date().toLocaleString("en-US", { timeZone: IST }));
