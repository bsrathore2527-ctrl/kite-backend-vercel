export default async function handler(req, res) {
  try {
    const adminToken = req.query.token || req.headers["x-admin-token"];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const apiKey = process.env.KITE_API_KEY;
    const redirectUrl = process.env.KITE_REDIRECT_URL;

    if (!apiKey || !redirectUrl) {
      return res.status(500).json({
        ok: false,
        error: "KITE_API_KEY or KITE_REDIRECT_URL not configured"
      });
    }

    // Zerodha OAuth login URL
    const loginUrl =
      `https://kite.trade/connect/login?api_key=${encodeURIComponent(apiKey)}` +
      `&v=3&redirect_url=${encodeURIComponent(redirectUrl)}`;

    // Redirect admin to Zerodha login
    res.writeHead(302, { Location: loginUrl });
    return res.end();

  } catch (err) {
    console.error("Master login error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
