

// --- UTC / timestamp helpers merged from time.js ---
export function normalizeTsToMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    const s = String(Math.trunc(ts));
    return s.length === 10 ? ts * 1000 : ts;
  }
  const raw = String(ts).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return String(Math.trunc(n)).length === 10 ? n * 1000 : n;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    const fixed = raw.replace(' ', 'T') + 'Z';
    const p = Date.parse(fixed);
    return Number.isNaN(p) ? null : p;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

export function todayKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function msForUTCHourMinute(hour, minute, d = new Date()) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
}

export function nowMs() {
  return Date.now();
}

