'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ActionJournal } = require('../action-journal');
const { createExecutor } = require('../wallet-actions');

test('durable action IDs never dispatch twice and reject payload reuse', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealarena-journal-'));
  const file = path.join(directory, 'actions.json');
  try {
    const journal = new ActionJournal(file);
    let dispatches = 0;
    const pending = await journal.run('settle:request:000001', { id: 'request-A', price: 56000 }, async (update) => {
      dispatches++;
      update({ status: 'BROADCASTING', hash: '0xabc' });
      const err = new Error('RPC response lost');
      err.txStatus = 'PENDING'; err.txHash = '0xabc'; throw err;
    });
    assert.equal(pending.status, 'PENDING');
    const restored = new ActionJournal(file);
    const replay = await restored.run('settle:request:000001', { id: 'request-A', price: 56000 }, async () => { dispatches++; });
    assert.equal(replay.hash, '0xabc');
    assert.equal(dispatches, 1);
    await assert.rejects(restored.run('settle:request:000001', { id: 'request-B', price: 56000 }, async () => {}), /payload conflict/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a confirmed settlement action is replayed as the same receipt, never settled again', async () => {
  const journal = new ActionJournal(null);
  let settlements = 0;
  const action = async () => {
    settlements++;
    return { success: true, status: 'CONFIRMED', isOnChain: true, hash: '0xconfirmed' };
  };
  const first = await journal.run('settle:deal:000002', { dealId: 'deal-560', price: 56000 }, action);
  const repeated = await journal.run('settle:deal:000002', { dealId: 'deal-560', price: 56000 }, action);
  assert.equal(first.hash, '0xconfirmed');
  assert.equal(repeated.hash, '0xconfirmed');
  assert.equal(settlements, 1);
});

test('a failed action without a broadcast hash can be retried with the same action ID', async () => {
  const journal = new ActionJournal(null);
  let attempts = 0;
  const task = async () => {
    attempts++;
    if (attempts === 1) throw new Error('validation failed before broadcast');
    return { success: true, status: 'CONFIRMED', isOnChain: true, hash: '0xretried' };
  };
  const first = await journal.run('settle:deal:retry', { dealId: 'deal-retry' }, task);
  const second = await journal.run('settle:deal:retry', { dealId: 'deal-retry' }, task);
  assert.equal(first.status, 'FAILED');
  assert.equal(first.hash, null);
  assert.equal(second.hash, '0xretried');
  assert.equal(attempts, 2);
});

test('a failed action with a broadcast hash is never retried automatically', async () => {
  const journal = new ActionJournal(null);
  let attempts = 0;
  const task = async (update) => {
    attempts++;
    update({ status: 'BROADCASTING', hash: '0xbroadcasted' });
    const error = new Error('receipt uncertain');
    error.txStatus = 'FAILED';
    error.txHash = '0xbroadcasted';
    throw error;
  };
  const first = await journal.run('settle:deal:no-retry', { dealId: 'deal-no-retry' }, task);
  const second = await journal.run('settle:deal:no-retry', { dealId: 'deal-no-retry' }, task);
  assert.equal(first.status, 'FAILED');
  assert.equal(second.hash, '0xbroadcasted');
  assert.equal(attempts, 1);
});

test('a lost wallet response is recorded as pending and cannot trigger another send', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let broadcasts = 0;
  const executor = createExecutor({
    storage,
    connect: async () => ({ signer: { sendTransaction: async () => { broadcasts++; throw new Error('response lost after broadcast'); } },
      address: '0x0000000000000000000000000000000000000001', chainId: 42431,
      contract: '0x0000000000000000000000000000000000000002' }),
    prepare: async () => ({ chainId: 42431, transaction: { to: '0x0000000000000000000000000000000000000002' },
      token: '0x0000000000000000000000000000000000000003', approvalAmount: '0' }),
    tokenFor: () => { throw new Error('No approval expected'); },
    proof: async () => ({ verified: true }),
  });
  const payload = { dealId: 'deal-A', unitPriceCents: 56000, quantity: 1 };
  const first = await executor('joinDeal', payload, 1);
  const replay = await executor('joinDeal', payload, 1);
  assert.equal(first.status, 'PENDING');
  assert.equal(replay.status, 'PENDING');
  assert.equal(broadcasts, 1);
});

test('a later read-only receipt check resolves a timed-out wallet dispatch', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let broadcasts = 0;
  let receiptReady = false;
  const receipt = { hash: '0x' + '1'.repeat(64), status: 1, logs: [] };
  const executor = createExecutor({
    storage,
    connect: async () => ({
      signer: {
        provider: { getTransactionReceipt: async () => receiptReady ? receipt : null },
        sendTransaction: async () => {
          broadcasts += 1;
          return { hash: receipt.hash, wait: async () => { throw new Error('receipt response delayed'); } };
        },
      },
      address: '0x0000000000000000000000000000000000000001', chainId: 42431,
      contract: '0x0000000000000000000000000000000000000002',
    }),
    prepare: async () => ({ chainId: 42431, transaction: { to: '0x0000000000000000000000000000000000000002' }, token: '0x0000000000000000000000000000000000000003', approvalAmount: '0' }),
    tokenFor: () => { throw new Error('No approval expected'); },
    proof: async (confirmed) => ({ verified: true, hash: confirmed.hash }),
  });
  const payload = { dealId: 'deal-recover', unitPriceCents: 56000, quantity: 1 };
  const first = await executor('joinDeal', payload, 1);
  assert.equal(first.status, 'PENDING');
  receiptReady = true;
  const recovered = await executor('joinDeal', payload, 1);
  assert.equal(recovered.status, 'CONFIRMED');
  assert.equal(broadcasts, 1);
});

test('reset during wallet preparation prevents the later send', async () => {
  const values = new Map();
  let currentEpoch = 1;
  let sends = 0;
  const executor = createExecutor({
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    connect: async () => ({ signer: { sendTransaction: async () => { sends++; } },
      address: '0x0000000000000000000000000000000000000001', chainId: 42431,
      contract: '0x0000000000000000000000000000000000000002' }),
    prepare: async () => { currentEpoch++; return { chainId: 42431, transaction: { to: '0x0000000000000000000000000000000000000002' },
      token: '0x0000000000000000000000000000000000000003', approvalAmount: '0' }; },
    tokenFor: () => ({}), proof: async () => ({}), isCurrent: (epoch) => epoch === currentEpoch,
  });
  const result = await executor('joinDeal', { dealId: 'deal-B', unitPriceCents: 56000 }, 1);
  assert.equal(result.status, 'STALE');
  assert.equal(sends, 0);
});
