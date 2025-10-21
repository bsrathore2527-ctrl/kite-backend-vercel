// api/_lib/kite.js
import crypto from "crypto";

// robust import helper: tolerate named/default exports from kv.js
import * as kvMod from "./kv.js";
const kv = kvMod.kv || kvMod.default || null;

if (!kv) {
  console.warn("Warning: kv instance not found in ./kv.js. Redis calls will fail if used.");
}

const KITE_API = "https://api.kite.trade";

export async function getAccessToken() {
  try {
    if (kv && kv.get) {
      const t = await kv.get("kite_access_token");
      if (t) return t;
    }
  } catch (e) {
    console.error("getAccessToken kv.get error:", e?.message || e);
  }
  return process.env.KITE_ACCESS_TOKEN || null;
}

export async function setAccessToken(token) {
  if (!token) return null;
  try {
    if (kv && kv.set) {
      await kv.set("kite_access_token", token);
    }
  } catch (e) {
    console.error("setAccessToken kv.set error:", e?.message || e);
  }
  return token;
}

export function loginUrl() {
  const key = process.env.KITE_API_KEY;
  const redirect = process.env.KITE_REDIRECT_URL;
  if (!key || !redirect) {
    throw new Error("Missing KITE_API_KEY or KITE_REDIRECT_URL env var");
  }
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(
    key
  )}&redirect_params=${encodeURIComponent(redirect)}`;
}

export async function exchangeRequestToken(request_token) {
  if (!request_token) throw new Error("Missing request_token");
  const key = process.env.KITE_API_KEY;
  const secret = process.env.KITE_API_SECRET;
  if (!key || !secret) throw new Error("Missing KITE_API_KEY or KITE_API_SECRET");

  const checksum = crypto
    .createHash("sha256")
    .update(`${key}${request_token}${secret}`)
    .digest("hex");

  const url = `${KITE_API}/session/token`;
  const body = new URLSearchParams({
    api_key: key,
    request_token,
    checksum,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !(json.data && json.data.access_token)) {
    throw new Error(JSON.stringify(json || { status: res.status }));
  }
  await setAccessToken(json.data.access_token);
  return json.data.access_token;
}

function kiteHeader(token) {
  const key = process.env.KITE_API_KEY;
  if (!key || !token) throw new Error("Missing api key or token");
  return { Authorization: `token ${key}:${token}` };
}

export async function kiteGet(path) {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: "Missing access_token" };
  const url = `${KITE_API}${path}`;
  const res = await fetch(url, { headers: kiteHeader(token) });
  const json = await res.json().catch(() => ({ ok: false, error: "Invalid JSON from kite" }));
  if (!res.ok) return { ok: false, status: res.status, ...json };
  return { ok: true, ...json };
}

export async function kitePost(path, bodyObj = {}) {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: "Missing access_token" };
  const url = `${KITE_API}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...kiteHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  const json = await res.json().catch(() => ({ ok: false, error: "Invalid JSON from kite" }));
  if (!res.ok) return { ok: false, status: res.status, ...json };
  return { ok: true, ...json };
}

export async function kitePositions() {
  // returns kite positions response
  return await kiteGet("/positions");
}

export async function kiteFunds() {
  // primary endpoint for funds; older projects used /user/funds or /funds
  const r = await kiteGet("/user/funds");
  if (r.ok) return r;
  return await kiteGet("/funds");
}

export async function kiteProfile() {
  return await kiteGet("/user/profile");
}

export async function kiteOrders() {
  return await kiteGet("/orders");
}

export async function kitePlaceOrder(payload) {
  // payload should follow Kite API shape — this is a thin wrapper
  return await kitePost("/orders/regular", payload);
}

export async function kiteCancelOrder(orderId) {
  if (!orderId) return { ok: false, error: "Missing order id" };
  // cancellation endpoint path depends on order type — this is a best-effort example
  return await kitePost(`/orders/${orderId}/cancel`, {});
}

/**
 * Backwards compatibility export: `instance`
 * Many older modules import `instance` and call methods like instance.orders(), instance.positions(), etc.
 * Provide a simple object that proxies common operations to the helper functions above.
 */
export const instance = {
  positions: async () => {
    const r = await kitePositions();
    return r;
  },
  funds: async () => {
    const r = await kiteFunds();
    return r;
  },
  profile: async () => {
    const r = await kiteProfile();
    return r;
  },
  orders: async () => {
    const r = await kiteOrders();
    return r;
  },
  placeOrder: async (payload) => {
    return await kitePlaceOrder(payload);
  },
  cancelOrder: async (orderId) => {
    return await kiteCancelOrder(orderId);
  },
  getAccessToken,
  setAccessToken,
  kiteGet,
  kitePost,
};
