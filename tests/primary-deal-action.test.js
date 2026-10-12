'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function fixture() {
  const calls = [];
  let order = 1;
  const nodes = new Map();
  const context = {
    liveLaunchInProgress: false, isScenarioActive: false, livePaymentsEnabled: true,
    livePublicDemoEnabled: true, liveProofUsed: false, liveReceiptAvailable: false,
    liveDemoState: null, latestLiveProof: null, viewEpoch: 0, activeIds: { dealId: 'market-1' },
    window: { location: { hostname: 'jury.example', hash: '' } },
    presenterAccess: { headers: (headers) => headers },
    $: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { disabled: false, textContent: '', scrollIntoView() {} });
      return nodes.get(selector);
    },
    syncServerState: async () => { calls.push('read'); },
    updateLiveAvailability() {}, showView() {}, toast() {}, setTestnetLive() {}, addMiniLog() {},
    resetDemo: async () => {
      calls.push('reset'); context.liveDemoState = null; context.liveProofUsed = false;
      context.activeIds = { dealId: `market-${++order}` }; return true;
    },
    runScenarioFromServer: async () => { calls.push('market'); return true; },
    executeOwnerAction: async (button, status, action, payload) => {
      calls.push({ action, dealId: payload.dealId }); context.liveDemoState.status = 'COMPLETED';
      return { success: true };
    },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const demo = { liveDealId: `live-${order}`, simulationDealId: context.activeIds.dealId,
        status: 'AWAITING_FULFILLMENT', receipts: [] };
      return { ok: true, json: async () => ({ success: true, demo, receipts: [], hash: `hash-${order}` }) };
    },
  };
  vm.createContext(context);
  for (const name of ['runLiveMiniDeal', 'performPrimaryDealAction', 'runSelectedDealAction']) {
    const match = source.match(new RegExp(`^async function ${name}\\([^]*?^\\}`, 'm'));
    assert.ok(match, `actual ${name} source exists`);
    vm.runInContext(match[0], context);
  }
  return { context, calls };
}

test('primary action sends a new order, delivery pays that order, repeat sends a different order', async () => {
  const { context: c, calls } = fixture();
  await c.performPrimaryDealAction({ showMarket: true });
  assert.equal(c.liveDemoState.status, 'AWAITING_FULFILLMENT');
  await c.performPrimaryDealAction();
  assert.equal(c.liveDemoState.status, 'COMPLETED');
  await c.performPrimaryDealAction({ showMarket: true });
  const posts = calls.filter((entry) => entry.url);
  assert.equal(posts.length, 2);
  assert.ok(posts.every((entry) => entry.url === '/api/demo/mini-deal' && entry.body.autoSettle === true));
  assert.notEqual(posts[0].body.simulationDealId, posts[1].body.simulationDealId);
  assert.equal(calls.find((entry) => entry.action)?.action, 'confirmDealFulfillment');
  assert.equal(calls.filter((entry) => entry === 'market').length, 2);
});

