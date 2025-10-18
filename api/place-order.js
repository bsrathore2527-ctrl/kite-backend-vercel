import { withCors } from "./_lib/cors.js";
import { instance, readAccessToken } from "./_lib/kite.js";

const VALID_TRANSACTION = ["BUY", "SELL"];
const VALID_ORDER_TYPE = ["MARKET", "LIMIT", "SL", "SL-M"]; // SL requires price+trigger; SL-M requires trigger
const VALID_PRODUCT = ["CNC", "MIS", "NRML"]; // CNC: equity delivery, MIS/NRML: intraday/carryforward
const VALID_EXCHANGE = ["NSE", "BSE", "NFO", "CDS", "MCX", "BFO"]; // depending on segment access
const VALID_VALIDITY = ["DAY", "IOC"]; // DAY (default), IOC
const VALID_VAR = ["regular", "amo", "iceberg", "co"]; // availability depends on instrument/segment

function require(value, name) {
  if (value === undefined || value === null || value === "") {
    const err = new Error(`${name} is required`);
    err.status = 400; throw err;
  }
}

export default withCors(async function handler(req, res) {
  try {
    if (process.env.KILL_ALL === "1") {
      return res.status(423).json({ error: "Trading disabled (Kill Switch ON)", code: "KILL_SWITCH_ENABLED" });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).end("Method Not Allowed");
    }

    const at = readAccessToken(req);
    if (!at) return res.status(401).json({ error: "Not authenticated" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    const {
      tradingsymbol,
      exchange,
      transaction_type,
      quantity,
      product = "MIS",
      order_type = "MARKET",
      price,
      trigger_price,
      validity = "DAY",
      disclosed_quantity,
      variety = "regular",
      tag,
      // advanced/optional
      iceberg_legs,
      iceberg_quantity,
      stoploss,
      squareoff,
      trailing_stoploss,
      // for options: validity_ttl not supported in Node SDK as of now
    } = body;

    // Basic validations
    require(tradingsymbol, "tradingsymbol");
    require(exchange, "exchange");
    require(transaction_type, "transaction_type");
    require(quantity, "quantity");

    if (!VALID_EXCHANGE.includes(exchange)) throw Object.assign(new Error("Invalid exchange"), { status: 400 });
    if (!VALID_TRANSACTION.includes(transaction_type)) throw Object.assign(new Error("Invalid transaction_type"), { status: 400 });
    if (!VALID_ORDER_TYPE.includes(order_type)) throw Object.assign(new Error("Invalid order_type"), { status: 400 });
    if (!VALID_PRODUCT.includes(product)) throw Object.assign(new Error("Invalid product"), { status: 400 });
    if (!VALID_VALIDITY.includes(validity)) throw Object.assign(new Error("Invalid validity"), { status: 400 });
    if (!VALID_VAR.includes(variety)) throw Object.assign(new Error("Invalid variety"), { status: 400 });

    // Price/trigger constraints
    if (order_type === "LIMIT" && (price === undefined || price === null)) {
      throw Object.assign(new Error("price is required for LIMIT orders"), { status: 400 });
    }
    if ((order_type === "SL" || order_type === "SL-M") && (trigger_price === undefined || trigger_price === null)) {
      throw Object.assign(new Error("trigger_price is required for SL/SL-M"), { status: 400 });
    }
    if (order_type === "SL" && (price === undefined || price === null)) {
      throw Object.assign(new Error("price is required for SL orders"), { status: 400 });
    }

    const kc = instance(at);

    const params = {
      exchange,
      tradingsymbol,
      transaction_type,
      quantity: Number(quantity),
      product,
      order_type,
      validity,
      disclosed_quantity: disclosed_quantity ? Number(disclosed_quantity) : undefined,
      price: price !== undefined ? Number(price) : undefined,
      trigger_price: trigger_price !== undefined ? Number(trigger_price) : undefined,
      tag,
      // BO deprecated at broker level; CO/iceberg fields are conditional
      squareoff: squareoff !== undefined ? Number(squareoff) : undefined,
      stoploss: stoploss !== undefined ? Number(stoploss) : undefined,
      trailing_stoploss: trailing_stoploss !== undefined ? Number(trailing_stoploss) : undefined,
      iceberg_legs: iceberg_legs !== undefined ? Number(iceberg_legs) : undefined,
      iceberg_quantity: iceberg_quantity !== undefined ? Number(iceberg_quantity) : undefined,
    };

    const orderResp = await kc.placeOrder(variety, params);
    return res.json(orderResp);
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message || "Order failed", details: e });
  }
});
