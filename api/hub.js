// api/hub.js
// Full hub: debug routes + login + callback that stores access_token in Upstash.
// Copy-paste entire file into api/hub.js and redeploy.

async function buildKV() {
  try {
    const mod = await import("./_lib/kv.js");
    // if module exports kv and todayKey, use them
    if (mod.kv && typeof mod.todayKey === "function") {
      return { kv: mod.kv, todayKey: mod.todayKey, from: "module-kv" };
    }
    // if module provides getState/setState and todayKey, wrap them
    if (mod.getState && mod.setState && typeof mod.todayKey === "function") {
      const kvWrapper = {
        get: async (k) => {
          // return object stored at key in getState? We'll just use getState fallback
          return await mod.getState();
        },
        set: async (k, v) => {
          return await mod.setState(v);
        }
      };
      return { kv: kvWrapper, todayKey: mod.todayKey, from: "module-getters" };
    }
  } catch (e) {
    // ignore and fallback
  }

  // fallback: create Upstash client from env
  try {
    const { Redis } = await import("@upstash/redis");
    const url = process.env.UPSTASH_REDIS_REST_URL || "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    if (!url || !token) throw new Error("Missing UPSTASH env for fallback");
    const kv = new Redis({ url, token });
    const IST = "Asia/Kolkata";
    function todayKey(d = new Date()) {
      const now = new Date(d.toLocaleString("en-US", { timeZone: IST }));
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    return { kv, todayKey, from: "fallback" };
  } catch (e) {
    throw new Error("Cannot init KV: " + (e.message || String(e)));
  }
}

function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request", code = 400) =>
  send(res, code, { ok: false, error: msg });

function maskToken(t = "") {
  if (!t) return "";
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}…${t.slice(-6)}`;
}

async function getStateUsingKV(kv, todayKeyFn) {
  const key = `risk:${todayKeyFn()}`;
  const v = await kv.get(key);
  return v || {};
}
async function setStateUsingKV(kv, todayKeyFn, patch = {}) {
  const key = `risk:${todayKeyFn()}`;
  const cur = (await kv.get(key)) || {};
  const next = { ...cur, ...patch };
  await kv.set(key, next);
  return next;
}

// helper to safely import kite helper module (if present)
async function loadKiteHelper() {
  try {
    const mod = await import("./_lib/kite.js");
    return mod;
  } catch (e) {
    // ignore
    return null;
  }
}

export default async function handler(req, res) {
  try {
    // initialize & cache KV
    if (!global.__HUB_KV_READY) {
      global.__HUB_KV = await buildKV();
      global.__HUB_KV_READY = true;
      global.__HUB_KV.kvRef = global.__HUB_KV.kv;
      global.__HUB_KV.todayKeyFn = global.__HUB_KV.todayKey;
    }
    const { kv: kvRef, todayKeyFn, from } = global.__HUB_KV;

    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `https://${host}`);
    const path = url.pathname || "/";

    // ----------------- Health / Debug -----------------
    if ((path === "/api/hub" || path === "/api/hub/status") && req.method === "GET") {
      return ok(res, {
        status: "hub ok",
        time: new Date().toISOString(),
        kv_source: from,
        state_key: todayKeyFn()
      });
    }

    if (path === "/api/debug/token" && req.method === "GET") {
      const s = await getStateUsingKV(kvRef, todayKeyFn);
      const t = s?.access_token || s?.accessToken || "";
      return ok(res, {
        has_token: !!t,
        token_masked: maskToken(t),
        state_key: todayKeyFn(),
        raw_state_keys: Object.keys(s || {})
      });
    }

    if (path === "/api/debug/clear" && req.method === "POST") {
      const s = (await getStateUsingKV(kvRef, todayKeyFn)) || {};
      const next = { ...s };
      delete next.access_token;
      delete next.accessToken;
      await setStateUsingKV(kvRef, todayKeyFn, next);
      return ok(res, { cleared: true, state_key: todayKeyFn() });
    }

    // ----------------- Login: redirect to Kite -----------------
    if (path === "/api/login" && req.method === "GET") {
      const kite = await loadKiteHelper();
      try {
        if (kite && typeof kite.loginUrl === "function") {
          const loginUrl = kite.loginUrl();
          // normal behavior: redirect user to kite login
          res.writeHead(302, { Location: loginUrl });
          res.end();
          return;
        } else {
          // fallback: construct login url from env KITE_API_KEY if available
          const key = process.env.KITE_API_KEY || "";
          if (!key) return bad(res, "Missing KITE_API_KEY");
          const loginUrl = `https://kite.trade/connect/login?api_key=${encodeURIComponent(key)}&v=3`;
          res.writeHead(302, { Location: loginUrl });
          res.end();
          return;
        }
      } catch (e) {
        console.error("login err", e);
        return bad(res, e.message || "Login init failed");
      }
    }

    // ----------------- Callback: exchange request_token for access_token -----------------
    if (path === "/api/callback" && req.method === "GET") {
      try {
        const params = url.searchParams;
        const request_token = params.get("request_token");
        console.log("CALLBACK HIT:", { request_token, search: url.search });
        if (!request_token) {
          console.warn("Missing request_token in callback url:", url.href);
          // redirect to admin with query so UI can show hint
          const redirectTo = (process.env.POST_LOGIN_REDIRECT || "/admin.html") + "?kite=missing_request_token";
          res.writeHead(302, { Location: redirectTo });
          res.end();
          return;
        }

        // Try to use kite helper's generateSession if available
        const kite = await loadKiteHelper();
        if (kite && typeof kite.generateSession === "function") {
          try {
            const data = await kite.generateSession(request_token);
            const token = data?.access_token || data?.accessToken || "";
            if (!token) {
              console.error("generateSession returned no access_token", data);
              const redirectTo = (process.env.POST_LOGIN_REDIRECT || "/admin.html") + "?kite=session_failed";
              res.writeHead(302, { Location: redirectTo });
              res.end();
              return;
            }
            // store token in today's state
            await setStateUsingKV(kvRef, todayKeyFn, { access_token: token });
            console.log("GENERATE SESSION: stored token (masked):", token.slice(0,6) + "…" + token.slice(-6));
            const redirectTo = process.env.POST_LOGIN_REDIRECT || "/admin.html";
            res.writeHead(302, { Location: redirectTo });
            res.end();
            return;
          } catch (e) {
            console.error("generateSession error:", e && e.stack ? e.stack : e);
            const redirectTo = (process.env.POST_LOGIN_REDIRECT || "/admin.html") + "?kite=session_error";
            res.writeHead(302, { Location: redirectTo });
            res.end();
            return;
          }
        }

        // Fallback: if no kite helper, attempt to call KiteConnect directly here
        try {
          const { KiteConnect } = await import("kiteconnect");
          const apiKey = process.env.KITE_API_KEY;
          const apiSecret = process.env.KITE_API_SECRET;
          if (!apiKey || !apiSecret) {
            console.error("Missing KITE_API_KEY/SECRET for direct generateSession fallback");
            const redirectTo = (process.env.POST_LOGIN_REDIRECT || "/admin.html") + "?kite=missing_app_creds";
            res.writeHead(302, { Location: redirectTo });
            res.end();
            return;
          }
          const kc = new KiteConnect({ api_key: apiKey });
          const data = await kc.generateSession(request_token, apiSecret);
          const token = data?.access_token || "";
          if (!token) {
            console.error("Direct generateSession returned no token", data);
            const redirectTo = (process.env.POST_LOGIN_REDIRECT || "/admin.html") + "?kite=session_failed2";
            res.writeHead(302, { Location: redirectTo });
            res.end();
            return;
          }
          // store
          await setStateUsingKV(kvRef, todayKeyFn, { access_token: token });
          console.log("DIRECT GENERATE SESSION: stored token masked:", token.slice(0,6) + "…" + token.slice(-6));
          const redirectTo = process.env.POST_LOGIN_REDIRECT || "/admin.html";
          res.writeHead(302, { Location: redirectTo });
          res.end();
          return;
        } catch (e) {
          console.error("Direct generateSession fallback failed:", e && e.stack ? e.stack : e);
          const redirectTo = (process.env.POST_LOGIN_REDIRECT || "/admin.html") + "?kite=session_error3";
          res.writeHead(302, { Location: redirectTo });
          res.end();
          return;
        }
      } catch (e) {
        console.error("callback outer error:", e && e.stack ? e.stack : e);
        return bad(res, e.message || "Callback failed");
      }
    }

    // ----------------- State read (public) -----------------
    if (path === "/api/state" && req.method === "GET") {
      const s = await getStateUsingKV(kvRef, todayKeyFn);
      const t = s?.access_token || s?.accessToken || "";
      const kite_status = t ? "ok" : "";
      const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
      return ok(res, { time: now, admin: false, kite_status, state: s, key: todayKeyFn() });
    }

    // unknown route
    return bad(res, "Unknown route", 404);
  } catch (err) {
    console.error("HUB ERROR:", err && err.stack ? err.stack : err);
    return send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}
