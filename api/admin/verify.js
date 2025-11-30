export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({ ok: false, error: "Token missing" });
    }

    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

    if (!ADMIN_TOKEN) {
      console.error("ADMIN_TOKEN env var missing!");
      return res.status(500).json({ ok: false, error: "Server config error" });
    }

    // Secure comparison
    if (token === ADMIN_TOKEN) {
      return res.status(200).json({ ok: true });
    }

    return res.status(401).json({ ok: false });
  } catch (err) {
    console.error("Verify admin error:", err);
    res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
