// api/_lib/auth.js
// Single source-of-truth for admin authorization.

export function extractAuthToken(req) {
  if (!req || !req.headers) return "";
  const a = req.headers.authorization || req.headers.Authorization || "";
  return a.startsWith("Bearer ") ? a.slice(7) : a;
}

export function isAdminFromReq(req) {
  const token = extractAuthToken(req);
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export function requireAdmin(res) {
  res.status(401).json({ ok: false, error: "unauthorized" });
}
