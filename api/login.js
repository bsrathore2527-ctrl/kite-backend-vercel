export default async function handler(req, res) {
  // --- CORS FIX ---
  res.setHeader("Access-Control-Allow-Origin", "https://www.boho.trading");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // -----------------------------
    // OPTIONAL: Admin Key Check
    // -----------------------------
    const ADMIN_KEY = process.env.ADMIN_KEY;

    const providedKey = req.headers["x-admin-key"];
    if (!providedKey || providedKey !== ADMIN_KEY) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or missing admin key"
      });
    }

    // -----------------------------
    // Zerodha Login URL Generator
    // -----------------------------
    const apiKey = process.env.KITE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing KITE_API_KEY in environment"
      });
    }

    const kiteLoginURL =
      "https://kite.zerodha.com/connect/authorize" +
      `?api_key=${apiKey}` +
      "&v=3";

    return res.status(200).json({
      ok: true,
      url: kiteLoginURL
    });

  } catch (err) {
    console.error("LOGIN API ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error"
    });
  }
}
