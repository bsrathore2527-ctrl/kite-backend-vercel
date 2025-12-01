// File: /api/_lib/kite-user.js

// User API credentials (from Vercel ENV)
const USER_API_KEY = process.env.USER_API_KEY;
const USER_API_SECRET = process.env.USER_API_SECRET;

if (!USER_API_KEY || !USER_API_SECRET) {
  console.error("⚠ USER_API_KEY or USER_API_SECRET is missing!");
}

/**
 * Create login URL for USER login
 */
export function getUserLoginUrl(user_id, redirectUrl) {
  // STATE is very important — used by callback to identify the user
  const state = user_id;

  return `https://kite.zerodha.com/connect/authorize?api_key=${USER_API_KEY}&v=3&redirect_uri=${encodeURIComponent(
    redirectUrl
  )}&state=${state}`;
}

/**
 * Exchange request_token → access_token
 * Zerodha User App version
 */
export async function exchangeRequestTokenUser(request_token) {
  try {
    const url = "https://api.kite.trade/session/token";

    const body = `api_key=${USER_API_KEY}&request_token=${request_token}&checksum=${checksum(
      USER_API_KEY + request_token + USER_API_SECRET
    )}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    const json = await res.json();
    return json.data || null;
  } catch (err) {
    console.error("exchangeRequestTokenUser ERROR:", err);
    return null;
  }
}

/**
 * Checksum generator (SHA-256)
 */
import crypto from "crypto";
function checksum(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}
