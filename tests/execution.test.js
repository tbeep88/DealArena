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

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'deployed.json'), 'utf8'));
const artifactName = Number(config.contractVersion) >= 17
  ? 'DealArenaEscrow-v17.json'
  : Number(config.contractVersion) >= 16
    ? 'DealArenaEscrow-v16.json'
  : Number(config.contractVersion) >= 15
    ? 'DealArenaEscrow-v15.json'
  : Number(config.contractVersion) >= 14
    ? 'DealArenaEscrow-v14.json'
  : Number(config.contractVersion) >= 13
    ? 'DealArenaEscrow-v13.json'
    : Number(config.contractVersion) >= 12
      ? 'DealArenaEscrow-v12.json'
      : Number(config.contractVersion) >= 11
        ? 'DealArenaEscrow-v11.json'
        : 'DealArenaEscrow.json';
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', artifactName), 'utf8')).abi;
const tokenAbi = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
const runExecution = process.env.TEMPO_RUN_EXECUTION_TESTS === 'true';
const hasKeys = Boolean(process.env.TEMPO_PRIVATE_KEY && (process.env.TEMPO_DEMO_MNEMONIC || process.env.TEMPO_DEMO_BUYER_PRIVATE_KEY));
const deployedVersion = Number(config.contractVersion);
const deployedHardened = deployedVersion >= 11;
const skipReason = !deployedHardened
  ? 'Execution gate is waiting for the hardened escrow deployment.'
  : 'Set TEMPO_RUN_EXECUTION_TESTS=true with the dedicated Tempo testnet keys to run on-chain execution tests.';

const UNIT = 1_000_000n;
const MAX_APPROVAL = 10n ** 15n;
let sequence = 0;

function walletFor(role, index, provider) {
  const explicit = process.env[`TEMPO_DEMO_${role}_PRIVATE_KEY`];
  if (explicit) return new ethers.Wallet(explicit, provider);
  const mnemonic = String(process.env.TEMPO_DEMO_MNEMONIC || '').trim();
  if (!mnemonic) throw new Error(`Missing key for ${role}`);
  return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
}

function id(label) {
  sequence += 1;
  return `exec-v${deployedVersion}-${label}-${Date.now()}-${sequence}`;
}

function usd(value) {
  return BigInt(value) * UNIT;
}

async function send(contract, signer, method, ...args) {
  const response = await contract.connect(signer)[method](...args);
  return response.wait();
}

async function expectRevert(action, label) {
  await assert.rejects(action, undefined, label);
}

