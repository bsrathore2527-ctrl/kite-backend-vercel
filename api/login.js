export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method))
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // redirect to Zerodha login
    const loginUrl = `https://kite.trade/connect/login?api_key=${process.env.KITE_API_KEY}`;
    return res.status(200).json({ ok: true, redirect: loginUrl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
