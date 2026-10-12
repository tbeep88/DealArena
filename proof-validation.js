'use strict';
const { ethers } = require('ethers');

const expectedEvents = Object.freeze({
  DEMO_BUYER_JOIN: 'DealJoined',
  DEMO_SELLER_LADDER: 'PriceLadderSubmitted',
  DEMO_SELLER_OFFER: 'OfferSubmitted',
  TEMPO_NATIVE_SETTLEMENT: 'DealPriceLocked',
  TEMPO_FULFILLMENT_CONFIRMATION: 'FulfillmentPaymentReleased',
  TEMPO_NATIVE_FULFILLMENT: 'FulfillmentPaymentReleased',
  TEMPO_NATIVE_REFUND: 'RefundInitiated',
  TEMPO_FULFILLMENT_FAILURE: 'RefundInitiated',
  TEMPO_NATIVE_FULFILLMENT_FAILURE: 'RefundInitiated',
});

// This validates decoded contract events. Receipt success, destination and
// transaction sender must additionally be checked against the raw RPC receipt.
function receiptMatchesMarketAction(proof, expected, snapshot) {
  const marketId = expected.liveDealId || snapshot.liveDealId;
  const eventName = expectedEvents[expected.type];
  if (!marketId || !eventName) return false;
  const sameAddress = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  return (proof.events || []).some((event) => {
    if (event.name !== eventName || !Array.isArray(event.args)) return false;
    const args = event.args;
    // Solidity cannot recover an indexed string; ethers exposes its topic hash.
    if (String(args[0]) !== String(marketId)
      && String(args[0]?.hash || '').toLowerCase() !== ethers.id(String(marketId)).toLowerCase()) return false;
    const participantAction = expected.type.startsWith('DEMO_');
    if (participantAction) {
      if (!sameAddress(args[1], expected.actorAddress || expected.from)) return false;
    } else if (eventName === 'DealPriceLocked' || eventName === 'FulfillmentPaymentReleased') {
      // The operator submits the transaction, but the event names the seller.
      if (!snapshot.winningSeller || !sameAddress(args[1], snapshot.winningSeller)) return false;
    }
    const tokenUnits = (cents) => (BigInt(Math.round(Number(cents))) * 10000n).toString();
    if (expected.type === 'DEMO_BUYER_JOIN' && expected.unitPriceCents !== undefined
      && String(args[2]) !== tokenUnits(expected.unitPriceCents)) return false;
    if (expected.type === 'DEMO_SELLER_OFFER' && expected.priceCents !== undefined
      && String(args[3]) !== tokenUnits(expected.priceCents)) return false;
    if (expected.type === 'DEMO_SELLER_LADDER' && expected.ladder === true
      && String(args[3]) !== '3') return false;
    return true;
  });
}

module.exports = { receiptMatchesMarketAction };
