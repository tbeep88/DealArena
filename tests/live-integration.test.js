'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const index = value.indexOf('=');
    if (index < 0) continue;
    const key = value.slice(0, index).trim();
    const content = value.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = content;
  }
}

loadDotEnv();

const enabled = process.env.TEMPO_RUN_LIVE_INTEGRATION === 'true';

test('Tempo LIVE integration: five-step ladder proof, settlement, and refund', { skip: !enabled }, async (t) => {
  const { server, provider } = require('../server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    provider.destroy();
  });

  const origin = 'http://127.0.0.1:' + server.address().port;
  const get = (path) => fetch(origin + path).then(async (response) => ({ response, body: await response.json() }));
  const post = (path, payload) => fetch(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }).then(async (response) => ({ response, body: await response.json() }));

  const readiness = await get('/api/tempo/status');
  assert.equal(readiness.body.liveReady, true, JSON.stringify(readiness.body.readiness));

  let state = (await get('/api/state')).body;
  if (state.state.liveDemo && !['COMPLETED', 'REFUNDED'].includes(state.state.liveDemo.status)) {
    throw new Error('Integration test needs a closed or clean LIVE demo before it starts');
  }
  const reset = await post('/api/scenario/reset', { generation: state.state.generation });
  assert.equal(reset.body.success, true);
  state = reset.body;

  const runActionId = 'integration:live:' + Date.now();
  const run = await post('/api/demo/mini-deal', { actionId: runActionId, simulationDealId: state.activeIds.dealId });
  assert.equal(run.body.success, true, JSON.stringify(run.body));
  assert.equal(run.body.receipts.length, 5);
  assert.deepEqual(run.body.demo.stepStates.map((step) => step.status), ['BUYER_1_DONE', 'LADDER_DONE', 'SELLER_B_DONE', 'BUYER_2_DONE', 'BUYER_3_DONE']);

  const action = await get('/api/actions/' + encodeURIComponent(runActionId));
  assert.equal(action.body.success, true);
  assert.equal(action.body.receipts.length, 5);
  assert.equal(action.body.liveDemo.status, 'READY_TO_SETTLE');

  const settleActionId = 'integration:settle:' + Date.now();
  const settlement = await post('/api/wallet/execute', {
    actionId: settleActionId,
    action: 'settleDeal',
    payload: { dealId: run.body.liveDealId, expectedSeller: run.body.demo.winningSeller },
  });
  assert.equal(settlement.body.success, true, JSON.stringify(settlement.body));
  assert.ok(settlement.body.receipt?.events?.some((event) => event.name === 'DealPriceLocked'));
  assert.equal(settlement.body.receipt?.settlementSummary?.finalPriceCents, 66000);
  assert.equal(settlement.body.receipt?.settlementSummary?.unitPriceCents, 66000);
  assert.equal(settlement.body.receipt?.settlementSummary?.grossOrderCents, 198000);
  assert.equal(settlement.body.receipt?.settlementSummary?.feeCents, 1980);
  assert.equal(settlement.body.receipt?.transactionType, '0x76');

  const fulfillment = await post('/api/wallet/execute', {
    actionId: 'integration:fulfillment:' + Date.now(),
    action: 'confirmDealFulfillment',
    payload: { dealId: run.body.liveDealId },
  });
  assert.equal(fulfillment.body.success, true, JSON.stringify(fulfillment.body));
  assert.ok(fulfillment.body.receipt?.events?.some((event) => event.name === 'PaymentReference'));
  const completed = await get('/api/state');
  assert.equal(completed.body.state.liveDemo.status, 'COMPLETED');
  assert.equal(completed.body.state.liveDemo.settlementHash, settlement.body.hash);
  assert.equal(completed.body.state.liveDemo.fulfillmentHash, fulfillment.body.hash);

  // Repeat the entire buyer → seller → price-lock → surplus → payout flow
  // with fresh funded actors, proving that completion did not consume a
  // one-time demo slot or leave buyer accounting in the contract.
  state = (await post('/api/scenario/reset', { generation: state.state.generation })).body;
  const repeatRunId = 'integration:live-repeat:' + Date.now();
  const repeatRun = await post('/api/demo/mini-deal', { actionId: repeatRunId, simulationDealId: state.activeIds.dealId });
  assert.equal(repeatRun.body.success, true, JSON.stringify(repeatRun.body));
  assert.equal(repeatRun.body.receipts.length, 5);
  assert.deepEqual(repeatRun.body.demo.stepStates.map((step) => step.status), ['BUYER_1_DONE', 'LADDER_DONE', 'SELLER_B_DONE', 'BUYER_2_DONE', 'BUYER_3_DONE']);
  const repeatSettle = await post('/api/wallet/execute', {
    actionId: 'integration:settle-repeat:' + Date.now(), action: 'settleDeal',
    payload: { dealId: repeatRun.body.liveDealId, expectedSeller: repeatRun.body.demo.winningSeller },
  });
  assert.equal(repeatSettle.body.success, true, JSON.stringify(repeatSettle.body));
  assert.equal(repeatSettle.body.receipt?.settlementSummary?.grossOrderCents, 198000);
  assert.equal(repeatSettle.body.receipt?.settlementSummary?.feeCents, 1980);
  const repeatFulfillment = await post('/api/wallet/execute', {
    actionId: 'integration:fulfillment-repeat:' + Date.now(), action: 'confirmDealFulfillment',
    payload: { dealId: repeatRun.body.liveDealId },
  });
  assert.equal(repeatFulfillment.body.success, true, JSON.stringify(repeatFulfillment.body));
  state = (await get('/api/state')).body;
  assert.equal(state.state.liveDemo.status, 'COMPLETED');
  assert.equal(state.state.liveDemo.settlementHash, repeatSettle.body.hash);
  assert.equal(state.state.liveDemo.fulfillmentHash, repeatFulfillment.body.hash);
  assert.equal(state.state.liveDemo.settlementSummary?.sellerPayoutCents, 196020);
  assert.equal(state.state.liveDemo.settlementSummary?.feeCents, 1980);
  assert.ok(repeatFulfillment.body.receipt?.events?.some((event) => event.name === 'FulfillmentPaymentReleased'));

  state = (await post('/api/scenario/reset', { generation: completed.body.state.generation })).body;
  // A valid funded seller cannot be cancelled by racing a refund. Exercise
  // the actual refund branch: a funded buyer, no valid seller, deadline passed.
  const config = require('../contracts/deployed.json');
  const artifact = require('../contracts/DealArenaEscrow-v17.json');
  const owner = new ethers.Wallet(process.env.TEMPO_PRIVATE_KEY, provider);
  const buyerKey = process.env.TEMPO_DEMO_BUYER_PRIVATE_KEY;
  const buyer = buyerKey ? new ethers.Wallet(buyerKey, provider) : ethers.HDNodeWallet.fromPhrase(process.env.TEMPO_DEMO_MNEMONIC, undefined, "m/44'/60'/0'/0/0").connect(provider);
  const escrow = new ethers.Contract(config.contractAddress, artifact.abi, owner);
  const refundId = 'integration-empty-' + Date.now();
  const deadline = Math.floor(Date.now() / 1000) + 15;
  await (await escrow.setMarketDeadline(refundId, deadline)).wait();
  await (await escrow.connect(buyer).joinDeal(refundId, 680_000_000n)).wait();
  while (Math.floor(Date.now() / 1000) <= deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  const refund = await post('/api/wallet/execute', {
    actionId: 'integration:refund:' + Date.now(),
    action: 'refundDeal',
    payload: { dealId: refundId, reason: 'No funded seller at deadline' },
  });
  assert.equal(refund.body.success, true, JSON.stringify(refund.body));
  assert.ok(refund.body.receipt?.events?.some((event) => event.name === 'DealRefunded'));

  state = (await post('/api/scenario/reset', { generation: (await get('/api/state')).body.state.generation })).body;
  const failedRun = await post('/api/demo/mini-deal', { actionId: 'integration:failed-run:' + Date.now(), simulationDealId: state.activeIds.dealId });
  assert.equal(failedRun.body.success, true, JSON.stringify(failedRun.body));
  const failedSettlement = await post('/api/wallet/execute', {
    actionId: 'integration:failed-settle:' + Date.now(),
    action: 'settleDeal',
    payload: { dealId: failedRun.body.liveDealId, expectedSeller: failedRun.body.demo.winningSeller },
  });
  assert.equal(failedSettlement.body.success, true, JSON.stringify(failedSettlement.body));
  const failedFulfillment = await post('/api/wallet/execute', {
    actionId: 'integration:failed-fulfillment:' + Date.now(),
    action: 'slashSettledDealGuarantee',
    payload: { dealId: failedRun.body.liveDealId, reason: 'Delivery failed' },
  });
  assert.equal(failedFulfillment.body.success, true, JSON.stringify(failedFulfillment.body));
  assert.equal(failedFulfillment.body.receipt?.settlementSummary?.sellerPayoutCents, 0);
  assert.equal(failedFulfillment.body.receipt?.settlementSummary?.feeCents, 0);
  assert.equal(failedFulfillment.body.receipt?.settlementSummary?.buyerRefundCents, 204000);
});
