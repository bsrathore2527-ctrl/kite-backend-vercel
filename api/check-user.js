import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      status: "error",
      message: "Method not allowed",
    });
  }

  try {
    const { zid } = JSON.parse(req.body || "{}");

    if (!zid) {
      return res.status(400).json({
        status: "error",
        message: "Missing ID",
      });
    }

    const users = await redis.get("users:list");

    if (!Array.isArray(users)) {
      return res.status(404).json({
        status: "error",
        message: "No users found",
      });
    }

    const user = users.find((u) => u.id === zid);

    if (!user) {
      return res.status(403).json({
        status: "error",
        message: "User not registered",
      });
    }

    const now = Date.now();

    if (user.valid_until < now) {
      const expDate = new Date(user.valid_until).toLocaleString();
      return res.status(403).json({
        status: "error",
        message: `Subscription expired on ${expDate}`,
      });
    }

    return res.status(200).json({
      status: "ok",
      message: "User valid",
    });

  } catch (err) {
    console.error("check-user error:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal error",
    });
  }
}
