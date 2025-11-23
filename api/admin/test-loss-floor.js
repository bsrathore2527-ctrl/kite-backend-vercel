// api/admin/test-loss-floor.js
import { getState, setState } from '../state.js';

export default async function handler(req, res) {
  const { mtm } = req.query;
  if (mtm === undefined) {
    return res.status(400).json({ ok: false, error: "Provide ?mtm=value" });
  }
  const total = Number(mtm);
  const s = await getState();
  const patch = {
    live_test_mtm: total,
    last_test_at: Date.now()
  };
  await setState(patch);
  return res.status(200).json({ ok: true, test_mtm: total });
}
