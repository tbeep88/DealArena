'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Market = require('../market-model');
const server = require('../server');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const deployed = require('../contracts/deployed.json');
const compiled = require('../contracts/compiled-v17.json');
const sourceMatchesDeployment = compiled.sourceHash === deployed.sourceHash;

function compileEscrow(source) {
  let lastError;
  for (const runs of [0, 0, 0]) {
    const script = `
      const fs = require('node:fs');
      const solc = require('solc');
      const source = fs.readFileSync(0, 'utf8');
      const input = {
        language: 'Solidity',
        sources: { 'DealArenaEscrow.sol': { content: source } },
        settings: { optimizer: { enabled: ${runs > 0 ? 'true' : 'false'}, runs: ${runs} }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } },
      };
      process.stdout.write(solc.compile(JSON.stringify(input)));
    `;
    try {
      const output = JSON.parse(execFileSync(process.execPath, ['-e', script], {
        input: source,
        encoding: 'utf8',
        maxBuffer: 40 * 1024 * 1024,
      }));
      const artifact = output.contracts?.['DealArenaEscrow.sol']?.DealArenaEscrow;
      if (artifact && !(output.errors || []).some((entry) => entry.severity === 'error')) return output;
      lastError = new Error((output.errors || []).map((entry) => entry.formattedMessage).join('\n') || 'Solidity compiler returned no DealArenaEscrow artifact');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

test('normal deal retains each original cohort and balances settlement', () => {
  const steps = server.SCENARIOS.normal;
  assert.deepEqual(steps.map((step) => step.cohorts.map((row) => [row.units, row.priceCents])), [
    [[50, 68000]], [[50, 68000], [150, 68000]], [[50, 68000], [150, 68000], [300, 68000]],
  ]);
  const ledger = steps.at(-1).accounting;
  assert.equal(ledger.committedCents, 34000000);
  assert.equal(ledger.grossCents, 29500000);
  assert.equal(ledger.feeCents, 295000);
  assert.equal(ledger.payoutCents, 29205000);
  assert.equal(ledger.refundedCents, 4500000);
  assert.equal(ledger.escrowCents, 0);
  assert.equal(ledger.refunds.map((item) => item.refundCents).join(','), '450000,1350000,2700000');
  assert.match(server.SCENARIOS.normal.at(-1).log, /\$340,000 aggregate demand · Seller C .* Final order \$295,000 · Returned \$45,000/);
  assert.equal(server.SCENARIOS.normal.at(-1).sellerLadder.tiers[1].price, '$590');
  assert.equal(Market.resolvePriceTier(server.SCENARIOS.normal.at(-1).sellerLadder.tiers, 500, 500).price, '$590');
  assert.match(server.SCENARIOS.war.at(-1).log, /\$316,000 aggregate demand · Seller C .* Final order \$280,000 · Returned \$36,000/);
});

test('simulated market keeps aggregate accounting without fake buyer receipts', () => {
  const open = server.SCENARIOS.normal[1].paymentLedger;
  const complete = server.SCENARIOS.normal.at(-1).paymentLedger;
  assert.equal(open.summary.buyerCount, 200);
  assert.equal(open.summary.lockedCents, 13600000);
  assert.deepEqual(open.payments, []);
  assert.equal(complete.summary.buyerCount, 500);
  assert.equal(complete.summary.refundCents, 4500000);
  assert.equal(complete.summary.finalOrderCents, 29500000);
  assert.equal(complete.summary.payoutCents, 29205000);
  assert.equal(complete.summary.feeCents, 295000);
  assert.deepEqual(complete.payments, []);
  assert.equal(complete.summary.provenance, 'SIMULATED_SCALE');
  assert.ok(complete.activity.some((entry) => /surplus returned/i.test(entry.label)));
});

test('large live settlements split recipients into contract-sized atomic chunks', () => {
  const recipients = Array.from({ length: 500 }, (_, index) => `buyer-${index}`);
  assert.deepEqual(server.chunkRecipients(recipients).map((chunk) => chunk.length), [200, 200, 100]);
  assert.equal(server.requireNativeBatchSize(500, 'deal', 1), 3);
  assert.throws(() => server.requireNativeBatchSize(1801, 'deal', 1), /Tempo batch limit/);
});

test('a failed seller after price lock returns all buyer commitments without payout', () => {
  const locked = server.SCENARIOS.failed[1];
  assert.equal(locked.status, 'AWAITING_FULFILLMENT');
  assert.equal(locked.winnerIndex, 2);
  assert.equal(locked.best, '$590');
  assert.equal(locked.winnerSeller, 'Seller C (Vertex Global)');
  assert.equal(locked.failureType, undefined);
  const final = server.SCENARIOS.failed.at(-1);
  assert.equal(final.status, 'REFUNDED');
  assert.equal(final.best, '—');
  assert.equal(final.winnerIndex, -1);
  assert.equal(final.accounting.committedCents, 29500000);
  assert.equal(final.accounting.refundedCents, 29500000);
  assert.equal(final.failureType, 'DELIVERY_FAILED');
  assert.equal(final.accounting.payoutCents, 0);
  assert.equal(final.accounting.feeCents, 0);
  assert.equal(final.offers[2], 'FAILED');
  assert.match(final.reason, /payout and 1% fee are \$0/);
});

test('each seller appears once and seller C wins the $560 price war', () => {
  const final = server.SCENARIOS.war.at(-1);
  assert.equal(Market.winningPrice(final.offers, final.winnerIndex), 56000);
  assert.equal(final.winnerIndex, 2);
  assert.equal(final.accounting.grossCents, 28000000);
  assert.equal(final.accounting.feeCents, 280000);
  assert.equal(final.accounting.payoutCents, 27720000);
  assert.equal(final.accounting.refundedCents, 3600000);
  assert.equal(final.accounting.escrowCents, 0);
});

test('refund closes the market, preserves its historical commitment total, and returns funds', () => {
  const final = server.SCENARIOS.refund.at(-1);
  assert.equal(Market.terminal(final.status), true);
  assert.deepEqual(final.offers, ['—', '—', '—']);
  assert.equal(final.winnerIndex, -1);
  assert.equal(final.buyers, 120);
  assert.equal(final.accounting.committedCents, 9360000);
  assert.equal(final.accounting.refundedCents, 9360000);
  assert.equal(final.accounting.escrowCents, 0);
});

test('money parsing uses cents and rejects fractions smaller than a cent', () => {
  assert.equal(Market.cents('$2,048.25'), 204825);
  assert.throws(() => Market.cents('$2.005'), /Invalid/);
  assert.throws(() => Market.totals([{ id: 'x', units: 1, priceCents: 1000 }], 1100, 'WON'), /Insufficient/);
});

test('PathUSD cents convert to six-decimal token units and back to readable dollars', () => {
  assert.equal(server.centsToPathUsdUnits(68000), 680000000n);
  assert.equal(server.centsToPathUsdUnits(1000), 10000000n);
  assert.equal(server.pathUsdUnitsToUsd(680000000n), '680.00');
  assert.equal(server.pathUsdUnitsToUsd(12345678n), '12.35');
});

test('preset seller wallets are stable actors and deal offers carry the buyer threshold', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /Wallet\.createRandom\(\)/);
  const state = server.getState();
  assert.ok(state.sellers.A.address && state.sellers.B.address && state.sellers.C.address);
  assert.equal(new Set([state.sellers.A.address, state.sellers.B.address, state.sellers.C.address]).size, 3);

  if (!sourceMatchesDeployment) {
    assert.throws(() => server.prepareAction('submitOffer', {
      targetId: 'deal-threshold-1', marketType: 'deal', priceCents: 67000, guaranteeBond: 1000, minimumBuyerCount: 50,
    }, 17), /compiled-v17\.sourceHash/);
    return;
  }

  const prepared = server.prepareAction('submitOffer', {
    targetId: 'deal-threshold-1', marketType: 'deal', priceCents: 67000, guaranteeBond: 1000, minimumBuyerCount: 50,
  }, 17);
  const decoded = new (require('ethers').Interface)([
    'function submitOfferWithCapacity(string,string,uint256,uint256,uint256,uint256,uint256)',
  ]).decodeFunctionData('submitOfferWithCapacity', prepared.transaction.data);
  assert.equal(decoded[0], 'deal-threshold-1');
  assert.equal(decoded[2], 670000000n);
  assert.equal(decoded[4], 50n);
  assert.equal(decoded[5], 20n);
  assert.ok(Number(decoded[6]) > Math.floor(Date.now() / 1000));
});

test('seller price ladder stays gated until the current hardened escrow and encodes all published tiers', () => {
  if (!sourceMatchesDeployment) {
    assert.throws(() => server.prepareAction('submitPriceLadder', {
      targetId: 'deal-ladder-1', marketType: 'deal', pricesCents: [68000, 59000, 55000],
      minimumBuyerCounts: [200, 500, 800], maxBuyerUnits: 800, guaranteeBond: 1000,
    }, 17), /compiled-v17\.sourceHash/);
    return;
  }
  assert.throws(() => server.prepareAction('submitPriceLadder', {
    targetId: 'deal-ladder-1', marketType: 'deal', pricesCents: [68000, 59000, 55000],
    minimumBuyerCounts: [200, 500, 800], maxBuyerUnits: 800, guaranteeBond: 1000,
  }, 16), /hardened escrow v17/);
  const prepared = server.prepareAction('submitPriceLadder', {
    targetId: 'deal-ladder-1', marketType: 'deal', pricesCents: [68000, 59000, 55000],
    minimumBuyerCounts: [200, 500, 800], maxBuyerUnits: 800, guaranteeBond: 1000,
  }, 17);
  const decoded = new (require('ethers').Interface)([
    'function submitPriceLadder(string,uint256[],uint256[],uint256,uint256,uint256)',
  ]).decodeFunctionData('submitPriceLadder', prepared.transaction.data);
  assert.equal(decoded[0], 'deal-ladder-1');
  assert.deepEqual(decoded[1].map(Number), [680000000, 590000000, 550000000]);
  assert.deepEqual(decoded[2].map(Number), [200, 500, 800]);
  assert.equal(decoded[3], 800n);
  assert.equal(decoded[5], 10000000n);
});

test('on-chain activity formats token units as dollars, not raw micro-units', () => {
  const { Interface } = require('ethers');
  const iface = new Interface(['event DealJoined(string indexed dealId,address indexed buyer,uint256 depositAmount,uint256 totalBuyerDeposit,uint256 buyersCount,uint256 timestamp)']);
  const fragment = iface.getEvent('DealJoined');
  const encoded = iface.encodeEventLog(fragment, ['deal-1', '0x0000000000000000000000000000000000000001', 680000000n, 680000000n, 1n, 1n]);
  const parsed = iface.parseLog(encoded);
  assert.match(server.formatEventLog(parsed), /locked \$680\.00 PathUSD/);
});

test('request creation prepares a real Tempo authorization', () => {
  if (!sourceMatchesDeployment) {
    assert.throws(() => server.prepareAction('createRequest', { requestId: 'custom-request-88', title: 'Laptop', targetPriceCents: 70000, authAmount: 70000 }, 17), /compiled-v17\.sourceHash/);
    return;
  }
  const id = 'custom-request-88';
  const prepared = server.prepareAction('createRequest', { requestId: id, title: 'Laptop', targetPriceCents: 70000, authAmount: 70000 }, 17);
  assert.equal(prepared.method, 'createRequest');
  assert.equal(prepared.targetId, id);
  assert.equal(prepared.approvalAmount, '700000000');
});

test('request seller offers prepare a real Tempo guarantee', () => {
  if (!sourceMatchesDeployment) {
    assert.throws(() => server.prepareAction('submitOffer', { targetId: 'custom-request-88', marketType: 'request', priceCents: 52000, guaranteeBond: 100000 }, 17), /compiled-v17\.sourceHash/);
    return;
  }
  const id = 'custom-request-88';
  const prepared = server.prepareAction('submitOffer', { targetId: id, marketType: 'request', priceCents: 52000, guaranteeBond: 100000 }, 17);
  assert.equal(prepared.method, 'submitRequestOfferWithCapacity');
  assert.equal(prepared.targetId, id);
  assert.equal(prepared.approvalAmount, '1000000000');
});

test('business pool funding prepares a real Tempo payment', () => {
  if (!sourceMatchesDeployment) {
    assert.throws(() => server.prepareAction('joinBusinessPool', { poolId: 'pool-coffee-west', commitmentCents: 157325 }, 17), /compiled-v17\.sourceHash/);
    return;
  }
  const prepared = server.prepareAction('joinBusinessPool', { poolId: 'pool-coffee-west', commitmentCents: 157325 }, 17);
  assert.equal(prepared.method, 'joinBusinessPool');
  assert.equal(prepared.targetId, 'pool-coffee-west');
  assert.equal(prepared.approvalAmount, '1573250000');
});

test('buyer join preserves explicit deal ID and price, and keeps units under one wallet', () => {
  if (!sourceMatchesDeployment) {
    assert.throws(() => server.prepareAction('joinDeal', { dealId: 'fresh-deal-560', unitPriceCents: 56000, quantity: 1 }, 17), /compiled-v17\.sourceHash/);
    return;
  }
  const prepared = server.prepareAction('joinDeal', { dealId: 'fresh-deal-560', unitPriceCents: 56000, quantity: 1 }, 17);
  assert.equal(prepared.method, 'joinDeal');
  assert.equal(prepared.targetId, 'fresh-deal-560');
  assert.equal(prepared.approvalAmount, '560000000');
  const decoded = new (require('ethers').Interface)(['function joinDeal(string,uint256)'])
    .decodeFunctionData('joinDeal', prepared.transaction.data);
  assert.equal(decoded[0], 'fresh-deal-560');
  assert.equal(decoded[1], 560000000n);
  const units = server.prepareAction('joinDeal', { dealId: 'x', unitPriceCents: 56000, quantity: 3 }, 17);
  assert.equal(units.method, 'joinDealUnits');
  const unitsDecoded = new (require('ethers').Interface)(['function joinDealUnits(string,uint256,uint256)'])
    .decodeFunctionData('joinDealUnits', units.transaction.data);
  assert.deepEqual([...unitsDecoded], ['x', 560000000n, 3n]);
  assert.throws(() => server.prepareAction('joinDeal', { dealId: 'x', unitPriceCents: 56000, quantity: 3 }, 3), /escrow v17/);
  assert.throws(() => server.prepareAction('joinDeal', { dealId: 'x', unitPriceCents: 56000, quantity: 21 }, 17), /Maximum 20/);
  assert.throws(() => server.prepareAction('joinDeal', { dealId: 'x', unitPriceCents: 56000, quantity: 500 }, 17), /Maximum 20/);
  assert.equal(server.prepareAction('joinDeal', { dealId: 'x', unitPriceCents: 56000 }, 17).approvalAmount, '560000000');
});

test('scenario IDs and sequence reject old responses after reset and reject duplicate settlement states', () => {
  const before = server.getState().generation;
  const runId = 'run-00000001';
  const first = server.scenarioStep({ scenario: 'normal', stepIndex: 0, generation: before, runId });
  assert.equal(first.deal.buyers, 50);
  const repeated = server.scenarioStep({ scenario: 'normal', stepIndex: 0, generation: before, runId });
  assert.deepEqual(repeated, first);
  assert.throws(() => server.scenarioStep({ scenario: 'normal', stepIndex: 2, generation: before, runId }), /in order/);
  const reset = server.resetState();
  assert.notEqual(reset.generation, before);
  assert.throws(() => server.scenarioStep({ scenario: 'normal', stepIndex: 1, generation: before, runId }), /Stale generation/);
  assert.throws(() => server.requireOpen({ isSettled: true, isRefunded: false }), /already closed/);
  server.resetState();
});

test('an open live deal blocks simulation reset until it is recovered or closed', () => {
  const state = server.getState();
  state.liveDemo = { status: 'PARTIAL_FAILED', liveDealId: 'LIVE-recovery-1', buyersCount: 1 };
  state.liveProofUsed = true;
  assert.throws(() => server.resetState(), /LIVE deal is still open/);
  state.liveDemo = null;
  state.liveProofUsed = false;
  server.resetState();
});

test('settlement stays open until fulfillment resolves the seller guarantee', () => {
  const awaiting = {
    status: 'AWAITING_FULFILLMENT',
    liveDealId: 'LIVE-awaiting-1',
    buyersCount: 1,
    settlementSummary: { committedCents: 68000, finalPriceCents: 67000 },
    fulfillmentConfirmed: false,
    guaranteeResolved: false,
  };
  assert.equal(server.isLiveDealTerminal(awaiting), false);
  assert.equal(server.liveDealNeedsRecovery(awaiting), true);
  assert.equal(server.isLiveProofDisplayable(awaiting), true);
  assert.equal(server.isLiveDealTerminal({ ...awaiting, status: 'SETTLED' }), false);
  assert.equal(server.isLiveDealTerminal({ ...awaiting, status: 'COMPLETED', fulfillmentConfirmed: true, guaranteeResolved: true }), true);
  assert.equal(server.isLiveDealTerminal({ ...awaiting, status: 'REFUNDED' }), true);
});

test('market caps and lifecycle ordering prevent ambiguous close and payout paths', () => {
  const contract = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'DealArenaEscrow.sol'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(contract, /MAX_MARKET_BUYERS = 800/);
  const refreshBestOffer = contract.match(/function _refreshBestOffer[\s\S]*?\n    \/\/ 1\. CONSUMER GROUP DEALS/)?.[0] || '';
  assert.doesNotMatch(refreshBestOffer, /_fundedBuyerCount\(/);
  assert.match(contract, /function _updateOfferFunding\(/);
  assert.match(contract, /_updateOfferFunding\(dealId, units, 0, totalDeposit\)/);
  assert.match(contract, /mapping\(string => SupplierOffer\) public businessBackupOffers/);
  assert.match(contract, /mapping\(string => SupplierOffer\) public requestBackupOffers/);
  assert.match(contract, /function _promoteBusinessBackup\(/);
  assert.match(contract, /function _promoteRequestBackup\(/);
  assert.match(contract.match(/function _finalizeBusinessPoolAfterDeadline[\s\S]*?\n    function _settleBusinessPool/)?.[0] || '', /_promoteBusinessBackup/);
  assert.match(contract.match(/function _finalizeRequestAfterDeadline[\s\S]*?\n    function _settleRequest/)?.[0] || '', /_requestBuyerFundingComplete/);
  assert.match(contract, /function _requestBuyerFundingComplete\(/);
  assert.match(contract, /BackupSupplierPromoted/);
  const businessSettlement = serverSource.match(/async function performBusinessPoolSettlement[\s\S]*?\n}\n/)?.[0] || '';
  const requestSettlement = serverSource.match(/async function performRequestSettlement[\s\S]*?\n}\n/)?.[0] || '';
  const businessFulfillment = serverSource.match(/async function performBusinessFulfillment[\s\S]*?\n}\n/)?.[0] || '';
  const requestFulfillment = serverSource.match(/async function performRequestFulfillment[\s\S]*?\n}\n/)?.[0] || '';
  assert.match(businessSettlement, /nativeContractCall\('settleBusinessPool'/);
  assert.doesNotMatch(businessSettlement, /confirmSupplierFulfillment/);
  assert.match(requestSettlement, /nativeContractCall\('settleRequest'/);
  assert.doesNotMatch(requestSettlement, /confirmSupplierFulfillment/);
  assert.match(businessFulfillment, /confirmSupplierFulfillment/);
  assert.match(requestFulfillment, /confirmSupplierFulfillment/);
  assert.match(contract, /MAX_OFFER_SELLERS = 8/);
  assert.match(contract, /actual capacity being fully funded/);
  assert.doesNotMatch(contract, /fundedCount >= deal\.settlementTargetBuyerCount/);
  assert.doesNotMatch(serverSource.match(/async function performBusinessPoolFinalization[\s\S]*?\n}\n/)?.[0] || '', /confirmSupplierFulfillment/);
  assert.doesNotMatch(serverSource.match(/async function performRequestFinalization[\s\S]*?\n}\n/)?.[0] || '', /confirmSupplierFulfillment/);
  assert.match(serverSource.match(/async function performBusinessPoolFinalization[\s\S]*?\n}\n/)?.[0] || '', /businessBackupOffers/);
  assert.match(serverSource.match(/async function performRequestFinalization[\s\S]*?\n}\n/)?.[0] || '', /requestBackupOffers/);
  assert.match(contract, /businessSupplierOfferExpiry\[poolId\] >= effectiveNow/);
  assert.match(contract, /requestSupplierOfferExpiry\[requestId\] >= effectiveNow/);
  assert.match(contract, /slashBusinessSupplierAfterFulfillmentDeadline/);
  assert.match(contract, /slashRequestSupplierAfterFulfillmentDeadline/);
  assert.match(serverSource, /disburseBusinessSavings.*slashSettledSupplierGuarantee/s);
  assert.match(serverSource, /disburseRequestSurplusBatch.*slashSettledSupplierGuarantee/s);
});

