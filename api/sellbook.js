//---------------------------------------------------------
// SELLBOOK — FULLY PATCHED
//---------------------------------------------------------

async function loadSellBook(){
    const box = $('sellbook_box');
    box.innerHTML = '<div class="loading">Loading SellBook…</div>';

    try {
        const r = await fetch('/api/sellbook');
        const j = await r.json();

        if (!j.ok) {
            box.innerHTML = `<div class="err">Error loading sellbook: ${j.error || 'Unknown error'}</div>`;
            return;
        }

        renderSellBook(j.sell_orders || j.sellbook || []);
    } 
    catch (err) {
        box.innerHTML = `<div class="err">Failed to load sellbook: ${String(err)}</div>`;
    }
}


function renderSellBook(list){
    if (!Array.isArray(list)) list = [];

    // Sort NEWEST FIRST
    list.sort((a,b) => (b.time_ms || 0) - (a.time_ms || 0));

    let html = `
    <table class="tbl">
        <thead>
            <tr>
                <th>Instrument</th>
                <th>Time</th>
                <th>MTM</th>
                <th>Change</th>
            </tr>
        </thead>
        <tbody>
    `;

    for (const s of list){
        html += sellRowHtml(s);
    }

    html += "</tbody></table>";
    $('sellbook_box').innerHTML = html;
}


//---------------------------------------------------------
// PATCHED TIME-LOGIC SELLBOOK ROW RENDERER
//---------------------------------------------------------

function sellRowHtml(s){
    const sym = s.instrument || s.symbol || "";
    const qty = s.qty || "";
    const mtm = Number(s.mtm || 0);
    const chg = Number(s.mtm_change || 0);

    //-----------------------------------------------------
    // TIME PATCH (NO MORE UTC → IST WRONG SHIFT)
    //
    // Priority order:
    // 1. s.iso  → FULLY TRUSTED (created by backend)
    // 2. s.time_ms → fallback for older entries
    // 3. Now() → final fallback
    //-----------------------------------------------------

    let time = "";

    if (s.iso) {
        // s.iso contains: "26/11/2025, 8:11:52 pm" (IST already)
        // We show the time-part only
        let parts = s.iso.split(",");
        if (parts.length >= 2) {
            time = parts[1].trim();   // “8:11:52 pm”
        } else {
            time = s.iso;             // fallback
        }
    } 
    else {
        const ts = s.time_ms || s.time || Date.now();
        const d = new Date(ts);
        time = d.toLocaleTimeString('en-IN', { hour12:false, timeZone:'Asia/Kolkata' });
    }

    return `
    <tr>
        <td>${sym}</td>
        <td>${time}</td>
        <td>₹${mtm.toLocaleString()}</td>
        <td class="${chg < 0 ? 'neg' : 'pos'}">${chg}</td>
    </tr>`;
}
