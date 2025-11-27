import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";   // ✔ correct import

export default async function handler(req, res) {
    try {
        // 1️⃣ Get Kite Client
        const kc = await instance();          // ✔ correct client call

        // 2️⃣ Fetch positions
        const positions = await kc.getPositions();
        const net = positions?.net || [];

        if (!net.length) {
            const zero = { realised: 0, unrealised: 0, total_pnl: 0 };
            await kv.set("live:mtm", zero);
            return res.json({ ok: true, ...zero, live_mtm_written: true });
        }

        // 3️⃣ Build tokens for LTP
        const tokens = net
            .filter(p => Number(p.quantity) !== 0)
            .map(p => `${p.exchange}:${p.tradingsymbol}`);

        let quotes = {};
        if (tokens.length > 0) {
            try {
                quotes = await kc.getLTP(tokens);   // ✔ correct Zerodha method
            } catch (err) {
                console.error("LTP error:", err);
            }
        }

        // 4️⃣ Surgical MTM logic
        let totalReal = 0;
        let totalUnreal = 0;
        let totalPnl = 0;

        for (const p of net) {
            const qty = Number(p.quantity);
            const real = Number(p.realised || 0);    // ✔ REALISED stays

            let unreal = 0;

            if (qty !== 0) {
                const key = `${p.exchange}:${p.tradingsymbol}`;
                const q = quotes[key];

                if (q?.last_price) {
                    const ltp = Number(q.last_price);
                    const avg = Number(p.average_price);
                    unreal = (ltp - avg) * qty;      // 🔥 LIVE MTM
                }
            }

            totalReal += real;
            totalUnreal += unreal;
            totalPnl += real + unreal;
        }

        // 5️⃣ Insert into KV
        const mtmObj = {
            realised: Number(totalReal.toFixed(2)),
            unrealised: Number(totalUnreal.toFixed(2)),
            total_pnl: Number(totalPnl.toFixed(2)),
            ts: Date.now()
        };

        await kv.set("live:mtm", mtmObj);

        // 6️⃣ Respond
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
