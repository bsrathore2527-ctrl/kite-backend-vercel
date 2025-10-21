// api/_lib/kite.js
// Lightweight wrapper for Zerodha Kite REST calls and access token storage.
// Uses Upstash Redis (kv) for token persistence via ./kv.js in same folder.

import crypto from "crypto";
import { kv } from "./kv.js"; // make sure kv.js exports `kv` (see your kv.js)
const KITE_API = "https://api.kite.trade";

export async function getAccessToken() {
  // First try stored value in Redis, then environment fallback
  try {
    const t = await kv.get("kite_access_token");
    if (t) return t;
  } catch (e) {
    // ignore kv read failure (will fallback to env)
  }
  return process.env.KITE_ACCESS_TOKEN || null;
}

export async function setAccessToken(token) {
  if (!token) return null;
  try {
    await kv.set("kite_access_token", token);
  } catch (e) {
    // ignore set errors
  }
  return token;
}

export function loginUrl() {
  const key = process.env.KITE_API_KEY;
  const redirect = process.env.KITE_REDIRECT_URL;
  if (!key || !redirect) {
    throw new Error("Missing KITE_API_KEY or KITE_REDIRECT_URL env var");
  }
  // official connect login url pattern
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(
    key
  )}&redirect_params=${encodeURIComponent(redirect)}`;
}

export async function exchangeRequestToken(request_token) {
  // Exchange request token for access token using api_key + checksum
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

  const json = await res.json();
  if (!res.ok || !json.data || !json.data.access_token) {
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
  // path must start with /
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, error: "Missing access_token" };
  }
  const url = `${KITE_API}${path}`;
  const res = await fetch(url, { headers: kiteHeader(token) });
  const json = await res.json().catch(() => ({ ok: false, error: "Invalid JSON from kite" }));
  if (!res.ok) {
    // include message if available
    return { ok: false, status: res.status, ...json };
  }
  return { ok: true, ...json };
}

export async function kitePositions() {
  // returns simplified positions or error object
  try {
    const r = await kiteGet("/positions");
    return r;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function kiteFunds() {
  try {
    // some brokers return funds endpoint at /funds or /user/funds - using /user/funds is sometimes used.
    const r = await kiteGet("/user/funds");
    if (r.ok) return r;
    // fallback attempt
    const r2 = await kiteGet("/funds");
    return r2;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
