import KiteConnect from "kiteconnect";
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const { request_token, user_id } = req.query;

    if (!request_token || !user_id) {
      return res.status(400).send("Missing request_token or user_id");
    }

    if (!process.env.USER_API_KEY || !process.env.USER_API_SECRET) {
      return res.status(500).send("Missing USER_API_KEY or USER_API_SECRET");
    }

    console.log("Callback for:", user_id);

    const kc = new KiteConnect({
      api_key: process.env.USER_API_KEY,
    });

    // Exchange request token → access token
    const session = await kc.generateSession(
      request_token,
      process.env.USER_API_SECRET
    );

    const access_token = session.access_token;

    // ---------------------------------------------
    // SAVE SINGLE ACTIVE SESSION (current user)
    // ---------------------------------------------
    await kv.set("kite:current:token", {
      access_token,
      updated_at: Date.now(),
    });

    await kv.set("kite:current:user_id", user_id);

    // ---------------------------------------------
    // SAVE USER INFO (multi-user kv structure)
    // ---------------------------------------------
    const existing = (await kv.get(`user:${user_id}:info`)) || {};

    await kv.set(`user:${user_id}:info`, {
      id: user_id,
      connected: true,
      last_login: Date.now(),
      valid_until: existing.valid_until || null,
      expired: existing.expired || false,
    });

    // ---------------------------------------------
    // CREATE STATE IF MISSING
    // ---------------------------------------------
    const stateKey = `user:${user_id}:state`;
    if (!(await kv.get(stateKey))) {
      await kv.set(stateKey, {
        realised: 0,
        unrealised: 0,
        capital_day_915: 0,
        max_loss_pct: 0,
        max_profit_pct: 0,
        active_loss_floor: 0,
        remaining_to_max_loss: 0,
        consecutive_losses: 0,
        tripped: false,
        tripped_day: false,
        cooldown_active: false,
        last_trade_time: 0,
      });
    }

    // Redirect back to dashboard
    return res.redirect(`/user.html?login=success`);

  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect(`/user.html?login=failed`);
  }
}
