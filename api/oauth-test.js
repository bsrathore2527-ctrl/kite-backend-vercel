// api/oauth-test.js
export default function handler(req, res) {
  res.redirect(
    "https://kite.zerodha.com/connect/login" +
    "?v=3" +
    `&api_key=${process.env.KITE_API_KEY}` +
    "&state=HARD_PROOF"
  );
}
