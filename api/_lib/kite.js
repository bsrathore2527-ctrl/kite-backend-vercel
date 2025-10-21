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
  // swallow import-time error
}

if (!kv) {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
  } else {
    kv = null; // functions using kv should guard their usage
  }
}

// Create KiteConnect instance (stateless)
export function instance() {
  if (!process.env.KITE_API_KEY) {
    throw new Error("Missing KITE_API_KEY env var");
  }
  return new KiteConnect({ api_key: process.env.KITE_API_KEY });
}

// loginUrl: construct Zerodha login URL for redirecting users
export function loginUrl({ redirect } = {}) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("Missing KITE_API_KEY env var");

  const redirectTo = redirect || process.env.KITE_REDIRECT || "/";
  const encoded = encodeURIComponent(redirectTo);
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}&redirect_uri=${encoded}`;
}

// Persist access token to kv (best-effort) and optionally set cookie header on response
export async function setAccessTokenCookie(res, token) {
  try {
    if (res && typeof res.setHeader === "function" && token) {
      // HttpOnly cookie example; adjust as needed
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
export async function generateSession(request_token, api_secret) {
  if (!request_token) throw new Error("Missing request_token");
  if (!api_secret && !process.env.KITE_API_SECRET) {
    throw new Error("Missing KITE_API_SECRET env var");
  }
  const secret = api_secret || process.env.KITE_API_SECRET;
  const kc = instance();
  // Note: kiteconnect generateSession returns { access_token, public_token, ... } depending on SDK version
  return kc.generateSession(request_token, secret);
}

// exchangeRequestToken:
// Called from callback endpoint. Exchanges request_token -> access token object,
// saves tokens to kv and returns the token object.
export async function exchangeRequestToken(request_token) {
  if (!request_token) throw new Error("request_token required");
  const secret = process.env.KITE_API_SECRET;
  if (!secret) throw new Error("Missing KITE_API_SECRET env var");

  // perform generateSession via SDK
  const tokens = await generateSession(request_token, secret);

  // tokens usually contain: access_token, public_token, user_id, etc.
  try {
    if (kv && typeof kv.set === "function") {
      await kv.set("kite_tokens", tokens);
      // also mirror kite_access_token key for convenience
      if (tokens && tokens.access_token) {
        await kv.set("kite_access_token", tokens.access_token);
      }
    }
  } catch (e) {
    console.warn("exchangeRequestToken kv.set error:", e && e.message);
  }
  return tokens;
}

// Helper: save refreshable token structure if you want
export async function saveTokens(tokens) {
  try {
    if (!tokens) return;
    if (kv && typeof kv.set === "function") {
      await kv.set("kite_tokens", tokens);
      if (tokens.access_token) await kv.set("kite_access_token", tokens.access_token);
    }
  } catch (e) {
    console.warn("saveTokens error:", e && e.message);
  }
}

// default export not required, but keep for safety if other modules import default
export default {
  instance,
  loginUrl,
  setAccessTokenCookie,
  getAccessToken,
  generateSession,
  exchangeRequestToken,
  saveTokens
};
