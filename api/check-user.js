import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "Method not allowed",
    });
  }

  try {
    // ✅ Vercel-safe body handling
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const { zid } = body || {};

    if (!zid) {
      return res.status(400).json({
        status: "error",
        message: "Missing User ID",
      });
    }

    // Fetch users list from Upstash
    const users = await redis.get("users:list");

    if (!Array.isArray(users)) {
      return res.status(404).json({
        status: "error",
        message: "No users found",
      });
    }

    // Find user
    const user = users.find((u) => u.id === zid);

    if (!user) {
      return res.status(403).json({
        status: "error",
        message: "User not registered",
      });
    }

    // Check subscription validity
    const now = Date.now();

    if (typeof user.valid_until !== "number" || user.valid_until < now) {
      const expDate =
        user.valid_until
          ? new Date(user.valid_until).toLocaleString()
          : "unknown";

      return res.status(403).json({
        status: "error",
        message: `Subscription expired on ${expDate}`,
      });
    }

    // ✅ All good
    return res.status(200).json({
      status: "ok",
      message: "User valid",
    });

  } catch (err) {
    console.error("check-user error:", err);

    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
}
