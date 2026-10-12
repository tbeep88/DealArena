const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const usd = (n) => BigInt(n) * 1_000_000n;
const tokenSource = `pragma solidity ^0.8.24;
contract TestUSD {
 mapping(address => uint256) public balanceOf;
 mapping(address => mapping(address => uint256)) public allowance;
 uint256 public totalSupply;
 function mint(address to, uint256 n) external { balanceOf[to] += n; totalSupply += n; }
 function approve(address to, uint256 n) external returns(bool) { allowance[msg.sender][to] = n; return true; }
 function transfer(address to, uint256 n) external returns(bool) { move(msg.sender, to, n); return true; }
 function transferWithMemo(address to, uint256 n, bytes32) external { move(msg.sender, to, n); }
 function transferFrom(address from, address to, uint256 n) external returns(bool) { require(allowance[from][msg.sender] >= n, "ALLOWANCE"); allowance[from][msg.sender] -= n; move(from, to, n); return true; }
 function move(address from, address to, uint256 n) internal { require(balanceOf[from] >= n, "BALANCE"); balanceOf[from] -= n; balanceOf[to] += n; }
}`;

function compileTokenInChildProcess() {
  const childSource = `
    const solc = require('solc');
    const source = process.env.DEALARENA_TEST_TOKEN_SOURCE;
    const output = JSON.parse(solc.compile(JSON.stringify({
      language: 'Solidity',
      sources: { 'TestUSD.sol': { content: source } },
      settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } },
    })));
    process.stdout.write(JSON.stringify(output.contracts['TestUSD.sol'].TestUSD));
  `;
  const result = spawnSync(process.execPath, ['-e', childSource], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DEALARENA_TEST_TOKEN_SOURCE: tokenSource },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Test token compiler failed');
  return JSON.parse(result.stdout);
}

function loadCompiledArtifact() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'DealArenaEscrow.sol'));
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'compiled-v17.json'), 'utf8'));
  assert.equal(artifact.sourceHash, crypto.createHash('sha256').update(source).digest('hex'), 'compiled-v17 artifact must match the current contract source');
  return artifact;
}

