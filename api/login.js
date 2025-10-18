import { withCors } from "./_lib/cors.js";
import { instance } from "./_lib/kite.js";

export default withCors(async function handler(req, res) {
  const kc = instance();
  // Redirect the user to Zerodha login
  const url = kc.getLoginURL({
    api_key: process.env.KITE_API_KEY,
    redirect_params: {},
    // Some SDKs accept only `getLoginURL()`; fallback if options unsupported
  });
  // In case SDK signature differs, ensure KITE_REDIRECT_URL is set in your app dashboard
  res.writeHead(302, { Location: url });
  res.end();
});