test('updated escrow compiles with per-buyer funding and explicit request ceiling checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'DealArenaEscrow.sol'), 'utf8');
  const output = compileEscrow(source);
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  assert.deepEqual(errors.map((entry) => entry.formattedMessage), []);
  const abi = output.contracts['DealArenaEscrow.sol'].DealArenaEscrow.abi;
  const names = abi.map((entry) => entry.name);
  assert.ok(names.includes('getRequestBuyers'));
  assert.match(source, /underfunded-refund/);
  assert.match(source, /INSUFFICIENT_ESCROW/);
  assert.match(source, /REQUEST_EXISTS/);
  assert.match(source, /EXACT_TOP_UP_REQUIRED/);
  assert.match(source, /BUYER_ALREADY_JOINED/);
  assert.match(source, /BATCH_TOO_LARGE/);
  assert.match(source, /CONTRACT_VERSION = 17/);
  assert.match(source, /settlementTargetBuyerCount/);
  assert.match(source, /USE_DEADLINE_SETTLEMENT/);
  assert.doesNotMatch(source, /SETTLEMENT_TARGET_NOT_REACHED/);
  assert.match(source, /seller bond is separate from buyer escrow/);
  assert.match(source, /FINAL_BIDDING_WINDOW/);
  assert.match(source, /DEFAULT_FULFILLMENT_WINDOW/);
  assert.match(source, /refundDealAfterFulfillmentDeadline/);
  assert.match(source, /FULFILLMENT_DEADLINE_PASSED/);
  assert.match(source, /FinalBiddingWindowOpened/);
  assert.ok(names.includes('getDealTimingState'));
  assert.ok(names.includes('dealStatus'));
  assert.match(source, /settleDealAfterDeadline/);
  assert.match(source, /finalizeDealAfterDeadline/);
  assert.match(source, /_finalizeDealAfterDeadline/);
  assert.match(source, /return _finalizeDealAfterDeadline\(dealId, reason\)/);
  assert.match(source, /return _finalizeBusinessPoolAfterDeadline\(poolId, reason\)/);
  assert.match(source, /return _finalizeRequestAfterDeadline\(requestId, reason\)/);
  assert.match(source, /MIN_BUYER_COMMITMENT/);
  assert.match(source, /MIN_SELLER_BOND/);
  assert.match(source, /businessDeadlines/);
  assert.match(source, /requestDeadlines/);
  assert.match(source, /businessSupplierMaxBuyers/);
  assert.match(source, /requestSupplierOfferExpiry/);
  assert.match(source, /businessRefundTotals/);
  assert.match(source, /requestRefundTotals/);
  assert.match(source, /businessRefundRemaining/);
  assert.match(source, /requestRefundRemaining/);
  assert.match(source, /topUpDeal/);
  assert.ok(names.includes('confirmDealFulfillment'));
  assert.ok(names.includes('getDealFundingState'));
  assert.ok(names.includes('removeUnfundedDealBuyers'));
  assert.match(source, /sellerRevoked/);
  assert.match(source, /SELLER_REVOKED/);
  assert.match(source, /SUPPLIER_REVOKED/);
  assert.match(source, /refundDealAfterDeadline/);
  assert.match(source, /confirmDealFulfillment/);
  assert.match(source, /if \(refund == 0\) return;/);
  assert.match(source, /MIN_BUYERS_NOT_REACHED/);
  assert.match(source, /ConditionalOffer/);
  assert.match(source, /_refreshBestOffer/);
  assert.match(source, /SELLER_CAPACITY_REACHED/);
  assert.match(source, /OfferExpired/);
  assert.match(source, /settleDealAfterDeadline/);
  assert.match(source, /removeUnfundedDealBuyersAfterDeadline/);
  assert.match(source, /FulfillmentPaymentReleased/);
  assert.match(source, /deal\.sellerPayout/);
  assert.match(source, /_requireBefore\(marketDeadlines\[dealId\]\)/);
  assert.equal(abi.find((entry) => entry.type === 'function' && entry.name === 'submitOfferWithCapacity').inputs.length, 7);
  assert.equal(abi.some((entry) => entry.type === 'function' && entry.name === 'submitOffer'), false);
  assert.ok(names.includes('removeUnfundedRequestBuyersAfterDeadline'));
  assert.ok(names.includes('sweepBusinessSavingsDust'));
  assert.ok(names.includes('sweepRequestSurplusDust'));
  assert.ok(names.includes('slashSettledSupplierGuarantee'));
  assert.match(source, /BUYER_SURPLUS_PENDING/);
  assert.match(source, /SupplierGuaranteeSlashed/);
  assert.match(source, /businessDeposits\[poolId\]\[recipient\] = deposited - refund/);
  assert.match(source, /function slashSettledSupplierGuarantee/);
  assert.match(source, /businessRefundTotals\[marketId\] = refundableEscrow/);
  assert.match(source, /requestRefundTotals\[marketId\] = refundableEscrow/);
  const businessSavings = source.slice(source.indexOf('function disburseBusinessSavings('), source.indexOf('function sweepBusinessSavingsDust('));
  const requestSurplus = source.slice(source.indexOf('function disburseRequestSurplusBatch('), source.indexOf('function sweepRequestSurplusDust('));
  assert.doesNotMatch(businessSavings, /FULFILLMENT_PENDING/);
  assert.doesNotMatch(requestSurplus, /FULFILLMENT_PENDING/);
  assert.match(source, /transferWithMemo/);
  assert.match(source, /PaymentReference/);
  assert.doesNotMatch(source, /function submitOfferFor/);
  assert.doesNotMatch(source, /function submitBusinessOfferFor/);
  assert.doesNotMatch(source, /function submitRequestOfferFor/);
  assert.doesNotMatch(source, /function multicall/);
  assert.doesNotMatch(source, /function _ensureDefaultRequestCeiling/);
  const dealSettlement = source.slice(source.indexOf('function settleDeal('), source.indexOf('function _disburseBuyerSurplus('));
  const requestSettlement = source.slice(source.indexOf('function settleRequest('), source.indexOf('function refundRequest('));
  assert.match(dealSettlement, /require\(!deal\.isSettled && !deal\.isRefunded, "DEAL_CLOSED"\)/);
  assert.match(dealSettlement, /totalUnits \* deal\.bestPrice/);
  assert.match(dealSettlement, /emit DealPriceLocked\(dealId, deal\.bestSeller, deal\.bestPrice/);
  assert.match(dealSettlement, /USE_DEADLINE_SETTLEMENT/);
  assert.match(dealSettlement, /DEADLINE_NOT_REACHED/);
  assert.doesNotMatch(source, /allowAfterDeadline/);
  assert.match(requestSettlement, /require\(!req\.isSettled && !req\.isRefunded, "REQ_CLOSED"\)/);
  assert.match(source, /function disburseRequestSurplusBatch/);
  assert.match(source, /function _removeRequestBuyer/);
  assert.match(source, /FINAL_BIDDING_LOCKED/);
  assert.match(source, /CAPACITY_BELOW_THRESHOLD/);
  assert.match(source, /SELLER_BOND_TOO_SMALL/);
  assert.match(source, /minimumBuyerCounts\[i\] <= maxBuyerUnits/);
  assert.doesNotMatch(source, /fundedUnits \+ units <= deal\.maxBuyerUnits/);
  assert.equal((source.match(/_disburseSingleRequestSurplus\(requestId, req, recipients\[i\]\)/g) || []).length, 1);
  assert.match(source, /function getBusinessBuyers/);
  assert.doesNotMatch(source, /price < 900000000/);
  assert.match(source, /maxOfferPrice = type\(uint256\)\.max/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /multicall\.populateTransaction/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /executeTempoNativeBatch/);
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /settleDealLive/);
  assert.match(html, /liveDealProof/);
  assert.match(html, /settleRequestLive|refundRequestLive|settleBusinessLive|refundBusinessLive/);
  assert.match(appSource, /function fundRequest\(string requestId/);
  assert.match(html, /joinRequestButton/);
  assert.match(html, /Buyer requests/);
  assert.match(html, /500 buyers · SIMULATED MARKET/);
  assert.doesNotMatch(html, /Compatibility markers for the automated product checks/);
  assert.doesNotMatch(html, /Live requests|Pay remaining|live offer is accepted|\$10 authorization/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /assertPublicOwnerScope/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /assertPublicWriteRateLimit/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /persistLiveDemo/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /LIVE deal is still open/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /LIVE_DEMO_PREPARED_RUNS = 5/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /LIVE_DEMO_READINESS_RUNS = 1/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /deployedHasFunction/);
  const serverContractSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverContractSource, /getCode\(CONTRACT_ADDRESS\)/);
  assert.match(serverContractSource, /Failed seller removed; checking backup offer/);
  assert.match(serverContractSource, /performDealTimeoutRefund/);
  assert.match(serverContractSource, /refundDealAfterFulfillmentDeadline/);
  assert.match(serverContractSource, /state\.latestLiveProof = null/);
  const bytecodeCompiler = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'compile-bytecode.js'), 'utf8');
  const deploySource = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'deploy.js'), 'utf8');
  assert.doesNotMatch(bytecodeCompiler, /core-source/);
  assert.doesNotMatch(deploySource, /core-source/);
  assert.match(deploySource, /explore\.testnet\.tempo\.xyz/);
  assert.match(deploySource, /const artifact = build\(\)/);
  const fullBuilder = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'build.js'), 'utf8');
  assert.match(fullBuilder, /runs: 1/);
  assert.match(fullBuilder, /Storage layout mismatch/);
  assert.match(fullBuilder, /exceeds Tempo limits/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /performBusinessSupplierFailure/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /performRequestSupplierFailure/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /\/api\/demo\/mini-deal\/status/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /currentStep/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /stepStates/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /BUYER_1_DONE/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /LADDER_DONE/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /requestStateContext/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /scopedActionId/);
  assert.match(appSource, /Market\.addCohort/);
  assert.match(appSource, /Seller ladder recorded on Tempo/);
  assert.doesNotMatch(appSource, /Sending offer from your wallet/);
  assert.match(appSource, /Latest transaction/);
  assert.match(appSource, /Resume live proof/);
  assert.match(appSource, /Run fresh live proof/);
  assert.match(appSource, /autoSettle: true/);
  assert.match(serverSource, /latestLiveProof/);
  assert.match(serverSource, /body\.autoSettle === true/);
  assert.match(appSource, /formatSettlementSummary/);
  assert.match(appSource, /updateProtocolEconomics/);
  assert.match(appSource, /updateBusinessEconomics/);
  assert.match(html, /id="homeTempoProof"/);
  assert.match(html, /businessEconomicsFee/);
  assert.match(html, /id="receiptCommitted"/);
  assert.match(html, /id="receiptFee"/);
  assert.match(html, /id="receiptPayout"/);
  assert.doesNotMatch(html, /id="protocolEconomicsState"/);
  assert.match(html, /funded buyers/);
  assert.match(html, /DealArena fee/);
  assert.doesNotMatch(appSource, /Potential platform fee/);
  assert.match(html, /settlementReceipt/);
  assert.match(html, /Run LIVE proof|Checking LIVE proof/);
  assert.match(appSource, /Latest confirmed live proof/);
  assert.match(html, /View on Tempo/);
  assert.doesNotMatch(html, /trust-drawer/);
  assert.doesNotMatch(html, /Launch wedge/);
  assert.match(html, /Market now/);
  assert.match(html, /home-seller-battle/);
  assert.match(html, /See the price ladder/);
  assert.match(html, /id="offerPriceInput"[^>]*value="\$670"/);
  assert.match(html, /id="offerGuaranteeInput"[^>]*value="\$55"/);
  assert.match(appSource, /off\.elements\.guarantee\.value = isDeal \? '\$55' : '\$10'/);
  assert.match(html, /modeled order value/);
  assert.doesNotMatch(html, /demo balance/);
  assert.match(html, /Why sellers compete/);
  assert.match(html, /Share deal/);
  assert.doesNotMatch(html, /Opening offer/);
  assert.match(html, /Sellers compete for the order/);
  assert.match(appSource, /shareCurrentDeal/);
  assert.match(appSource, /formatLogMessage/);
  assert.match(appSource, /const phoneBuyers = currentDeal\?\.buyers \?\? 0/);
  assert.doesNotMatch(appSource, /const phoneBuyers = openPhone \?/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'contracts', 'benchmark-batch.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'package-lock.json')));
});

