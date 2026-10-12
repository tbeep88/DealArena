(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const terminal = (status) => ['WON', 'SETTLED', 'REFUNDED', 'FAILED'].includes(status);
  function integer(value, name = 'amount', allowZero = false) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`Invalid ${name}`);
    return n;
  }
  function cents(value) {
    const text = String(value).trim().replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Invalid dollar amount');
    const [whole, fraction = ''] = text.split('.');
    return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), 'amount');
  }
  const dollars = (amount) => `$${(integer(amount, 'amount', true) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  function addCohort(cohorts, id, units, priceCents) {
    integer(units, 'units'); integer(priceCents);
    const previous = cohorts.find((entry) => entry.id === id);
    if (previous) {
      if (previous.units !== units || previous.priceCents !== priceCents) throw new Error('Commitment ID conflict');
      return cohorts;
    }
    return [...cohorts, { id, units, priceCents, provenance: 'SIMULATED' }];
  }
  function totals(cohorts, priceCents = 0, status = 'OPEN') {
    integer(priceCents, 'price', true);
    const buyers = cohorts.reduce((n, c) => n + integer(c.units, 'units'), 0);
    const committedCents = cohorts.reduce((n, c) => n + c.units * integer(c.priceCents), 0);
    integer(committedCents, 'total', true);
    const grossCents = buyers * priceCents;
    integer(grossCents, 'gross', true);
    const funded = priceCents > 0 && buyers > 0 && cohorts.every((c) => c.priceCents >= priceCents);
    if (status === 'WON' && !funded) throw new Error('Insufficient buyer funding');
    const feeCents = status === 'WON' ? Math.floor(grossCents / 100) : 0;
    const refunds = cohorts.map((c) => ({ ...c, refundCents: status === 'REFUNDED' ? c.units * c.priceCents : status === 'WON' ? c.units * (c.priceCents - priceCents) : 0 }));
    const refundedCents = refunds.reduce((n, c) => n + c.refundCents, 0);
    const payoutCents = status === 'WON' ? grossCents - feeCents : 0;
    const escrowCents = committedCents - refundedCents - payoutCents - feeCents;
    return { buyers, committedCents, grossCents, feeCents, payoutCents, refundedCents, escrowCents, funded, shortfallCents: Math.max(0, grossCents - committedCents), refunds };
  }

  function simulatedPaymentLedger(marketId, cohorts = [], status = 'OPEN', finalPriceCents = 0) {
    // The large market is a scale model, not hundreds of pretend blockchain
    // receipts. Keep only cohort totals and aggregate accounting here.
    const buyerCount = cohorts.reduce((sum, cohort) => sum + integer(cohort.units, 'units'), 0);
    const committedCents = cohorts.reduce((sum, cohort) => sum + integer(cohort.units, 'units') * integer(cohort.priceCents, 'payment amount'), 0);
    const refundCents = status === 'REFUNDED'
      ? committedCents
      : status === 'WON' && finalPriceCents > 0
        ? cohorts.reduce((sum, cohort) => sum + integer(cohort.units, 'units') * Math.max(0, integer(cohort.priceCents, 'payment amount') - finalPriceCents), 0)
        : 0;
    const finalOrderCents = Math.max(0, committedCents - refundCents);
    const feeCents = status === 'WON' ? Math.floor(finalOrderCents / 100) : 0;
    const payoutCents = status === 'WON' ? finalOrderCents - feeCents : 0;
    const label = status === 'REFUNDED' ? 'Buyer money returned' : status === 'WON' ? 'Order completed' : 'Demand committed';
    const activity = [
      { id: `SIM-${marketId}-demand`, label: `${buyerCount} buyers in the example market`, detail: `${dollars(committedCents)} aggregate demand · no individual Tempo receipt`, status: 'EXAMPLE' },
      ...(status === 'WON' ? [
        { id: `SIM-${marketId}-price-lock`, label: 'Price locked and surplus returned', detail: `${dollars(refundCents)} aggregate surplus · final order ${dollars(finalOrderCents)}`, status: 'EXAMPLE' },
        { id: `SIM-${marketId}-payout`, label: 'Seller payout after delivery', detail: `${dollars(payoutCents)} to seller · ${dollars(feeCents)} DealArena fee`, status: 'EXAMPLE' },
      ] : status === 'REFUNDED' ? [
        { id: `SIM-${marketId}-refund`, label: 'Buyer money returned', detail: `${dollars(refundCents)} aggregate refund · $0 seller payout · $0 fee`, status: 'EXAMPLE' },
      ] : []),
    ];
    return {
      payments: [],
      activity,
      summary: {
        buyerCount,
        lockedCents: committedCents,
        refundCents,
        finalOrderCents,
        payoutCents,
        feeCents,
        status,
        label,
        provenance: 'SIMULATED_SCALE',
      },
    };
  }

  function flatSimulatedPaymentLedger(marketId, count, amountCents, status = 'OPEN', finalPriceCents = amountCents) {
    const units = integer(count, 'buyers', true);
    const cohorts = units ? [{ id: `${marketId}:buyers`, units, priceCents: integer(amountCents, 'payment amount') }] : [];
    return simulatedPaymentLedger(marketId, cohorts, status, finalPriceCents);
  }
  function winningPrice(offers, winnerIndex) {
    if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex >= offers.length) return null;
    try { return cents(offers[winnerIndex]); } catch { return null; }
  }
  function resolvePriceTier(tiers, fundedBuyers, fundedUnits = fundedBuyers) {
    if (!Array.isArray(tiers)) return null;
    return tiers
      .filter((tier) => tier && integer(tier.buyers, 'tier buyers') > 0
        && integer(tier.priceCents, 'tier price') > 0
        && integer(tier.capacity, 'tier capacity') >= fundedUnits
        && integer(tier.buyers, 'tier buyers') <= fundedBuyers)
      .sort((left, right) => right.buyers - left.buyers || left.priceCents - right.priceCents)[0] || null;
  }
  function compileScenarios(source) {
    const result = {};
    for (const [name, steps] of Object.entries(source)) {
      if (['business', 'request'].includes(name)) {
        result[name] = steps.map((step, i) => {
          const count = Number(step.count ?? step.buyers ?? 0);
          const amountCents = name === 'business' ? 204800 : 100000;
          const paymentLedger = flatSimulatedPaymentLedger(`${name}-${i}`, count, amountCents, i === steps.length - 1 ? 'WON' : 'OPEN', amountCents);
          return { ...step, isSimulated: true, status: i === steps.length - 1 ? 'WON' : 'COMPETING', paymentLedger };
        });
        continue;
      }
      let cohorts = [], previousBuyers = 0;
      result[name] = steps.map((raw, i) => {
        let step = { ...raw, isSimulated: true };
        const increment = integer(step.buyers, 'buyers', true) - previousBuyers;
        if (increment < 0) throw new Error('Scenario buyer count decreased');
        if (increment) cohorts = addCohort(cohorts, `${name}:${i}`, increment, cents(step.commitmentPrice || step.best));
        previousBuyers = step.buyers;
        const candidate = winningPrice(step.offers, step.winnerIndex) || 0;
        const funding = totals(cohorts, candidate);
        if (step.status === 'WON' && !funding.funded) {
          step = { ...step, status: 'REFUNDED', best: '—', offers: ['—', '—', '—'], winnerIndex: -1, winnerSeller: null, offerStatus: 'CLOSED', saving: 'Buyer funds returned', finalizeAction: 'refundDeal', fundingShortfallCents: funding.shortfallCents, reason: `Backup funding shortfall: ${dollars(funding.shortfallCents)}. No automatic top-up.` };
        }
        const accounting = totals(cohorts, winningPrice(step.offers, step.winnerIndex) || 0, step.status);
        const outcome = step.status === 'REFUNDED'
          ? `${step.reason || 'Target not met'} · Returned ${dollars(accounting.refundedCents)}`
          : step.winnerSeller && step.best !== '—'
            ? `${step.winnerSeller} at ${step.best} · Final order ${dollars(accounting.grossCents)} · Returned ${dollars(accounting.refundedCents)}`
            : 'No valid final seller offer · order remains open';
        const paymentLedger = simulatedPaymentLedger(`${name}-${i}`, cohorts, step.status, winningPrice(step.offers, step.winnerIndex) || 0);
        return { ...step, cohorts: cohorts.map((c) => ({ ...c })), accounting, paymentLedger, log: `Simulated market · ${step.buyers} buyers · ${dollars(accounting.committedCents)} aggregate demand · ${outcome}` };
      });
    }
    return result;
  }
  return { integer, cents, dollars, terminal, addCohort, totals, simulatedPaymentLedger, flatSimulatedPaymentLedger, winningPrice, resolvePriceTier, compileScenarios };
});
