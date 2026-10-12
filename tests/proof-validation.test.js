'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { receiptMatchesMarketAction } = require('../proof-validation');
const market = 'LIVE-test-proof';
const buyer = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const operator = '0x3333333333333333333333333333333333333333';
const indexed = { hash: ethers.id(market), _isIndexed: true };
const snapshot = { liveDealId: market, winningSeller: seller };
const proof = (name, args) => ({ events: [{ name, args }] });

test('buyer proof accepts the indexed market ID and exact funding amount', () => {
  const expected = { type: 'DEMO_BUYER_JOIN', from: buyer, unitPriceCents: 68000 };
  assert.equal(receiptMatchesMarketAction(proof('DealJoined', [indexed, buyer, '680000000']), expected, snapshot), true);
  assert.equal(receiptMatchesMarketAction(proof('DealJoined', [indexed, buyer, '1']), expected, snapshot), false);
  assert.equal(receiptMatchesMarketAction(proof('DealJoined', [indexed, seller, '680000000']), expected, snapshot), false);
  assert.equal(receiptMatchesMarketAction(proof('DealJoined', [{ hash: ethers.id('wrong') }, buyer, '680000000']), expected, snapshot), false);
});

test('operator settlement and fulfillment identify the seller, not the caller', () => {
  for (const [type, event] of [['TEMPO_NATIVE_SETTLEMENT', 'DealPriceLocked'], ['TEMPO_FULFILLMENT_CONFIRMATION', 'FulfillmentPaymentReleased']]) {
    const expected = { type, from: operator };
    assert.equal(receiptMatchesMarketAction(proof(event, [indexed, seller]), expected, snapshot), true);
    assert.equal(receiptMatchesMarketAction(proof(event, [indexed, operator]), expected, snapshot), false);
    assert.equal(receiptMatchesMarketAction(proof(event, [indexed, seller]), expected, { liveDealId: market }), false);
  }
});

test('ladder and competing offer match their own actor and fields', () => {
  assert.equal(receiptMatchesMarketAction(proof('PriceLadderSubmitted', [indexed, seller, '10000000', '3']), { type: 'DEMO_SELLER_LADDER', from: seller, ladder: true }, snapshot), true);
  assert.equal(receiptMatchesMarketAction(proof('PriceLadderSubmitted', [indexed, seller, '10000000', '2']), { type: 'DEMO_SELLER_LADDER', from: seller, ladder: true }, snapshot), false);
  assert.equal(receiptMatchesMarketAction(proof('OfferSubmitted', [indexed, seller, 'Seller A', '675000000']), { type: 'DEMO_SELLER_OFFER', from: seller, priceCents: 67500 }, snapshot), true);
});

test('unrelated event, unknown action and another market never become proof', () => {
  assert.equal(receiptMatchesMarketAction(proof('PaymentReference', [market, seller]), { type: 'TEMPO_NATIVE_SETTLEMENT' }, snapshot), false);
  assert.equal(receiptMatchesMarketAction(proof('DealJoined', [indexed, buyer]), { type: 'UNKNOWN' }, snapshot), false);
  assert.equal(receiptMatchesMarketAction(proof('RefundInitiated', [indexed]), { type: 'TEMPO_NATIVE_REFUND' }, snapshot), true);
  assert.equal(receiptMatchesMarketAction(proof('RefundInitiated', [{ hash: ethers.id('wrong') }]), { type: 'TEMPO_NATIVE_REFUND' }, snapshot), false);
});
