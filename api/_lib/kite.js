// api/_lib/kite.js
// Kite helpers + tolerant kv handling
import { KiteConnect } from "kiteconnect";
import * as kvModule from "./kv.js";
import { Redis } from "@upstash/redis";

/*
  Tolerant import for kv.
  Accepts:
   - named export: export const kv = ...
   - default export: export default { kv }
   - fallback: build a Redis client from env
*/
let kv = null;
try {
  if (kvModule && kvModule.kv) kv = kvModule.kv;
  else if (kvModule && kvModule.default && kvModule.default.kv) kv = kvModule.default.kv;
} catch (e) {
  // ignore
}

if (!kv) {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
  } else {
    kv = null; // still ok; functions using kv should guard
  }
}

// Create KiteConnect instance
export function instance() {
  if (!process.env.KITE_API_KEY) {
    throw new Error("Missing KITE_API_KEY env var");
  }
  return new KiteConnect({ api_key: process.env.KITE_API_KEY });
}

// loginUrl: construct Zerodha login URL for redirecting users
// Uses KITE_REDIRECT env var if present, else expects caller to provide redirect
export function loginUrl({ redirect } = {}) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("Missing KITE_API_KEY env var");

  const redirectTo = redirect || process.env.KITE_REDIRECT || "/";
  const encoded = encodeURIComponent(redirectTo);
  // Standard Zerodha connect login url pattern
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}&redirect_uri=${encoded}`;
}

// set access token cookie + store in kv (best-effort)
export async function setAccessTokenCookie(res, token) {
  try {
    if (res && typeof res.setHeader === "function") {
      // HttpOnly cookie example
      res.setHeader("Set-Cookie", `access_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
    }
    if (kv && typeof kv.set === "function" && token) {
      await kv.set("kite_access_token", token);
    }
  } catch (e) {
    console.warn("setAccessTokenCookie error:", e && e.message);
  }
}

// get stored access token (tries kv then env)
export async function getAccessToken() {
  try {
    if (kv && typeof kv.get === "function") {
      const t = await kv.get("kite_access_token");
      if (t) return t;
    }
  } catch (e) {
    console.warn("kv.get error:", e && e.message);
  }
  return process.env.KITE_ACCESS_TOKEN || null;
}

// generateSession wrapper (uses kiteconnect SDK)
export async function generateSession(request_token, secret) {
  const kc = instance();
  // depending on kiteconnect version this may return tokens object
  return kc.generateSession(request_token, secret);
}

// Helper: save refreshable token structure if you want
export async function saveTokens(tokens) {
  try {
    if (!tokens) return;
    if (kv && typeof kv.set === "function") {
      await kv.set("kite_tokens", tokens);
    }
  } catch (e) {
    console.warn("saveTokens error:", e && e.message);
  }
}
