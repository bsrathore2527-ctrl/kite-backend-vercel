// api/admin.js
// Admin lock endpoints: /api/admin
// Actions: acquire, renew, release, status
// Uses Upstash kv (imported from ./_lib/kv.js)

import { kv } from "./_lib/kv.js";

const LOCK_KEY = "guardian:admin:lock";
const LOCK_TTL = 60; // seconds - server-side expiry if heartbeat stops

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function tokenHash(token = "") {
  // store only a short hash so we don't persist entire token
  return token ? token.slice(0, 12) : "";
}

function isAdminToken(token = "") {
  // simple equality check against env var
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  try {
    // Accept POST for actions. Allow GET for simple status check too.
    if (req.method === "GET") {
      // status convenience
      const existing = await kv.get(LOCK_KEY);
      if (existing && existing.expiry < nowTs()) {
        await kv.del(LOCK_KEY);
        return res.json({ ok: true, locked: false });
      }
      return res.json({ ok: true, locked: !!existing, owner: existing?.owner ?? null, expiry: existing?.expiry ?? null });
    }

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // extract bearer token if present
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    // allow 'status' action even if not admin
    if (action !== "status" && !isAdminToken(token)) {
      return res.status(403).json({ ok: false, error: "not authorized" });
    }

    // ACTION: acquire
    if (action === "acquire") {
      const label = body.label || "web";
      const existing = await kv.get(LOCK_KEY);

      // remove expired lock (defensive)
      if (existing && existing.expiry < nowTs()) {
        await kv.del(LOCK_KEY);
      }

      const after = await kv.get(LOCK_KEY); // re-read
      if (!after) {
        const owner = {
          tokenHash: tokenHash(token),
          label,
          acquired_at: nowTs(),
        };
        const payload = { owner, expiry: nowTs() + LOCK_TTL };
        await kv.set(LOCK_KEY, payload);
        console.log("[admin] lock acquired by", owner.label, owner.tokenHash, "expiry", payload.expiry);
        return res.json({ ok: true, acquired: true, owner, expiry: payload.expiry });
      } else {
        // locked by someone else
        return res.json({ ok: true, acquired: false, owner: after.owner, expiry: after.expiry });
      }
    }

    // ACTION: renew (heartbeat)
    if (action === "renew") {
      const existing = await kv.get(LOCK_KEY);
      if (!existing) return res.status(400).json({ ok: false, error: "no lock" });

      if (existing.owner?.tokenHash !== tokenHash(token)) {
        return res.status(403).json({ ok: false, error: "not lock owner" });
      }

      existing.expiry = nowTs() + LOCK_TTL;
      await kv.set(LOCK_KEY, existing);
      // small log for debug
      console.log("[admin] lock renewed by", existing.owner.label, existing.owner.tokenHash, "newExpiry", existing.expiry);
      return res.json({ ok: true, renewed: true, expiry: existing.expiry });
    }

    // ACTION: release
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

    // ACTION: status (POST variant)
    if (action === "status") {
      const existing = await kv.get(LOCK_KEY);
      if (existing && existing.expiry < nowTs()) {
        await kv.del(LOCK_KEY);
        return res.json({ ok: true, locked: false });
      }
      return res.json({ ok: true, locked: !!existing, owner: existing?.owner ?? null, expiry: existing?.expiry ?? null });
    }

    return res.json({ ok: false, error: "missing or unknown action" });
  } catch (e) {
    console.error("[admin] error:", e && e.stack ? e.stack : e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
