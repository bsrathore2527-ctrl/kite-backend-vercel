// api/admin/[...slug].js
import { kv, setState, getState } from "../_lib/kv.js";

function send(res, code, body) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
function ok(res, body = {}) { send(res, 200, { ok: true, ...body }); }
function bad(res, msg, code = 400) { send(res, code, { ok: false, error: msg }); }

function isAdmin(req) {
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  return token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return bad(res, "Method not allowed", 405);
  const slug = Array.isArray(req.query.slug) ? req.query.slug[0] : req.query.slug || "";
  if (!isAdmin(req)) return bad(res, "Unauthorized", 401);

  try {
    switch (slug) {
      case "lock":
        await kv.set("guardian:lock", { at: Date.now() });
        return ok(res, { msg: "Lock acquired" });

      case "release":
        await kv.del("guardian:lock");
        return ok(res, { msg: "Lock released" });

      case "enforce":
        await kv.set("guardian:last_enforce", { at: Date.now() });
        return ok(res, { msg: "Enforcement triggered" });

      case "reset-consecutive":
        await setState({ consecutive_losses: 0 });
        return ok(res, { msg: "Consecutive losses reset" });

      case "kill":
        return ok(res, { msg: "Kill executed (stub)" });

      case "cancel-all":
        return ok(res, { msg: "Cancel all executed (stub)" });

      case "allow-new":
        const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
        await setState({ block_new_orders: !body.allow });
        return ok(res, { msg: "Allow new orders updated", allow: body.allow });

      default:
        return ok(res, { msg: "Admin endpoint ready", slug });
    }
  } catch (e) {
    return bad(res, e.message || String(e), 500);
  }
}
