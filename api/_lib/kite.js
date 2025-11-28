// =============================================
//  ORIGINAL IMPORTS
// =============================================
import { KiteConnect } from "kiteconnect";
import { kv } from "./kv.js";


// =============================================
//  🔥 GLOBAL ORDER LOGGER (ADDED)
// =============================================
function logOrderEvent(type, source, payload, result, error) {
  const ts = new Date().toISOString();

  console.log("====================================================");
  console.log(`🔥 KITE ORDER EVENT @ ${ts}`);
  console.log(`TYPE: ${type}`);
  console.log(`SOURCE: ${source}`);
  console.log("PAYLOAD:", payload);

  if (result) {
    console.log("✅ RESULT:", result);
  }

  if (error) {
    console.log("❌ ERROR:", error?.message || error);
  }

  console.log("STACK TRACE:");
  console.trace();

  console.log("====================================================");
}


// =============================================
//  🔥 WRAPPER FOR ALL ORDER FUNCTIONS (ADDED)
// =============================================
function wrapOrderFunctions(kc) {

  // ------- PLACE ORDER -------
  const originalPlaceOrder = kc.placeOrder.bind(kc);
  kc.placeOrder = async function (variety, params, source = "UNKNOWN") {
    logOrderEvent("placeOrder", source, { variety, params });

    try {
      const result = await originalPlaceOrder(variety, params);
      logOrderEvent("placeOrder SUCCESS", source, params, result, null);
      return result;

    } catch (err) {
      logOrderEvent("placeOrder ERROR", source, params, null, err);
      throw err;
    }
  };

  // ------- MODIFY ORDER -------
  const originalModify = kc.modifyOrder.bind(kc);
  kc.modifyOrder = async function (variety, order_id, params, source = "UNKNOWN") {
    logOrderEvent("modifyOrder", source, { variety, order_id, params });

    try {
      const result = await originalModify(variety, order_id, params);
      logOrderEvent("modifyOrder SUCCESS", source, params, result, null);
      return result;

    } catch (err) {
      logOrderEvent("modifyOrder ERROR", source, params, null, err);
      throw err;
    }
  };

  // ------- CANCEL ORDER -------
  const originalCancel = kc.cancelOrder.bind(kc);
  kc.cancelOrder = async function (variety, order_id, source = "UNKNOWN") {
    logOrderEvent("cancelOrder", source, { variety, order_id });

    try {
      const result = await originalCancel(variety, order_id);
      logOrderEvent("cancelOrder SUCCESS", source, {order_id}, result, null);
      return result;

    } catch (err) {
      logOrderEvent("cancelOrder ERROR", source, {order_id}, null, err);
      throw err;
    }
  };

  return kc;
}



// =============================================
//  ORIGINAL FUNCTIONS (UNCHANGED)
// =============================================
export async function getAccessToken() {
  return (await kv.get("kite:access_token")) || "";
}

export async function setAccessToken(token) {
  await kv.set("kite:access_token", token);
  return token;
}

export async function instance() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("Missing KITE_API_KEY");
  const kc = new KiteConnect({ api_key: apiKey });

  const token = await getAccessToken();
  if (!token) throw new Error("Kite not logged in");
  kc.setAccessToken(token);

  // =============================================
  //  🔥 ATTACH LOGGER WRAPPERS HERE (ADDED)
  // =============================================
  return wrapOrderFunctions(kc);
}

export function loginUrl() {
  const apiKey = process.env.KITE_API_KEY;
  const kc = new KiteConnect({ api_key: apiKey });
  return kc.getLoginURL();
}

export async function exchangeRequestToken(request_token) {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("Missing KITE_API_KEY/SECRET");
  const kc = new KiteConnect({ api_key: apiKey });
  const data = await kc.generateSession(request_token, apiSecret);
  await setAccessToken(data.access_token);
  return data;
}
