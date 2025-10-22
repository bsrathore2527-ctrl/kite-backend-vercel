// api/_lib/kv.js
export const IST = "Asia/Kolkata";

export function todayKey(d = new Date()) {
  const now = new Date(d.toLocaleString("en-US", { timeZone: IST }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
