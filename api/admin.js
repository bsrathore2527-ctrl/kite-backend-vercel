// api/admin.js
// Admin lock endpoints: /api/admin
// Actions: acquire, renew, release, status
// Uses Upstash kv (imported from ./_lib/kv.js)

import { kv } from "./_lib/kv.js";

const LOCK_KEY = "guardian:admin:lock";
const LOCK_TTL = 60; // seconds - server-side expiry if heartbeat stops

// --- Helper to read JSON body (works in all runtimes) ---
async function readJson(req) {
  if (typeof req.json === "function") {
    return await req.json();
  }
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// --- Helper utilities ---
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function tokenHash(token = "") {
  return token ? token.slice(0, 12) : "";
}

function isAdminToken(token = "") {
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

// --- Main handler ---
export default async function handler(req, res) {
  try {
    // STATUS (GET)
    if (req.method === "GET") {
      const existing = await kv.get(LOCK_KEY);
      if (existing && existing.expiry < nowTs()) {
        await kv.del(LOCK_KEY);
        return res.json({ ok: true, locked: false });
      }
      return res.json({
        ok: true,
        locked: !!existing,
        owner: existing?.owner ?? null,
        expiry: existing?.expiry ?? null
      });
    }

    if (req.method !== "POST") {
      return res
        .status(405)
        .json({ ok: false, error: "method not allowed" });
    }

    // Parse JSON safely
    const body = await readJson(req);
    const action = body?.action;

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    // Authorization check
    if (action !== "status" && !isAdminToken(token)) {
      return res.status(403).json({ ok: false, error: "not authorized" });
    }

    // --- ACQUIRE LOCK ---
    if (action === "acquire") {
      const label = body.label || "web";
      const existing = await kv.get(LOCK_KEY);

      // Remove expired
      if (existing && existing.expiry < nowTs()) {
        await kv.del(LOCK_KEY);
      }

      const after = await kv.get(LOCK_KEY);
      if (!after) {
        const owner = {
          tokenHash: tokenHash(token),
          label,
          acquired_at: nowTs(),
        };
        const payload = { owner, expiry: nowTs() + LOCK_TTL };
        await kv.set(LOCK_KEY, payload);
        console.log("[admin] lock acquired by", owner.label, owner.tokenHash);
        return res.json({ ok: true, acquired: true, owner, expiry: payload.expiry });
      } else {
        return res.json({ ok: true, acquired: false, owner: after.owner, expiry: after.expiry });
      }
    }

    // --- RENEW LOCK ---
    if (action === "renew") {
      const existing = await kv.get(LOCK_KEY);
      if (!existing) return res.status(400).json({ ok: false, error: "no lock" });

      if (existing.owner?.tokenHash !== tokenHash(token)) {
        return res.status(403).json({ ok: false, error: "not lock owner" });
      }

      existing.expiry = nowTs() + LOCK_TTL;
      await kv.set(LOCK_KEY, existing);
      console.log("[admin] lock renewed by", existing.owner.label, existing.owner.tokenHash);
      return res.json({ ok: true, renewed: true, expiry: existing.expiry });
    }

    // --- RELEASE LOCK ---
    if (action === "release") {
      const existing = await kv.get(LOCK_KEY);
      if (!existing) return res.json({ ok: true, released: false, msg: "no lock" });

      if (existing.owner?.tokenHash !== tokenHash(token)) {
        return res.status(403).json({ ok: false, error: "not lock owner" });
      }

      await kv.del(LOCK_KEY);
      console.log("[admin] lock released by", existing.owner.label, existing.owner.tokenHash);
      return res.json({ ok: true, released: true });
    }

    // --- STATUS (POST variant) ---
    if (action === "status") {
      const existing = await kv.get(LOCK_KEY);
      if (existing && existing.expiry < nowTs()) {
        await kv.del(LOCK_KEY);
        return res.json({ ok: true, locked: false });
      }
      return res.json({
        ok: true,
        locked: !!existing,
        owner: existing?.owner ?? null,
        expiry: existing?.expiry ?? null
      });
    }

    // --- FALLBACK ---
    return res.json({ ok: false, error: "missing or unknown action" });

  } catch (e) {
    console.error("[admin] error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
