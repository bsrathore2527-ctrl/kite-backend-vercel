import { KiteConnect } from "kiteconnect";
import cookie from "cookie";
import sig from "cookie-signature";

const COOKIE_NAME = "kite_at";
const COOKIE_SECRET = process.env.COOKIE_SECRET;

export function instance(access_token) {
  const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  if (access_token) kc.setAccessToken(access_token);
  return kc;
}

export function readAccessToken(req) {
  const cookies = cookie.parse(req.headers.cookie || "");
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  if (!COOKIE_SECRET || !raw.startsWith("s:")) return null;
  const unsigned = sig.unsign(raw.slice(2), COOKIE_SECRET);
  return unsigned || null;
}

export function setAccessTokenCookie(res, token) {
  const value = "s:" + sig.sign(token, COOKIE_SECRET);
  res.setHeader("Set-Cookie", cookie.serialize(COOKIE_NAME, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 6 // 6 hours (access token validity)
  }));
}
