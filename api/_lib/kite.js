// api/_lib/kite.js
// Kite helpers + safe kv handling
import { KiteConnect } from "kiteconnect";
import * as kvModule from "./kv.js"; // robust import
import { Redis } from "@upstash/redis";

// Resolve a kv client in a tolerant way
let kv = null;
try {
  // 1) prefer named export
  if (kvModule && kvModule.kv) kv = kvModule.kv;
  // 2) or default that contains kv
  else if (kvModule && kvModule.default && kvModule.default.kv) kv = kvModule.default.kv;
} catch (e) {
  // ignore - we'll try to construct below
}

if (!kv) {
  // If kv isn't available from imported module, create a light-upstash client
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    kv = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
  } else {
    // leave kv null but we handle it gracefully where needed
    kv = null;
  }
}

// Kite connect instance factory
export function instance() {
  if (!process.env.KITE_API_KEY) {
    throw new Error("Missing KITE_API_KEY env var");
  }
  return new KiteConnect({ api_key: process.env.KITE_API_KEY });
}

// Convenience: store / read access token in kv (if kv exists)
export async function setAccessTokenCookie(res, token) {
  // this helper used previously to set cookie during login flow - preserve original behaviour
  // If you used cookies previously, keep same shape; else keep no-op
  try {
    if (res && typeof res.setHeader === "function") {
      // set a cookie for frontend (example) - adjust as before
      res.setHeader("Set-Cookie", `access_token=${token}; Path=/; HttpOnly; SameSite=Lax`);
    }
    if (kv && token) {
      // store latest access token in kv for functions that read it
      await kv.set("kite_access_token", token);
    }
  } catch (e) {
    // don't break the request flow on cookie failures
    console.warn("setAccessTokenCookie error:", e && e.message);
  }
}

// Read stored access token (tries kv, then env)
export async function getAccessToken() {
  // Prefer runtime kv store
  try {
    if (kv && typeof kv.get === "function") {
      const t = await kv.get("kite_access_token");
      if (t) return t;
    }
  } catch (e) {
    console.warn("kv.get error:", e && e.message);
  }
  // fallback to environment (not recommend for production, but useful for dev)
  return process.env.KITE_ACCESS_TOKEN || null;
}

// Helper to generate session using kite connect SDK
export async function generateSession(request_token, secret) {
  const kc = instance();
  // KiteConnect API uses generateSession on server side; adapt to your kiteconnect version
  return kc.generateSession(request_token, secret);
}
