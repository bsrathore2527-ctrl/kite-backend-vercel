// api/_lib/utils.js
export function adjustedEquityFromFunds(funds) {
  if (!funds) return 0;
  const utilised = funds.utilised ?? funds?.utilised ?? {};
  const live = Number(
    funds.balance ??
    funds?.available?.live_balance ??
    funds?.net ??
    funds?.available?.cash ??
    funds?.cash ??
    0
  );
  const exposure = Number(utilised.exposure ?? 0);
  const debits = Number(utilised.debits ?? 0);
  const optPrem = Number(utilised.option_premium ?? 0);
  return live + exposure + debits + Math.abs(optPrem || 0);
}
