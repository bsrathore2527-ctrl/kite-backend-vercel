export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, route: "guardianv2" });
}
