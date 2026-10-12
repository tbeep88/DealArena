(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WalletActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const timeout = async (promise, ms = 15000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Receipt pending; do not resend')), ms); })]); }
    finally { clearTimeout(timer); }
  };
  function createExecutor({ storage, connect, prepare, tokenFor, proof, isCurrent = () => true }) {
    let queue = Promise.resolve();
    async function reconcileSaved(saved, context) {
      const provider = context.signer?.provider;
      if (!provider || typeof provider.getTransactionReceipt !== 'function') {
        return { result: saved.result || { success: false, status: 'PENDING', hash: saved.hash || saved.approvalHash || null, error: 'Already dispatched. Check the receipt; do not send again.' } };
      }
      const check = async (hash) => {
        if (!hash) return null;
        try { return await provider.getTransactionReceipt(hash); } catch { return null; }
      };
      const paymentReceipt = await check(saved.hash);
      if (paymentReceipt) {
        if (Number(paymentReceipt.status) !== 1) {
          return { result: saved.result || { success: false, status: 'FAILED', hash: saved.hash, error: 'Transaction reverted; it was not resent.' } };
        }
        const prepared = await prepare(context.action, context.payload);
        if (prepared.chainId !== context.chainId || prepared.transaction.to.toLowerCase() !== context.contract.toLowerCase()) {
          return { result: { success: false, status: 'FAILED', hash: saved.hash, error: 'Saved transaction belongs to a different network or contract.' } };
        }
        const verified = await proof(paymentReceipt, prepared, context.payload);
        const result = { ...verified, actionId: saved.actionId, success: true, status: 'CONFIRMED', isOnChain: true, hash: paymentReceipt.hash || saved.hash, signerAddress: context.address };
        saved.result = result;
        saved.status = 'CONFIRMED';
        storage.setItem(context.key, JSON.stringify(saved));
        return { result };
      }
      const approvalReceipt = await check(saved.approvalHash);
      if (approvalReceipt) {
        if (Number(approvalReceipt.status) !== 1) {
          return { result: saved.result || { success: false, status: 'FAILED', hash: saved.approvalHash, error: 'Token approval reverted; it was not resent.' } };
        }
        // Approval succeeded but the payment transaction never got a hash.
        // Remove only this reservation so the next execution can safely send
        // the payment; the allowance check prevents a duplicate approval.
        storage.removeItem(context.key);
        return { retry: true };
      }
      return { result: saved.result || { success: false, status: 'PENDING', hash: saved.hash || saved.approvalHash || null, error: 'Result uncertain. Check the wallet receipt; do not resend.' } };
    }
    async function execute(action, payload, scope) {
      let key, record, attempted = false;
      const save = () => storage.setItem(key, JSON.stringify(record));
      try {
        const { signer, address, chainId, contract } = await connect();
        key = 'dealarena:action:' + JSON.stringify({ action, payload, address: address.toLowerCase(), chainId, contract: contract.toLowerCase() });
        const previous = storage.getItem(key);
        if (previous) {
          const saved = JSON.parse(previous);
          if (saved.result?.success) return saved.result;
          const reconciled = await reconcileSaved(saved, { signer, address, chainId, contract, action, payload, key });
          if (!reconciled.retry) return reconciled.result;
        }
        if (!isCurrent(scope)) return { success: false, status: 'STALE', error: 'View changed; nothing sent' };
        const prepared = await prepare(action, payload);
        if (prepared.chainId !== chainId || prepared.transaction.to.toLowerCase() !== contract.toLowerCase()) throw new Error('Prepared transaction has a different network or contract');
        record = { actionId: globalThis.crypto.randomUUID(), status: 'RESERVED', action, payload, address, chainId, contract };
        save(); // Fail closed if durable browser storage is unavailable.
        if (BigInt(prepared.approvalAmount || '0') > 0n) {
          const token = tokenFor(signer, prepared.token);
          if (BigInt(await token.allowance(address, contract)) < BigInt(prepared.approvalAmount)) {
          record.status = 'APPROVAL_DISPATCHING'; save(); attempted = true;
          const approval = await token.approve(contract, prepared.approvalAmount);
          record.approvalHash = approval.hash; save();
          const approvalReceipt = await timeout(approval.wait(1));
          if (!approvalReceipt || Number(approvalReceipt.status) !== 1) throw new Error('Token approval was not confirmed');
          record.status = 'APPROVED'; save(); attempted = false;
          }
        }
        if (!isCurrent(scope)) {
          storage.removeItem(key); // Approval may exist, but no buyer commitment was sent.
          return { success: false, status: 'STALE', error: 'View changed; commitment not sent' };
        }
        record.status = 'DISPATCHING'; save(); attempted = true;
        const tx = await signer.sendTransaction(prepared.transaction);
        record.hash = tx.hash; record.status = 'PENDING'; save();
        const receipt = await timeout(tx.wait(1));
        if (!receipt || Number(receipt.status) !== 1) {
          record.result = { success: false, status: 'FAILED', hash: tx.hash, error: 'Transaction reverted' };
          save(); return record.result;
        }
        const verified = await proof(receipt, prepared, payload);
        record.result = { ...verified, actionId: record.actionId, success: true, status: 'CONFIRMED', isOnChain: true, hash: receipt.hash || tx.hash, signerAddress: address };
        record.status = 'CONFIRMED'; save();
        return record.result;
      } catch (err) {
        const rejected = err.code === 4001 || err.code === 'ACTION_REJECTED';
        if (key && record) {
          if (rejected || !attempted) storage.removeItem(key);
          else {
            record.status = 'PENDING';
            record.result = { success: false, status: 'PENDING', hash: record.hash || record.approvalHash || null, error: 'Result uncertain. Do not resend; check the wallet receipt.' };
            try { save(); } catch { /* Remain fail-closed: the original dispatch reservation is retained. */ }
            return record.result;
          }
        }
        return { success: false, status: 'FAILED', error: err.message || 'Wallet action failed' };
      }
    }
    return (action, payload, scope) => {
      const promise = queue.then(() => execute(action, payload, scope));
      queue = promise.catch(() => {});
      return promise;
    };
  }
  return { createExecutor };
});