test('HTTP prepare endpoints forward exact IDs and values without submitting transactions', async (t) => {
  const listener = server.server;
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => listener.close(resolve)); server.provider.destroy(); });
  const origin = 'http://127.0.0.1:' + listener.address().port;
  const status = await fetch(origin + '/api/tempo/status').then((res) => res.json());
  assert.equal(status.contractVersion, Number(deployed.contractVersion));
  assert.equal(typeof status.livePaymentsEnabled, 'boolean');
  assert.equal(typeof status.readiness.checks.contractVersion, 'boolean');
  assert.equal(typeof status.readiness.checks.sourceHash, 'boolean');
  assert.equal(typeof status.sourceHashMatch, 'boolean');
  assert.equal(typeof status.readiness.checks.ownerFeeBalance, 'boolean');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /escrowRead\.CONTRACT_VERSION\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /chainPaymentToken/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /compiledArtifactSourceHash/);
  assert.equal(status.pathUsdDecimals, 6);
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(appSource, /id="liveDealProof"|#liveDealProof/);
  assert.doesNotMatch(appSource, /runLiveMiniDeal\(\{ silent: true \}\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /liveDealIdFor\(simulationDealId\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /receipt: proof/);
  const invalidProof = await fetch(origin + '/api/proof', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: 'not-a-hash' }),
  });
  assert.equal(invalidProof.status, 400);
  const response = await fetch(origin + '/api/request/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'req-custom-712', need: 'Laptop', price: '$700', buyers: 1 }),
  });
  const preparedRequest = await response.json();
  if (Number(deployed.contractVersion) === 17 && sourceMatchesDeployment) {
    assert.equal(response.status, 200);
    assert.equal(preparedRequest.status, 'PREPARED');
    assert.equal(preparedRequest.isOnChain, false);
    assert.equal(preparedRequest.method, 'createRequest');
    assert.equal(preparedRequest.targetId, 'req-custom-712');
    assert.equal(preparedRequest.approvalAmount, '700000000');
  } else {
    assert.equal(response.status, 400);
    assert.match(preparedRequest.error, /current contract version 17|hardened escrow v17|recovery-only|compiled-v17 source/);
  }

  const offer = await fetch(origin + '/api/deal/offer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: 'Laptop under $700', targetId: 'req-custom-712', price: '$520', guarantee: '$1,000' }),
  });
  const preparedOffer = await offer.json();
  assert.equal(offer.status, 400);
  assert.match(preparedOffer.error, /current contract version 17|hardened escrow v17|recovery-only|compiled-v17 source|Cannot read properties of null/);

  const settlement = await fetch(origin + '/api/wallet/execute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId: 'blocked-v2-settlement-test', action: 'settleDeal', payload: { dealId: 'never-submit' } }),
  });
  const settlementResult = await settlement.json();
  assert.equal(settlement.status, 400);
  assert.match(settlementResult.error, /Settlement wallet is not configured|No funded winning order exists on-chain|recovery-only|compiled-v17 source|compiled-v17\.sourceHash/);

  const manyActors = await fetch(origin + '/api/request/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'req-custom-713', title: 'Laptop', targetPriceCents: 70000, buyers: 300 }),
  });
  assert.equal(manyActors.status, 400);
  assert.match((await manyActors.json()).error, /Each request buyer must sign independently|current contract version 17|hardened escrow v17|recovery-only|compiled-v17 source/);
});
