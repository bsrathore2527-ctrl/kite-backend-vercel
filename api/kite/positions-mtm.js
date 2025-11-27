import { kv } from "../_lib/kv.js";
import { kiteConnectClient } from "../_lib/kite.js";

export default async function handler(req, res) {
    try {
        const kc = await kiteConnectClient();
        if (!kc) {
            return res.json({ ok: false, error: "Kite client not available" });
        }

        // 1️⃣ Fetch positions
        const positions = await kc.positions();
        const net = positions?.net || [];

        // If no positions → MTM = 0
        if (!net.length) {
            const zero = { realised: 0, unrealised: 0, total_pnl: 0 };
            await kv.set("live:mtm", zero);
            return res.json({ ok: true, ...zero, live_mtm_written: true });
        }

        // 2️⃣ Build token list for LTP fetch
        const tokens = net
            .filter(p => Number(p.quantity) !== 0)
            .map(p => `${p.exchange}:${p.tradingsymbol}`);

        let quotes = {};
        if (tokens.length > 0) {
            try {
                quotes = await kc.getLTP(tokens);
            } catch (e) {
                console.error("Error fetching LTP:", e);
            }
        }

        // 3️⃣ MTM Calculation (SURGICAL PATCH)
        let totalReal = 0;
        let totalUnreal = 0;
        let totalPnl = 0;

        for (const p of net) {
            const qty = Number(p.quantity);
            const real = Number(p.realised || 0);   // REALISED from Zerodha → correct always
            let unreal = 0;

            if (qty !== 0) {
                const key = `${p.exchange}:${p.tradingsymbol}`;
                const q = quotes[key];

                if (q && typeof q.last_price === "number") {
                    const ltp = Number(q.last_price);
                    const avg = Number(p.average_price);
                    unreal = (ltp - avg) * qty;      // 🔥 LIVE UNREALISED MTM
                }
            }

            totalReal += real;
            totalUnreal += unreal;
            totalPnl += real + unreal;
        }

        // 4️⃣ KV object
        const mtmObj = {
            realised: Number(totalReal.toFixed(2)),
            unrealised: Number(totalUnreal.toFixed(2)),
            total_pnl: Number(totalPnl.toFixed(2)),
            ts: Date.now()
        };

        // 5️⃣ Save to KV
        await kv.set("live:mtm", mtmObj);

        // 6️⃣ Return
        return res.json({
            ok: true,
            ...mtmObj,
            live_mtm_written: true
        });

    } catch (err) {
        console.error("positions-mtm error:", err);
        return res.json({ ok: false, error: String(err) });
    }
}