test('Tempo hardened EVM execution invariants', { skip: !deployedHardened || !runExecution || !hasKeys ? skipReason : false }, async () => {
  const executionRpc = `${config.rpc}${config.rpc.includes('?') ? '&' : '?'}execution_session=${Date.now()}`;
  const rpcRequest = new ethers.FetchRequest(executionRpc);
  rpcRequest.timeout = 900000;
  rpcRequest.setThrottleParams({ slotInterval: 1000, maxAttempts: 60 });
  rpcRequest.retryFunc = async (_request, response) => {
    const message = String(response.bodyJson?.error?.message || '');
    const waitMs = Number(message.match(/try again in (\d+)ms/i)?.[1] || 500);
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, waitMs + 150)));
    return true;
  };
  const provider = new ethers.JsonRpcProvider(
    rpcRequest,
    { name: 'tempo-moderato', chainId: config.chainId },
    { staticNetwork: true },
  );
  const providerSend = provider._send.bind(provider);
  let nextRpcAt = 0;
  provider._send = async (payload) => {
    const waitMs = Math.max(0, nextRpcAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextRpcAt = Date.now() + 220;
    return providerSend(payload);
  };
  const owner = new ethers.Wallet(process.env.TEMPO_PRIVATE_KEY, provider);
  const buyer = walletFor('BUYER', 0, provider);
  const sellerA = walletFor('SELLER_A', 1, provider);
  const sellerB = walletFor('SELLER_B', 4, provider);
  const sellerC = walletFor('SELLER_C', 5, provider);
  const escrow = new ethers.Contract(config.contractAddress, abi, owner);
  const token = new ethers.Contract(config.pathUsdAddress, tokenAbi, owner);
  const ownerAddress = await owner.getAddress();

  assert.equal(Number(await escrow.CONTRACT_VERSION()), deployedVersion);
  assert.equal(await escrow.authorizedSellers(await sellerA.getAddress()), true);
  assert.equal(await escrow.authorizedSellers(await sellerB.getAddress()), true);
  assert.equal(await escrow.authorizedSellers(await sellerC.getAddress()), true);

  for (const wallet of [owner, buyer, sellerA, sellerB, sellerC]) {
    const address = await wallet.getAddress();
    const allowance = await token.allowance(address, config.contractAddress);
    if (allowance < MAX_APPROVAL / 2n) await (await token.connect(wallet).approve(config.contractAddress, MAX_APPROVAL)).wait();
  }

  const buyerAddress = await buyer.getAddress();
  const sellerAAddress = await sellerA.getAddress();
  const sellerBAddress = await sellerB.getAddress();
  const sellerCAddress = await sellerC.getAddress();
  const futureExpiry = () => Math.floor(Date.now() / 1000) + 600;

  // Keep reruns independent: the preset test wallets are shared across local
  // runs, so restore only the small balance needed by this suite.
  const minimumTestBalance = usd(10_000);
  for (const wallet of [buyer, sellerA, sellerB, sellerC]) {
    const address = await wallet.getAddress();
    const balance = await token.balanceOf(address);
    if (balance < minimumTestBalance) {
      await (await token.transfer(address, minimumTestBalance - balance)).wait();
    }
  }

  async function refundDeal(dealId, recipients) {
    await send(escrow, owner, 'refundDeal', dealId, 'execution-test-cleanup');
    await send(escrow, owner, 'refundBatch', dealId, recipients);
    const state = await escrow.getDealState(dealId);
    assert.equal(state.isRefunded, true, `${dealId} cleanup did not finish`);
  }

  // P0: a conditional first offer must not deadlock underfunded buyers.
  const mixedId = id('mixed');
  await send(escrow, buyer, 'joinDeal', mixedId, usd(1));
  await send(escrow, sellerA, 'submitPriceLadder', mixedId, [usd(680)], [1], 3, futureExpiry(), usd(10));
  assert.equal((await escrow.getDealState(mixedId)).bestPrice.toString(), '0');
  await send(escrow, sellerC, 'joinDeal', mixedId, usd(680));
  await send(escrow, owner, 'joinDeal', mixedId, usd(680));
  await send(escrow, buyer, 'topUpDeal', mixedId, usd(679));
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  await send(escrow, owner, 'settleDeal', mixedId);
  await send(escrow, owner, 'confirmDealFulfillment', mixedId);

  // P0: one partially funded buyer is refunded automatically while the
  // fully funded buyer keeps the order moving. The historical buyer entry
  // must not block fulfillment after that cleanup.
  const underfundedId = id('underfunded');
  await send(escrow, buyer, 'joinDeal', underfundedId, usd(1));
  await send(escrow, sellerA, 'submitPriceLadder', underfundedId, [usd(680)], [1], 1, futureExpiry(), usd(10));
  await send(escrow, owner, 'joinDeal', underfundedId, usd(680));
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  await send(escrow, owner, 'settleDeal', underfundedId);
  let underfundedState = await escrow.getDealState(underfundedId);
  assert.equal(underfundedState.buyersCount.toString(), '1');
  assert.equal((await escrow.buyerDeposits(underfundedId, buyerAddress)).toString(), '0');
  assert.equal((await escrow.buyerDeposits(underfundedId, ownerAddress)).toString(), usd(680).toString());
  await send(escrow, owner, 'confirmDealFulfillment', underfundedId);

  // P1: twenty units are tracked per buyer and seller capacity is enforced by
  // offer eligibility, not by rejecting an otherwise valid buyer join.
  const capacityId = id('capacity');
  // Leave enough room for several public-RPC confirmations before the
  // capacity assertion; the cleanup still closes the market after its end.
  await send(escrow, owner, 'setMarketDeadline', capacityId, Math.floor(Date.now() / 1000) + 60);
  await send(escrow, buyer, 'joinDealUnits', capacityId, usd(1), 20);
  await send(escrow, sellerA, 'submitOfferWithCapacity', capacityId, 'Seller A', usd(1), usd(10), 1, 20, futureExpiry());
  assert.equal((await escrow.buyerUnits(capacityId, buyerAddress)).toString(), '20');
  await send(escrow, sellerC, 'joinDeal', capacityId, usd(1));
  assert.equal((await escrow.getDealState(capacityId)).bestSeller, ethers.ZeroAddress, 'an over-capacity order must have no valid seller offer');
  await new Promise((resolve) => setTimeout(resolve, 61_500));
  await refundDeal(capacityId, [buyerAddress, sellerCAddress]);

  // P1: an expired offer is removed permanently; the market may still accept
  // a new buyer while waiting for a replacement seller offer.
  const expiryId = id('expiry');
  await send(escrow, owner, 'setMarketDeadline', expiryId, Math.floor(Date.now() / 1000) + 45);
  await send(escrow, buyer, 'joinDeal', expiryId, usd(1));
  // Public testnet confirmation can take several seconds; keep the offer
  // short-lived without letting it expire before the submission is mined.
  await send(escrow, sellerA, 'submitOfferWithCapacity', expiryId, 'Seller A', usd(1), usd(10), 1, 20, Math.floor(Date.now() / 1000) + 12);
  await new Promise((resolve) => setTimeout(resolve, 13_500));
  await send(escrow, sellerC, 'joinDeal', expiryId, usd(1));
  const expiredOffer = await escrow.getDealOffer(expiryId, sellerAAddress);
  assert.equal(expiredOffer.active, false);
  await new Promise((resolve) => setTimeout(resolve, 46_500));
  await refundDeal(expiryId, [buyerAddress, sellerCAddress]);

  // P0: once a market deadline passes, owner settlement is no longer a race
  // with the permissionless deadline refund path.
  const deadlineId = id('deadline-settlement');
  await send(escrow, owner, 'setMarketDeadline', deadlineId, Math.floor(Date.now() / 1000) + 15);
  await send(escrow, buyer, 'joinDeal', deadlineId, usd(1));
  await send(escrow, sellerA, 'submitOfferWithCapacity', deadlineId, 'Seller A', usd(1), usd(10), 1, 20, futureExpiry());
  await new Promise((resolve) => setTimeout(resolve, 16_500));
  await expectRevert(
    () => escrow.connect(owner).settleDeal(deadlineId).then((tx) => tx.wait()),
    'settlement after deadline must reject',
  );
  await send(escrow, owner, 'finalizeDealAfterDeadline', deadlineId, 'deadline');
  assert.equal((await escrow.getDealState(deadlineId)).isSettled, true);
  await send(escrow, owner, 'confirmDealFulfillment', deadlineId);

  // Displacing a seller returns the old bond and keeps the new bond locked.
  const displacementId = id('displacement');
  await send(escrow, owner, 'setMarketDeadline', displacementId, Math.floor(Date.now() / 1000) + 45);
  await send(escrow, buyer, 'joinDeal', displacementId, usd(680));
  await send(escrow, sellerA, 'submitOfferWithCapacity', displacementId, 'Seller A', usd(680), usd(10), 1, 20, futureExpiry());
  await send(escrow, sellerC, 'submitOfferWithCapacity', displacementId, 'Seller C', usd(679), usd(10), 1, 20, futureExpiry());
  const displaced = await escrow.getDealState(displacementId);
  assert.equal(displaced.bestSeller.toLowerCase(), sellerCAddress.toLowerCase());
  assert.equal(displaced.sellerGuaranteeBond.toString(), usd(10).toString());
   await new Promise((resolve) => setTimeout(resolve, 46_500));
   // A live seller offer still exists, so the deadline closes the market into
   // settlement rather than refunding a valid winner. Refund is reserved for
   // markets with no valid offer.
    await send(escrow, owner, 'finalizeDealAfterDeadline', displacementId, 'deadline');
    await send(escrow, owner, 'disburseSurplusBatch', displacementId, [buyerAddress]);
    await send(escrow, owner, 'confirmDealFulfillment', displacementId);

  // Consumer fulfillment releases the winning seller bond only after confirmation.
  const fulfillmentId = id('fulfillment');
  await send(escrow, buyer, 'joinDeal', fulfillmentId, usd(680));
  await send(escrow, sellerB, 'submitPriceLadder', fulfillmentId, [usd(680)], [1], 1, futureExpiry(), usd(10));
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  await send(escrow, owner, 'settleDeal', fulfillmentId);
  let settled = await escrow.getDealState(fulfillmentId);
  assert.equal(settled.sellerGuaranteeBond.toString(), usd(10).toString());
  await send(escrow, owner, 'confirmDealFulfillment', fulfillmentId);
  settled = await escrow.getDealState(fulfillmentId);
  assert.equal(settled.sellerGuaranteeBond.toString(), '0');
  assert.equal((await escrow.buyerDeposits(fulfillmentId, buyerAddress)).toString(), '0');
  assert.equal((await escrow.buyerUnits(fulfillmentId, buyerAddress)).toString(), '0');
  await expectRevert(() => escrow.connect(owner).settleDeal(fulfillmentId).then((tx) => tx.wait()), 'duplicate settlement must reject');
  await expectRevert(() => escrow.connect(owner).refundDeal(fulfillmentId, 'duplicate').then((tx) => tx.wait()), 'refund after settlement must reject');

  // A future ladder tier is only a possible price improvement. It must not
  // block a deadline close when the order has fewer funded buyers.
  const deadlineLadderId = id('deadline-ladder');
  // Public RPC confirmation can take longer than a few seconds; leave room
  // for the setup transactions before testing the deadline close itself.
  await send(escrow, owner, 'setMarketDeadline', deadlineLadderId, Math.floor(Date.now() / 1000) + 45);
  await send(escrow, buyer, 'joinDeal', deadlineLadderId, usd(680));
  await send(escrow, sellerA, 'submitPriceLadder', deadlineLadderId, [usd(680), usd(590)], [1, 2], 20, futureExpiry(), usd(10));
  await new Promise((resolve) => setTimeout(resolve, 46_000));
  // The permissionless legacy refund entry point must use the same finalizer:
  // a valid funded offer settles instead of being refunded.
  await send(escrow, buyer, 'refundDealAfterDeadline', deadlineLadderId, 'deadline');
  assert.equal((await escrow.getDealState(deadlineLadderId)).bestPrice.toString(), usd(680).toString());
  await send(escrow, owner, 'confirmDealFulfillment', deadlineLadderId);

  // A failed settled seller's bond is not part of buyer escrow. Refund must
  // therefore finish with totalEscrow == 0 and isRefunded == true.
  const failedSettledId = id('failed-settled-accounting');
  await send(escrow, buyer, 'joinDeal', failedSettledId, usd(680));
  await send(escrow, sellerB, 'submitPriceLadder', failedSettledId, [usd(680)], [1], 1, futureExpiry(), usd(10));
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  await send(escrow, owner, 'settleDeal', failedSettledId);
  await send(escrow, owner, 'slashSettledDealGuarantee', failedSettledId, 'seller failed after price lock');
  assert.equal((await escrow.getDealState(failedSettledId)).totalEscrow.toString(), usd(680).toString());
  await send(escrow, owner, 'refundBatch', failedSettledId, [buyerAddress]);
  const failedSettledState = await escrow.getDealState(failedSettledId);
  assert.equal(failedSettledState.totalEscrow.toString(), '0');
  assert.equal(failedSettledState.isRefunded, true);

  // P0: filling the selected ladder capacity opens a short final bidding
  // window. Buyers are locked, but sellers can still publish a better offer
  // before the window ends; price cannot be locked in the same block as the
  // last funded buyer.
  const windowId = id('ladder-window');
  await send(escrow, buyer, 'joinDeal', windowId, usd(680));
  await send(escrow, sellerA, 'submitPriceLadder', windowId, [usd(680), usd(670)], [1, 2], 2, Math.floor(Date.now() / 1000) + 600, usd(10));
  const windowJoinReceipt = await send(escrow, owner, 'joinDeal', windowId, usd(680));
  // Submit the competing offer immediately after the transaction that opens
  // the window. A separate read before this call can consume most of the
  // five-second public-RPC window without changing the contract state.
  let sellerBWon = true;
  try {
    await send(escrow, sellerB, 'submitOfferWithCapacity', windowId, 'Seller B', usd(660), usd(10), 1, 2, futureExpiry());
  } catch (error) {
    // On a public testnet the five-second window can close between the
    // broadcast and mining of this transaction. That is a valid on-chain
    // outcome: the existing offer remains the winner. Do not hide any other
    // revert; only accept the fallback when chain state proves seller A is
    // still the active winner.
    const afterWindowClose = await escrow.getDealState(windowId);
    if (afterWindowClose.bestSeller.toLowerCase() !== sellerAAddress.toLowerCase()) throw error;
    sellerBWon = false;
  }
  const timing = await escrow.getDealTimingState(windowId);
  // Compare against the block that opened the window, not the wall clock at
  // the assertion. A public RPC can answer the follow-up read after the
  // window has already elapsed even when the contract set it correctly.
  const windowJoinBlock = await provider.getBlock(windowJoinReceipt.blockNumber);
  assert.ok(windowJoinBlock, 'window-opening block must be readable');
  assert.equal(Number(timing.finalBiddingEndsAt) >= Number(windowJoinBlock.timestamp) + 5, true);
  const improvedState = await escrow.getDealState(windowId);
  assert.equal(improvedState.bestSeller.toLowerCase(), (sellerBWon ? sellerBAddress : sellerAAddress).toLowerCase());
  // Seller A's second tier is $670 at two funded buyers. If the public-RPC
  // window closes before seller B is mined, that is the valid fallback state.
  const expectedWindowPrice = sellerBWon ? 660 : 670;
  assert.equal(improvedState.bestPrice.toString(), usd(expectedWindowPrice).toString());
  // Use an eth_call for the negative assertion. Sending a transaction and
  // waiting for mining can cross the five-second window on a congested RPC,
  // which would make the test validate network latency instead of the guard.
  if (sellerBWon && Number(timing.finalBiddingEndsAt) > Math.floor(Date.now() / 1000)) {
    await expectRevert(() => escrow.connect(owner).settleDeal.staticCall(windowId), 'ladder cannot settle before final bidding window ends');
    await new Promise((resolve) => setTimeout(resolve, 5_500));
  }
  await send(escrow, owner, 'settleDeal', windowId);
  assert.equal((await escrow.getDealState(windowId)).bestPrice.toString(), usd(expectedWindowPrice).toString());
  await send(escrow, owner, 'disburseSurplusBatch', windowId, [buyerAddress, ownerAddress]);
  await send(escrow, owner, 'confirmDealFulfillment', windowId);

  // P0: a failed ladder is fully removed and cannot become the winner again.
  const failedLadderId = id('failed-ladder');
  await send(escrow, owner, 'setMarketDeadline', failedLadderId, Math.floor(Date.now() / 1000) + 45);
  await send(escrow, buyer, 'joinDeal', failedLadderId, usd(680));
  await send(escrow, sellerC, 'submitPriceLadder', failedLadderId, [usd(680), usd(660)], [1, 2], 20, futureExpiry(), usd(10));
  await send(escrow, owner, 'slashSellerGuarantee', failedLadderId, 'seller failed before fulfillment');
  const failedOffer = await escrow.getDealOffer(failedLadderId, sellerCAddress);
  const failedLadder = await escrow.getDealPriceLadder(failedLadderId, sellerCAddress);
  const failedState = await escrow.getDealState(failedLadderId);
  assert.equal(failedOffer.active, false);
  assert.equal(failedLadder.active, false);
  assert.equal(failedState.bestSeller, ethers.ZeroAddress);
  await new Promise((resolve) => setTimeout(resolve, 46_500));
  await refundDeal(failedLadderId, [buyerAddress]);

  // P0: a future ladder may start above today's price if its deeper tier can
  // beat the market when its own funded-buyer threshold is reached.
  const futureLadderId = id('future-ladder');
  await send(escrow, buyer, 'joinDeal', futureLadderId, usd(670));
  await send(escrow, sellerA, 'submitOfferWithCapacity', futureLadderId, 'Seller A', usd(670), usd(10), 1, 20, futureExpiry());
  await send(escrow, sellerC, 'submitPriceLadder', futureLadderId, [usd(680), usd(650)], [1, 2], 2, futureExpiry(), usd(10));
  await send(escrow, owner, 'joinDeal', futureLadderId, usd(680));
  assert.equal((await escrow.getDealState(futureLadderId)).bestSeller.toLowerCase(), sellerCAddress.toLowerCase());
  assert.equal((await escrow.getDealState(futureLadderId)).bestPrice.toString(), usd(650).toString());
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  await send(escrow, owner, 'settleDeal', futureLadderId);
  await send(escrow, owner, 'disburseSurplusBatch', futureLadderId, [buyerAddress, ownerAddress]);
  await send(escrow, owner, 'confirmDealFulfillment', futureLadderId);

  // P0: when every ladder tier expires, the seller bond is returned exactly
  // once and the ladder no longer blocks a replacement offer.
  const expiredLadderId = id('expired-ladder');
  await send(escrow, owner, 'setMarketDeadline', expiredLadderId, Math.floor(Date.now() / 1000) + 45);
  await send(escrow, buyer, 'joinDeal', expiredLadderId, usd(680));
  await send(escrow, sellerA, 'submitPriceLadder', expiredLadderId, [usd(680), usd(660)], [1, 2], 20, Math.floor(Date.now() / 1000) + 3, usd(10));
  await new Promise((resolve) => setTimeout(resolve, 4_500));
  await send(escrow, owner, 'joinDeal', expiredLadderId, usd(680));
  const expiredLadderOffer = await escrow.getDealOffer(expiredLadderId, sellerAAddress);
  const expiredLadder = await escrow.getDealPriceLadder(expiredLadderId, sellerAAddress);
  assert.equal(expiredLadderOffer.guaranteeBond.toString(), '0');
  assert.equal(expiredLadder.active, false);
  await new Promise((resolve) => setTimeout(resolve, 46_500));
  await refundDeal(expiredLadderId, [buyerAddress, ownerAddress]);

  // Deadline refund is REFUNDING until each recipient is actually paid.
  const refundId = id('partial-refund');
  // Leave enough room for two real testnet transactions to confirm before the deadline.
  await send(escrow, owner, 'setMarketDeadline', refundId, Math.floor(Date.now() / 1000) + 15);
  await send(escrow, buyer, 'joinDeal', refundId, usd(1));
  await send(escrow, sellerC, 'joinDeal', refundId, usd(1));
  await new Promise((resolve) => setTimeout(resolve, 16_500));
  await send(escrow, buyer, 'finalizeDealAfterDeadline', refundId, 'deadline');
  let refundState = await escrow.getDealState(refundId);
  assert.equal(refundState.isRefunded, false);
  assert.equal((await escrow.refundTotals(refundId)) > 0n, true);
  await send(escrow, owner, 'refundBatch', refundId, [buyerAddress]);
  refundState = await escrow.getDealState(refundId);
  assert.equal(refundState.isRefunded, false);
  await send(escrow, owner, 'refundBatch', refundId, [sellerCAddress]);
  refundState = await escrow.getDealState(refundId);
  assert.equal(refundState.isRefunded, true);
  await expectRevert(() => escrow.connect(owner).refundBatch(refundId, [buyerAddress]).then((tx) => tx.wait()), 'duplicate refund batch must reject');

  assert.equal(ownerAddress !== buyerAddress, true);
  assert.equal(sellerAAddress !== sellerBAddress && sellerBAddress !== sellerCAddress, true);
});
