// api/_lib/kite.js
import crypto from "crypto";

// robust import helper: try to load kv from same folder, tolerate default or named exports
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
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, error: "Missing access_token" };
  }
  const url = `${KITE_API}${path}`;
  const res = await fetch(url, { headers: kiteHeader(token) });
  const json = await res.json().catch(() => ({ ok: false, error: "Invalid JSON from kite" }));
  if (!res.ok) {
    return { ok: false, status: res.status, ...json };
  }
  return { ok: true, ...json };
}

export async function kitePositions() {
  try {
    return await kiteGet("/positions");
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function kiteFunds() {
  try {
    const r = await kiteGet("/user/funds");
    if (r.ok) return r;
    return await kiteGet("/funds");
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
