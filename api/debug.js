import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const { searchParams } = new URL(req.url, "http://localhost");
    const key = searchParams.get("key");

    if (!key) {
      return res.status(400).json({ error: "Missing key parameter" });
    }

    const val = await kv.get(key);

    return res.status(200).json({
      key,
      exists: val !== null && val !== undefined,
      value: val
    });

  } catch (err) {
    console.error("DEBUG ERROR:", err);
    return res.status(500).json({ error: "debug failed", message: err.message });
  }
}