test('full v17 fixed modules execute EVM money lifecycles at one address', { timeout: 180000 }, async (t) => {
  const artifact = loadCompiledArtifact();
  const tk = compileTokenInChildProcess();
  assert.equal(artifact.abi.filter((item) => item.type === 'function').length, 97);
  for (const entry of [artifact, ...artifact.modules]) assert.ok(entry.runtimeBytes <= 24576);
  const rpc = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, miner: { blockGasLimit: 30_000_000 }, wallet: { totalAccounts: 9 } });
  t.after(async () => rpc.disconnect());
  const provider = new ethers.BrowserProvider(rpc);
  provider.pollingInterval = 10;
  const actors = await Promise.all(Array.from({ length: 9 }, (_, i) => provider.getSigner(i)));
  const [owner, b1, b2, b3, sellerA, sellerB, outsider, treasury] = actors;
  const accounts = await Promise.all(actors.map((a) => a.getAddress()));
  const send = async (contract, signer, method, ...args) => (await contract.connect(signer)[method](...args, { gasLimit: 12_000_000 })).wait();
  const token = await new ethers.ContractFactory(tk.abi, tk.evm.bytecode.object, owner).deploy();
  await token.waitForDeployment();
  const deployedModules = [];
  for (const module of artifact.modules) {
    const deployed = await new ethers.ContractFactory(module.abi, module.bytecode, owner).deploy({ gasLimit: 12_000_000 });
    await deployed.waitForDeployment();
    deployedModules.push(deployed);
  }
  const escrow = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner).deploy(await token.getAddress(), accounts[7], await Promise.all(deployedModules.map((m) => m.getAddress())), artifact.modules.map((m) => m.selectors), { gasLimit: 12_000_000 });
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  for (const actor of actors) {
    await send(token, owner, 'mint', await actor.getAddress(), usd(10000));
    await send(token, actor, 'approve', address, ethers.MaxUint256);
  }
  assert.equal(await escrow.CONTRACT_VERSION(), 17n);
  assert.equal(await escrow.owner(), accounts[0]);
  assert.equal(await escrow.paymentToken(), await token.getAddress());
  await assert.rejects(escrow.connect(outsider).setTreasury.staticCall(accounts[6]));
  await assert.rejects(deployedModules[0].connect(b1).joinDeal.staticCall('direct', usd(680)));
  const deadline = async (id, market = 0) => {
    const now = Number((await rpc.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp);
    const end = now + 100;
    await send(escrow, owner, market ? 'setMarketDeadlineForMarket' : 'setMarketDeadline', ...(market ? [market, id, end] : [id, end]));
    return end;
  };
  const advance = async (seconds) => {
    await rpc.request({ method: 'evm_increaseTime', params: [seconds] });
    await rpc.request({ method: 'evm_mine', params: [] });
  };
  const balance = (actor) => token.balanceOf(accounts[actors.indexOf(actor)]);

  await t.test('final bidding locks buyers but keeps seller competition open', async () => {
    const id = 'final-bidding-seller-window';
    const end = await deadline(id);
    await send(escrow, b1, 'joinDeal', id, usd(680));
    await send(escrow, sellerA, 'submitPriceLadder', id, [usd(680), usd(670)], [1, 2], 2, end, usd(10));
    await send(escrow, b2, 'joinDeal', id, usd(680));

    const opened = await escrow.getDealTimingState(id);
    assert.ok(opened.finalBiddingEndsAt > 0n, 'hard-cap funding must open the final bidding window');
    await assert.rejects(
      escrow.connect(b3).joinDeal.staticCall(id, usd(680)),
      /FINAL_BIDDING_LOCKED/,
      'new buyers must be locked during final bidding',
    );

    await send(escrow, sellerB, 'submitOfferWithCapacity', id, 'Seller B', usd(660), usd(10), 1, 2, end);
    const improved = await escrow.getDealState(id);
    assert.equal(improved.bestSeller, accounts[5]);
    assert.equal(improved.bestPrice, usd(660));

    await advance(6);
    await assert.rejects(
      escrow.connect(outsider).submitOfferWithCapacity.staticCall(id, 'Seller C', usd(650), usd(10), 1, 2, end),
      /FINAL_BIDDING_LOCKED/,
      'seller competition must stop when the final window ends',
    );
    await send(escrow, owner, 'settleDeal', id);
    await send(escrow, owner, 'disburseSurplusBatch', id, [accounts[1], accounts[2]]);
    await send(escrow, owner, 'confirmDealFulfillment', id);
    assert.equal(await escrow.dealStatus(id), 3n);

    const topUpId = 'final-bidding-top-up';
    const topUpEnd = await deadline(topUpId);
    await send(escrow, b1, 'joinDeal', topUpId, usd(1));
    await send(escrow, sellerA, 'submitPriceLadder', topUpId, [usd(680)], [1], 2, topUpEnd, usd(10));
    await send(escrow, b2, 'joinDeal', topUpId, usd(680));
    await send(escrow, b1, 'topUpDeal', topUpId, usd(679));
    const topUpTiming = await escrow.getDealTimingState(topUpId);
    assert.ok(topUpTiming.finalBiddingEndsAt > 0n, 'a top-up that fills capacity must open final bidding');
    await assert.rejects(
      escrow.connect(b2).joinDeal.staticCall(topUpId, usd(680)),
      /FINAL_BIDDING_LOCKED/,
      'top-up final bidding must lock new buyers',
    );
    await advance(6);
    await send(escrow, owner, 'settleDeal', topUpId);
    await send(escrow, owner, 'confirmDealFulfillment', topUpId);
    assert.equal(await escrow.dealStatus(topUpId), 3n);
  });

  await t.test('underfunded buyer cleanup does not block the funded buyer payout', async () => {
    const id = 'underfunded-buyer-cleanup';
    const end = await deadline(id);
    await send(escrow, b1, 'joinDeal', id, usd(1));
    await send(escrow, sellerA, 'submitOfferWithCapacity', id, 'Seller A', usd(680), usd(14), 1, 2, end);
    await send(escrow, b2, 'joinDeal', id, usd(680));
    await send(escrow, owner, 'removeUnfundedDealBuyers', id, [accounts[1]]);
    await send(escrow, b1, 'joinDeal', id, usd(680));
    const buyersAfterRejoin = await escrow.getDealBuyers(id);
    assert.equal(buyersAfterRejoin.filter((buyer) => buyer.toLowerCase() === accounts[1].toLowerCase()).length, 1);
    await advance(101);
    await escrow.settleDealAfterDeadline.staticCall(id);
    await send(escrow, owner, 'settleDealAfterDeadline', id);
    await send(escrow, owner, 'disburseSurplusBatch', id, [accounts[1], accounts[2]]);
    assert.equal(await escrow.buyerDeposits(id, accounts[2]), usd(680));
    await send(escrow, owner, 'confirmDealFulfillment', id);
    assert.equal(await escrow.buyerDeposits(id, accounts[1]), 0n);
    assert.equal(await escrow.buyerDeposits(id, accounts[2]), 0n);
    assert.equal(await escrow.dealStatus(id), 3n);
  });

  await t.test('funding, future ladder, deterministic deadline, surplus, held payout and fee', async () => {
    const id = 'deal-paid';
    const end = await deadline(id);
    const sellerBefore = await balance(sellerA);
    const treasuryBefore = await balance(treasury);
    const buyerBefore = await balance(b1);
    await send(escrow, b1, 'joinDeal', id, usd(680));
    await send(escrow, sellerA, 'submitPriceLadder', id, [usd(680), usd(670), usd(660), usd(550)], [1, 2, 3, 800], 800, end, usd(100));
    await send(escrow, sellerB, 'submitOfferWithCapacity', id, 'B', usd(675), usd(100), 1, 800, end);
    await send(escrow, b2, 'joinDeal', id, usd(680));
    await send(escrow, b3, 'joinDeal', id, usd(680));
    assert.equal((await escrow.getDealState(id)).bestPrice, usd(660));
    await assert.rejects(escrow.settleDeal.staticCall(id));
    await advance(101);
    await send(escrow, outsider, 'refundDealAfterDeadline', id, 'deadline');
    assert.equal(await escrow.dealStatus(id), 2n);
    assert.equal(await balance(sellerA), sellerBefore - usd(100));
    assert.equal(await balance(treasury), treasuryBefore);
    await assert.rejects(escrow.confirmDealFulfillment.staticCall(id));
    await send(escrow, owner, 'disburseSurplusBatch', id, accounts.slice(1, 4));
    assert.equal(await balance(b1), buyerBefore - usd(660));
    await send(escrow, owner, 'confirmDealFulfillment', id);
    assert.equal(await balance(sellerA), sellerBefore + 1_960_200_000n);
    assert.equal(await balance(treasury), treasuryBefore + 19_800_000n);
    assert.equal(await escrow.dealStatus(id), 3n);
    assert.equal((await escrow.getDealState(id)).totalEscrow, 0n);
    assert.equal(await escrow.buyerDeposits(id, accounts[1]), 0n);
    await assert.rejects(escrow.confirmDealFulfillment.staticCall(id));
  });

  await t.test('delivery failure refunds buyer escrow without subtracting seller bond', async () => {
    const id = 'deal-failed';
    const end = await deadline(id);
    const before = await balance(b1);
    await send(escrow, b1, 'joinDeal', id, usd(680));
    await send(escrow, sellerA, 'submitOfferWithCapacity', id, 'A', usd(660), usd(100), 1, 800, end);
    await advance(101);
    await send(escrow, outsider, 'finalizeDealAfterDeadline', id, 'deadline');
    await send(escrow, owner, 'disburseSurplusBatch', id, [accounts[1]]);
    await send(escrow, owner, 'slashSettledDealGuarantee', id, 'delivery failed');
    assert.equal((await escrow.getDealState(id)).totalEscrow, usd(660));
    await send(escrow, owner, 'refundBatch', id, [accounts[1]]);
    assert.equal(await balance(b1), before);
    assert.equal((await escrow.getDealState(id)).totalEscrow, 0n);
    assert.equal(await escrow.dealStatus(id), 5n);
  });

  await t.test('Business backup survives expired leader; deadline is not delivery', async () => {
    const id = 'business-backup';
    const end = await deadline(id, 1);
    const before = await balance(sellerB);
    const buyerBefore = await balance(b1);
    await send(escrow, b1, 'joinBusinessPool', id, usd(1000));
    await send(escrow, sellerA, 'submitBusinessOfferWithCapacity', id, 'A', 20, usd(10), 800, end - 20);
    await send(escrow, sellerB, 'submitBusinessOfferWithCapacity', id, 'B', 10, usd(10), 800, end);
    assert.equal((await escrow.businessBackupOffers(id)).supplier, accounts[5]);
    await advance(101);
    await send(escrow, outsider, 'refundBusinessPoolAfterDeadline', id, 'deadline');
    assert.equal((await escrow.businessPools(id)).bestSupplier, accounts[5]);
    assert.equal(await balance(sellerB), before - usd(10));
    assert.ok(await escrow.businessFulfillmentDeadlines(id) > 0n);
    await assert.rejects(escrow.confirmSupplierFulfillment.staticCall(1, id));
    await send(escrow, owner, 'disburseBusinessSavings', id, [accounts[1]]);
    await send(escrow, owner, 'confirmSupplierFulfillment', 1, id);
    assert.equal(await balance(b1), buyerBefore - usd(900));
    assert.equal(await balance(sellerB), before + usd(891));
  });

  await t.test('Request backup and payout require independent fulfillment action', async () => {
    const id = 'request-backup';
    const end = await deadline(id, 2);
    const before = await balance(sellerB);
    await send(escrow, b1, 'createRequest', id, 'laptop', usd(1000), usd(1000));
    await send(escrow, sellerA, 'submitRequestOfferWithCapacity', id, 'A', usd(700), usd(10), 800, end - 20);
    await send(escrow, sellerB, 'submitRequestOfferWithCapacity', id, 'B', usd(800), usd(10), 800, end);
    assert.equal((await escrow.requestBackupOffers(id)).supplier, accounts[5]);
    await advance(101);
    await send(escrow, outsider, 'refundRequestAfterDeadline', id, 'deadline');
    assert.equal((await escrow.demandRequests(id)).bestSupplier, accounts[5]);
    assert.equal(await balance(sellerB), before - usd(10));
    await send(escrow, owner, 'disburseRequestSurplusBatch', id, [accounts[1]]);
    await send(escrow, owner, 'confirmSupplierFulfillment', 2, id);
    assert.equal(await balance(sellerB), before + usd(792));
  });

  await t.test('supplier timeout enables refunds without operator confirmation', async () => {
    const id = 'business-timeout';
    const end = await deadline(id, 1);
    const before = await balance(b1);
    await send(escrow, b1, 'joinBusinessPool', id, usd(1000));
    await send(escrow, sellerA, 'submitBusinessOfferWithCapacity', id, 'A', 10, usd(10), 800, end);
    await advance(101);
    await send(escrow, outsider, 'finalizeBusinessPoolAfterDeadline', id, 'deadline');
    await send(escrow, owner, 'disburseBusinessSavings', id, [accounts[1]]);
    await advance(7 * 86400 + 1);
    await send(escrow, outsider, 'slashBusinessSupplierAfterFulfillmentDeadline', id, 'not delivered');
    await send(escrow, owner, 'refundBusinessBatch', id, [accounts[1]]);
    assert.equal(await balance(b1), before);
  });
  assert.equal(await token.balanceOf(address), 0n, 'no funds stranded after completed/refunded markets');
});