test('real order heading follows live state, not the closed 500-buyer example', () => {
  const nodes = new Map();
  const context = { liveDemoState: { status: 'AWAITING_FULFILLMENT' }, liveLaunchInProgress: false,
    liveReadinessKnown: true, livePaymentsEnabled: true,
    currentDeal: { status: 'WON', buyers: 500, best: '$590' },
    $: (key) => { if (!nodes.has(key)) nodes.set(key, { textContent: '' }); return nodes.get(key); } };
  vm.createContext(context);
  const match = source.match(/^function syncRealOrderHeading\([^]*?^\}/m);
  assert.ok(match);
  vm.runInContext(match[0], context);
  context.syncRealOrderHeading();
  assert.equal(nodes.get('#liveOrderState').textContent, 'AWAITING DEMO DELIVERY');
  assert.match(nodes.get('#liveOrderSummary').textContent, /payout and 1% fee/);
  assert.doesNotMatch(nodes.get('#liveOrderHeading').textContent, /complete|500|590/i);
  context.liveDemoState.status = 'COMPLETED';
  context.syncRealOrderHeading();
  assert.equal(nodes.get('#liveOrderState').textContent, 'ORDER COMPLETED');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((html.match(/id="joinDealPage"/g) || []).length, 1);
  assert.match(html, /SEPARATE SCALE EXAMPLE · NOT THE REAL ORDER BELOW/);
  const dealPage = html.slice(html.indexOf('id="deal"'), html.indexOf('<!-- VIEW 3: BUSINESS -->'));
  assert.doesNotMatch(dealPage, /<details\b/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.deal-page \.scale-example-heading \{ order: 2; \}/);
  assert.match(css, /\.deal-page \.deal-workspace \{ order: 3; \}/);
  assert.match(css, /\.deal-page \.settlement-receipt \{ order: 6; \}/);
  assert.match(css, /\.deal-details \.deal-stage \{ order: 0; grid-column: 1 \/ -1;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('progress labels distinguish market playback, sending money, and delivery', () => {
  const nodes = new Map();
  const context = { liveLaunchStep: 'market', liveLaunchInProgress: true, liveDemoState: null,
    liveReadinessKnown: true, livePaymentsEnabled: true,
    $: (key) => { if (!nodes.has(key)) nodes.set(key, { textContent: '' }); return nodes.get(key); } };
  vm.createContext(context);
  for (const name of ['primaryActionProgressLabel', 'syncRealOrderHeading']) {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'));
    assert.ok(match);
    vm.runInContext(match[0], context);
  }
  context.syncRealOrderHeading();
  assert.equal(nodes.get('#liveOrderState').textContent, 'MARKET EXAMPLE RUNNING');
  assert.match(nodes.get('#liveOrderSummary').textContent, /payments start after/);
  context.liveLaunchStep = 'payment';
  context.syncRealOrderHeading();
  assert.equal(nodes.get('#liveOrderState').textContent, 'PAYMENTS IN PROGRESS');
  context.liveLaunchStep = 'delivery';
  context.liveDemoState = { status: 'AWAITING_FULFILLMENT' };
  context.syncRealOrderHeading();
  assert.match(nodes.get('#liveOrderHeading').textContent, /Confirming delivery/);
  assert.match(nodes.get('#liveOrderSummary').textContent, /not complete/);
});

test('rapid double click dispatches only one payment request', async () => {
  const { context: c, calls } = fixture();
  await Promise.all([c.performPrimaryDealAction(), c.performPrimaryDealAction()]);
  assert.equal(calls.filter((entry) => entry.url).length, 1);
  assert.equal(c.liveLaunchInProgress, false);
});

test('failed readiness, reset, or market progression does not send money', async () => {
  for (const failure of ['readiness', 'reset', 'market']) {
    const { context: c, calls } = fixture();
    if (failure === 'readiness') c.livePaymentsEnabled = false;
    if (failure === 'reset') { c.liveDemoState = { status: 'COMPLETED' }; c.resetDemo = async () => false; }
    if (failure === 'market') c.runScenarioFromServer = async () => false;
    await c.performPrimaryDealAction({ showMarket: true });
    assert.equal(calls.filter((entry) => entry.url).length, 0, failure);
    assert.equal(c.liveLaunchInProgress, false);
  }
});

test('initialization never sends a payment; both entry points dispatch the same selected action', () => {
  const { calls } = fixture();
  assert.equal(calls.length, 0);
  const primaryControl = source.slice(source.indexOf("$('#joinDealPage')?.addEventListener"), source.indexOf("$$('.share-deal-button')"));
  assert.match(primaryControl, /runSelectedDealAction/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((html.match(/id="runScenario"/g) || []).length, 1);
  assert.match(source, /\$\('#runScenario'\)\?\.addEventListener\('click', \(\) => \{\s*void runSelectedDealAction\(\);/);
  for (const id of ['liveDealProof', 'settleDealLive', 'confirmDealFulfillmentLive']) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*\\bhidden\\b`));
  }
});

test('toolbar mirrors readiness, delivery, busy state, and modeled scenarios', () => {
  const nodes = new Map();
  const c = { liveReadinessKnown: false, livePaymentsEnabled: true, livePublicDemoEnabled: true,
    liveLaunchInProgress: false, isScenarioActive: false, liveDemoState: null,
    window: { location: { hostname: 'jury.example' } }, syncRealOrderHeading() {},
    primaryActionProgressLabel: () => 'Sending new Tempo payments…',
    $: (key) => {
      if (!nodes.has(key)) nodes.set(key, { value: 'normal', classList: { remove() {} } });
      return nodes.get(key);
    } };
  vm.createContext(c);
  vm.runInContext(source.match(/^function syncDealCommitAction\([^]*?^\}/m)[0], c);
  for (const stage of ['checking', 'ready', 'delivery', 'busy', 'refund']) {
    c.liveReadinessKnown = stage !== 'checking';
    c.liveDemoState = stage === 'delivery' ? { status: 'AWAITING_FULFILLMENT' } : null;
    c.liveLaunchInProgress = stage === 'busy';
    c.$('#scenario').value = stage === 'refund' ? 'refund' : 'normal';
    c.syncDealCommitAction();
    const primary = c.$('#joinDealPage'), toolbar = c.$('#runScenario');
    for (const field of ['disabled', 'hidden', 'textContent', 'title']) assert.equal(toolbar[field], primary[field], `${stage}: ${field}`);
    if (stage === 'delivery') assert.match(toolbar.textContent, /Confirm demo delivery/);
    if (stage === 'refund') assert.match(toolbar.textContent, /no payment/);
    if (['checking', 'busy'].includes(stage)) assert.equal(toolbar.disabled, true);
  }
});

test('the selected action runs normal payments but a refund example sends no payment', async () => {
  const { context: c, calls } = fixture();
  c.$('#scenario').value = 'refund';
  await c.runSelectedDealAction();
  assert.equal(calls.filter((entry) => entry.url).length, 0);
  assert.equal(calls.filter((entry) => entry === 'market').length, 1);
  c.$('#scenario').value = 'normal';
  await c.runSelectedDealAction();
  assert.equal(calls.filter((entry) => entry.url).length, 1);
});

test('evidence links position once at receipts, or at the explicit action when there is no receipt', () => {
  for (const hasReceipt of [true, false]) {
    const frames = [], revealed = [], views = [];
    const c = { window: { location: { hash: '#business' } },
      requestAnimationFrame: (callback) => frames.push(callback),
      showView: (view, options) => views.push({ view, scroll: options.scroll }),
      revealActionResult: (selector) => revealed.push(selector),
      $: () => ({ hidden: !hasReceipt, classList: { contains: () => hasReceipt } }) };
    vm.createContext(c);
    vm.runInContext(source.match(/^function openTempoEvidence\([^]*?^\}/m)[0], c);
    c.openTempoEvidence();
    while (frames.length) frames.shift()();
    assert.deepEqual(views, [{ view: 'deal', scroll: false }]);
    assert.deepEqual(revealed, [hasReceipt ? '#receiptTransactionList' : '.primary-order-action']);
    assert.equal(c.window.location.hash, 'deal');
  }
});

test('a targeted page switch never schedules a later scroll-to-top', () => {
  const scrolls = [];
  const c = { document: { body: { classList: { toggle() {} } } },
    window: { scrollTo: (value) => scrolls.push(value) }, toastTimer: null,
    clearTimeout() {}, $: () => null, $$: () => [],
    requestAnimationFrame: () => assert.fail('unexpected delayed top reset'),
    setTimeout: () => assert.fail('unexpected delayed top reset') };
  vm.createContext(c);
  vm.runInContext(source.match(/^function showView\([^]*?^\}/m)[0], c);
  c.showView('deal', { scroll: false });
  assert.equal(scrolls.length, 0);
  c.showView('home');
  assert.equal(scrolls.length, 1);
});

test('current refund display requires the matching confirmed refund and balanced actual refund summary', () => {
  const hash = `0x${'3'.repeat(64)}`;
  const proof = { status: 'REFUNDED', refundHash: hash,
    refundReceipt: { settlementSummary: { committedCents: 204000, buyerRefundCents: 204000, sellerPayoutCents: 0, feeCents: 0 } },
    receipts: [{ hash, status: 'CONFIRMED', isOnChain: true }] };
  const c = { liveDemoState: proof };
  vm.createContext(c);
  vm.runInContext(source.match(/^function isCurrentRefundConfirmed\([^]*?^\}/m)[0], c);
  assert.equal(c.isCurrentRefundConfirmed(proof), true);
  assert.equal(c.isCurrentRefundConfirmed({ ...proof }), false, 'not historical evidence');
  proof.receipts[0].status = 'PENDING';
  assert.equal(c.isCurrentRefundConfirmed(proof), false);
  proof.receipts[0].status = 'CONFIRMED';
  proof.refundReceipt.settlementSummary.buyerRefundCents = 6000;
  assert.equal(c.isCurrentRefundConfirmed(proof), false, 'old surplus is not a full refund');
});

test('in-progress payment panel shows only confirmed rows and never claims payout or refund', () => {
  const nodes = new Map();
  const element = () => ({ textContent: '', hidden: false, children: [], classList: { toggle() {} },
    replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); } });
  const c = { $: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    document: { createElement: element }, formatExactCents: (value) => `$${(value / 100).toFixed(2)}`,
    TEMPO_EXPLORER: 'https://explore.testnet.tempo.xyz' };
  vm.createContext(c);
  vm.runInContext(source.match(/^function renderSettlementReceipt\([^]*?^\}/m)[0], c);
  c.renderSettlementReceipt({ committedCents: 68000 }, 'LIVE_TESTNET', 'new-order', null, 'FUNDING', {
    receipts: [
      { hash: `0x${'1'.repeat(64)}`, status: 'CONFIRMED', isOnChain: true, type: 'DEMO_BUYER_JOIN' },
      { hash: `0x${'2'.repeat(64)}`, status: 'PENDING', isOnChain: true, type: 'DEMO_BUYER_JOIN' },
    ],
  });
  assert.equal(nodes.get('#receiptTransactionLinks').children.length, 1);
  assert.equal(nodes.get('#receiptPayout').textContent, 'Not paid');
  assert.equal(nodes.get('#receiptRefund').textContent, 'Not returned yet');
  assert.equal(nodes.get('#receiptCommitted').textContent, '$680.00');
  assert.equal(nodes.get('#receiptTitle').textContent, 'New payments in progress');
});
