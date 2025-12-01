import { NextResponse } from "next/server";
import { getUserFromList } from "../../../_lib/user-list";
import { createKiteInstanceForUser } from "../../../_lib/kite-user-instance";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const user_id = searchParams.get("user_id");

    if (!user_id) {
      return NextResponse.json({ ok: false, error: "Missing user_id" });
    }

    const user = await getUserFromList(user_id);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Invalid user" });
    }

    const kc = await createKiteInstanceForUser(user_id);
    const book = await kc.getTrades();

    return NextResponse.json({
      ok: true,
      trades: book || []
    });

  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}
