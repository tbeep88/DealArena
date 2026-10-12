const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { TxEnvelopeTempo } = require('ox/tempo');
const { Secp256k1 } = require('ox');
const Market = require('./market-model.js');
const { ActionJournal } = require('./action-journal.js');
const { receiptMatchesMarketAction } = require('./proof-validation.js');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const actionContext = new AsyncLocalStorage();
const requestStateContext = new AsyncLocalStorage();

// Load local testnet configuration before any wallet or contract objects are
// created. Existing process variables always win; .env is never returned to
// the browser or written to logs.
function loadLocalEnv(filePath) {
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // Read-only pages still work when no local .env is present.
  }
}

if (require.main === module) loadLocalEnv(path.join(__dirname, '.env'));
const journal = new ActionJournal(require.main === module ? path.join(__dirname, '.data', 'actions.json') : null);

const ROOT = __dirname;
const LIVE_DEMO_SNAPSHOT = require.main === module ? path.join(ROOT, '.data', 'live-demo.json') : null;
const LATEST_LIVE_PROOF_SNAPSHOT = require.main === module ? path.join(ROOT, '.data', 'latest-live-proof.json') : null;
// Keep the verified proof portable for clean deployments and submission ZIPs.
// The writable .data snapshots remain the preferred runtime cache; this bundled
// copy is read-only fallback evidence and is never used to send a transaction.
const BUNDLED_LIVE_PROOF_SNAPSHOT = path.join(ROOT, 'proofs', 'tempo-live-proof-snapshot.json');
const PUBLIC_MARKET_SNAPSHOT = require.main === module ? path.join(ROOT, '.data', 'public-market-state.json') : null;
const PRODUCT_STATE_SNAPSHOT = require.main === module ? path.join(ROOT, '.data', 'product-market-state.json') : null;
const verifiedLiveProofIds = new Set();

function isLiveDealTerminal(demoOrStatus) {
  const demo = demoOrStatus && typeof demoOrStatus === 'object' ? demoOrStatus : null;
  const status = demo ? demo.status : demoOrStatus;
  if (status === 'REFUNDED') return true;
  return status === 'COMPLETED' && (!demo || demo.fulfillmentConfirmed === true || demo.guaranteeResolved === true);
}

function isLiveProofDisplayable(snapshot) {
  return Boolean(snapshot && snapshot.settlementSummary
    && ['SETTLED', 'AWAITING_FULFILLMENT', 'COMPLETED', 'REFUNDED'].includes(snapshot.status));
}

function normalizeLiveProofSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const phaseByStatus = {
    SETTLED: 'SETTLED',
    AWAITING_FULFILLMENT: 'AWAITING_FULFILLMENT',
    COMPLETED: 'COMPLETED',
    REFUNDED: 'REFUNDED',
  };
  return {
    ...snapshot,
    phase: phaseByStatus[snapshot.status] || snapshot.phase,
    receipts: normalizeReceiptExplorerUrls(snapshot.receipts),
  };
}

// Older snapshots stored mainnet /tx links. A receipt hash is the source of
// truth, so always rebuild the public link for the Tempo Moderato explorer.
function normalizeReceiptExplorerUrls(receipts) {
  return Array.isArray(receipts)
    ? receipts.map((receipt) => receipt?.hash
      ? { ...receipt, explorerUrl: `${TEMPO_EXPLORER}/receipt/${receipt.hash}` }
      : receipt)
    : receipts;
}

function liveDealNeedsRecovery(demo) {
  if (!demo || isLiveDealTerminal(demo)) return false;
  return Number(demo.buyersCount || 0) > 0 || Boolean(demo.lastHash && demo.currentStep);
}

function liveDemoUsesCurrentContract(demo) {
  // A matching address is not enough: redeployments can keep the same
  // configured address while the proof was produced by an older contract.
  // Never present an old receipt as proof for the current hardened flow.
  if (Number(demo?.contractVersion || 0) !== LIVE_SECURITY_VERSION) return false;
  const contracts = [
    demo?.contract,
    ...(Array.isArray(demo?.receipts) ? demo.receipts.map((receipt) => receipt?.contract) : []),
  ].filter(Boolean).map((address) => String(address).toLowerCase());
  return contracts.length === 0 || contracts.every((address) => address === String(CONTRACT_ADDRESS).toLowerCase());
}

function loadLiveDemoSnapshot() {
  if (LIVE_DEMO_SNAPSHOT && fs.existsSync(LIVE_DEMO_SNAPSHOT)) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(LIVE_DEMO_SNAPSHOT, 'utf8'));
      if (snapshot && snapshot.liveDealId && !isLiveDealTerminal(snapshot) && liveDemoUsesCurrentContract(snapshot)) return snapshot;
    } catch {
      // Fall through to the durable action journal recovery below.
    }
  }
  const liveRecords = Object.values(journal.records)
    .filter((record) => record.payload?.liveProof === true || record.payload?.action === 'runPresetLiveMiniDeal' || record.result?.demo?.liveDealId || record.result?.liveDemo?.liveDealId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const record = liveRecords[0];
  const recordedDemo = record?.result?.demo || record?.result?.liveDemo || null;
  if (recordedDemo && !liveDemoUsesCurrentContract(recordedDemo)) return null;
  const recordedContracts = [
    ...(Array.isArray(record?.result?.receipts) ? record.result.receipts.map((receipt) => receipt?.contract) : []),
    record?.result?.receipt?.contract,
  ].filter(Boolean).map((address) => String(address).toLowerCase());
  if (recordedContracts.some((address) => address !== String(CONTRACT_ADDRESS).toLowerCase())) return null;
  if (record?.payload?.liveProof === true && !recordedDemo && recordedContracts.length === 0) return null;
  const simulationDealId = record?.payload?.payload?.simulationDealId || recordedDemo?.simulationDealId;
  if (!record || !simulationDealId) return null;
  const liveDealId = recordedDemo?.liveDealId || liveDealIdFor(simulationDealId);
  const closed = Object.values(journal.records).some((entry) => {
    const action = entry.payload?.action;
    const payload = entry.payload?.payload || {};
    const eventClosed = [...(entry.result?.receipts || []), entry.result?.receipt].filter(Boolean)
      .some((proof) => proof.events?.some((event) => ['DealPriceLocked', 'DealRefunded'].includes(event.name) && String(event.args?.[0]) === liveDealId));
    return (entry.result?.status === 'CONFIRMED' && ['settleDeal', 'refundDeal'].includes(action) && payload.dealId === liveDealId) || eventClosed;
  });
  if (closed) return null;
  if (recordedDemo) {
    const receipts = Array.isArray(recordedDemo.receipts)
      ? recordedDemo.receipts
      : Array.isArray(record.result?.receipts) ? record.result.receipts : [];
    const recoveredSteps = freshLiveStepStates().map((step, index) => receipts[index]
      ? { ...step, status: LIVE_DEMO_STEP_DONE[index], hash: receipts[index].hash || null }
      : step);
    return {
      ...recordedDemo,
      receipts,
      phase: recordedDemo.status === 'READY_TO_SETTLE' ? 'READY_TO_SETTLE' : recordedDemo.phase || 'IN_PROGRESS',
      stepStates: Array.isArray(recordedDemo.stepStates) && recordedDemo.stepStates.some((step) => step.status !== 'PENDING')
        ? recordedDemo.stepStates
        : recoveredSteps,
      currentStep: recordedDemo.currentStep || null,
    };
  }
  const receipts = Array.isArray(record.result?.receipts) ? record.result.receipts : [];
  const stepStates = freshLiveStepStates().map((step, index) => receipts[index]
    ? { ...step, status: LIVE_DEMO_STEP_DONE[index], hash: receipts[index].hash || null }
    : step);
  const nextIndex = receipts.length;
  const nextStep = nextIndex < LIVE_DEMO_STEP_KEYS.length ? liveDemoSteps(simulationDealId)[nextIndex] : null;
  const hash = record.hash || receipts.at(-1)?.hash || null;
  const status = receipts.length >= LIVE_DEMO_STEP_KEYS.length
    ? 'READY_TO_SETTLE'
    : hash ? 'PENDING' : record.status === 'FAILED' ? 'PARTIAL_FAILED' : 'IN_PROGRESS';
  return {
    status,
    phase: status === 'READY_TO_SETTLE' ? 'READY_TO_SETTLE' : LIVE_DEMO_STEP_KEYS[nextIndex] ? `${LIVE_DEMO_STEP_KEYS[nextIndex]}_PENDING` : status,
    simulationDealId,
    liveDealId,
    buyersCount: liveDemoBuyerCount(receipts),
    buyerAddress: demoBuyerWallet.address,
    sellerAddresses: { A: sellerWallets.A.address, B: sellerWallets.B.address, C: sellerWallets.C.address },
    winningSeller: sellerWallets.A.address,
    bestPriceCents: 66000,
    minimumBuyerCount: LIVE_DEMO_BUYER_COUNT,
    transactionCount: receipts.length,
    receipts,
    stepStates,
    currentStep: hash && nextStep ? { index: nextIndex, key: LIVE_DEMO_STEP_KEYS[nextIndex], type: nextStep.type, details: nextStep.details, meta: nextStep.meta } : null,
    lastHash: hash,
    lastError: record.result?.error || null,
  };
}

function loadLatestLiveProof(requireVerified = true) {
  const candidates = [LATEST_LIVE_PROOF_SNAPSHOT, LIVE_DEMO_SNAPSHOT, BUNDLED_LIVE_PROOF_SNAPSHOT].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (snapshot && isLiveProofDisplayable(snapshot)
        && (!requireVerified || (snapshot.chainVerified === true && verifiedLiveProofIds.has(snapshot.liveDealId)))
        && liveDemoUsesCurrentContract(snapshot)) return normalizeLiveProofSnapshot(snapshot);
    } catch {
      // A damaged proof snapshot must never block the site from loading.
    }
  }
  return null;
}

// Keep a verified receipt history visible even when the configured deployment
// is older than the current LIVE contract gate. This is read-only evidence of
// a real Tempo run, not permission to start a new payment on the old contract.
function loadHistoricalLiveProof() {
  const candidates = [LATEST_LIVE_PROOF_SNAPSHOT, LIVE_DEMO_SNAPSHOT, BUNDLED_LIVE_PROOF_SNAPSHOT].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
      const contracts = [
        snapshot?.contract,
        ...(Array.isArray(snapshot?.receipts) ? snapshot.receipts.map((receipt) => receipt?.contract) : []),
      ].filter(Boolean).map((address) => String(address).toLowerCase());
      const sameContract = contracts.length > 0 && contracts.every((address) => address === String(CONTRACT_ADDRESS).toLowerCase());
      if (snapshot && isLiveProofDisplayable(snapshot) && snapshot.chainVerified === true && sameContract && verifiedLiveProofIds.has(snapshot.liveDealId)) {
        return {
          ...normalizeLiveProofSnapshot(snapshot),
          historical: true,
          deploymentVersion: Number(deployedConfig.contractVersion) || null,
          proofSource: 'HISTORICAL_CONFIRMED_RECEIPTS',
        };
      }
    } catch {
      // A damaged history file must not block the site.
    }
  }
  return null;
}

// A JSON snapshot is useful for restart recovery, but it is not proof by
// itself. On startup, re-check every recorded transaction against the current
// contract so a stale, copied, or partial snapshot never becomes the visible
// receipt. The check is intentionally read-only and runs only in the server
// process; tests and imported helpers do not make an RPC call on load.
async function verifyLatestLiveProofSnapshot() {
  if (!require.main) return null;
  // Read the raw durable proof here so an older snapshot can be re-verified
  // after restart. It must not be shown to the UI until this check succeeds.
  const snapshot = loadLatestLiveProof(false);
  if (!snapshot) return null;
  const snapshotReceipts = Array.isArray(snapshot.receipts) ? snapshot.receipts.filter((receipt) => receipt?.hash) : [];
  const hashes = [...new Set([
    ...snapshotReceipts.map((receipt) => receipt?.hash),
    snapshot.settlementHash,
    snapshot.fulfillmentHash,
    snapshot.refundHash,
  ].filter((hash) => typeof hash === 'string' && /^0x[\da-f]{64}$/i.test(hash)))];
  if (!hashes.length) return null;
  try {
    const chainReceipts = [];
    for (const hash of hashes) chainReceipts.push(await provider.send('eth_getTransactionReceipt', [hash]));
    const rawByHash = new Map(chainReceipts.map((receipt) => [String(receipt?.transactionHash || '').toLowerCase(), receipt]));
    const receiptsMatch = snapshotReceipts.every((expected) => {
      const raw = rawByHash.get(String(expected.hash).toLowerCase());
      if (!raw) return false;
      const proof = receiptProof(raw, expected.type || 'LIVE_PROOF');
      if (!receiptMatchesMarketAction(proof, expected, snapshot)) return false;
      const actorAddress = expected.actorAddress || expected.from;
      if (actorAddress && String(raw.from || '').toLowerCase() !== String(actorAddress).toLowerCase()) return false;
      return true;
    });
    const valid = receiptsMatch && chainReceipts.every((receipt) => {
      if (!receipt || Number.parseInt(String(receipt.status || '0x0'), 16) !== 1) return false;
      const hash = String(receipt.transactionHash || '').toLowerCase();
      return hash && rawByHash.get(hash) === receipt && String(receipt.to || '').toLowerCase() === String(CONTRACT_ADDRESS).toLowerCase();
    });
    if (!valid) return null;
    const verified = {
      ...snapshot,
      chainVerified: true,
      chainVerifiedAt: new Date().toISOString(),
      chainVerifiedReceiptCount: hashes.length,
      proofSource: 'DURABLE_SNAPSHOT_AND_CHAIN',
    };
    globalState.latestLiveProof = verified;
    persistLatestLiveProof(verified);
    return verified;
  } catch {
    // Keep the snapshot durable but hidden until a later read-only check can
    // verify it. A transient RPC failure must not invent a proof.
    return null;
  }
}

function persistLiveDemo(snapshot) {
  if (requestStateContext.getStore()?.public) return;
  if (!LIVE_DEMO_SNAPSHOT) return;
  fs.mkdirSync(path.dirname(LIVE_DEMO_SNAPSHOT), { recursive: true });
  const pending = `${LIVE_DEMO_SNAPSHOT}.tmp`;
  fs.writeFileSync(pending, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(pending, LIVE_DEMO_SNAPSHOT);
}

function persistLatestLiveProof(snapshot) {
  if (requestStateContext.getStore()?.public) return;
  if (!LATEST_LIVE_PROOF_SNAPSHOT || !isLiveProofDisplayable(snapshot)) return;
  if (snapshot.chainVerified === true) verifiedLiveProofIds.add(snapshot.liveDealId);
  fs.mkdirSync(path.dirname(LATEST_LIVE_PROOF_SNAPSHOT), { recursive: true });
  const pending = `${LATEST_LIVE_PROOF_SNAPSHOT}.tmp`;
  fs.writeFileSync(pending, JSON.stringify(snapshot), { mode: 0o600 });
  fs.renameSync(pending, LATEST_LIVE_PROOF_SNAPSHOT);
}

let globalState;
const state = new Proxy({}, {
  get(_target, property) {
    const target = requestStateContext.getStore()?.state || globalState;
    return target?.[property];
  },
  set(_target, property, value) {
    const target = requestStateContext.getStore()?.state || globalState;
    if (target) target[property] = value;
    return true;
  },
  has(_target, property) {
    const target = requestStateContext.getStore()?.state || globalState;
    return Boolean(target && property in target);
  },
  ownKeys() {
    const target = requestStateContext.getStore()?.state || globalState || {};
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(_target, property) {
    const target = requestStateContext.getStore()?.state || globalState;
    if (!target || !(property in target)) return undefined;
    return { value: target[property], enumerable: true, configurable: true, writable: true };
  },
});

let sharedPublicMarket = null;
function loadPublicMarketSnapshot() {
  if (!PUBLIC_MARKET_SNAPSHOT) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(PUBLIC_MARKET_SNAPSHOT, 'utf8'));
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.activeIds || !snapshot.deal || !Array.isArray(snapshot.requests)) return null;
    return snapshot;
  } catch {
    return null;
  }
}
function persistPublicMarketSnapshot(session = sharedPublicMarket) {
  if (!PUBLIC_MARKET_SNAPSHOT || !session?.public || !session.state) return;
  fs.mkdirSync(path.dirname(PUBLIC_MARKET_SNAPSHOT), { recursive: true });
  const pending = `${PUBLIC_MARKET_SNAPSHOT}.tmp`;
  fs.writeFileSync(pending, JSON.stringify(session.state), { mode: 0o600 });
  fs.renameSync(pending, PUBLIC_MARKET_SNAPSHOT);
}
function loadProductStateSnapshot() {
  if (!PRODUCT_STATE_SNAPSHOT) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(PRODUCT_STATE_SNAPSHOT, 'utf8'));
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.activeIds || !snapshot.deal || !Array.isArray(snapshot.requests)) return null;
    return snapshot;
  } catch {
    return null;
  }
}
function persistProductStateSnapshot() {
  if (!PRODUCT_STATE_SNAPSHOT || !globalState) return;
  fs.mkdirSync(path.dirname(PRODUCT_STATE_SNAPSHOT), { recursive: true });
  const pending = `${PRODUCT_STATE_SNAPSHOT}.tmp`;
  fs.writeFileSync(pending, JSON.stringify(globalState), { mode: 0o600 });
  fs.renameSync(pending, PRODUCT_STATE_SNAPSHOT);
}
function sharedPublicMarketState() {
  if (sharedPublicMarket) return sharedPublicMarket;
  const saved = loadPublicMarketSnapshot();
  const savedMatchesOpenMarket = saved?.deal
    && saved.deal.status === DEFAULT_DEAL_STEP.status
    && Number(saved.deal.buyers) === Number(DEFAULT_DEAL_STEP.buyers)
    && saved.deal.best === DEFAULT_DEAL_STEP.best
    && Number(saved.deal.accounting?.committedCents) === Number(DEFAULT_DEAL_STEP.accounting?.committedCents);
  sharedPublicMarket = {
    id: 'public-shared-market',
    public: true,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    state: savedMatchesOpenMarket ? saved : freshPublicState(),
    currentRun: null,
  };
  return sharedPublicMarket;
}
function cookieValue(req, name) {
  const cookieHeader = String(req.headers.cookie || '');
  const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function freshPublicState() {
  const next = getDefaultState();
  next.liveDemo = null;
  next.latestLiveProof = loadLatestLiveProof();
  next.liveProofUsed = false;
  next.generation = randomUUID();
  // The public reset must match the open market shown above.  The completed
  // 500-buyer step is only a scenario result, never the initial accounting.
  next.deal.cohorts = DEFAULT_DEAL_STEP.cohorts;
  next.deal.accounting = DEFAULT_DEAL_STEP.accounting;
  return next;
}

function getPublicSession(req, res) {
  // Every public visitor sees one marketplace. Cookies can still support UI
  // preferences, but they never select a different deal/request registry.
  if (localRequest(req)) return null;
  const session = sharedPublicMarketState();
  session.lastSeenAt = Date.now();
  return session;
}

function replaceActiveState(next) {
  const session = requestStateContext.getStore();
  if (session) session.state = next;
  else globalState = next;
}

function activeCurrentRun() {
  const session = requestStateContext.getStore();
  return session ? session.currentRun : globalCurrentRun;
}

function replaceCurrentRun(next) {
  const session = requestStateContext.getStore();
  if (session) session.currentRun = next;
  else globalCurrentRun = next;
}

function scopedActionId(id) {
  const sessionId = requestStateContext.getStore()?.id;
  return sessionId ? `public:${sessionId}:${id}` : id;
}

// Load environment variables from .env if present
const envFile = path.join(ROOT, '.env');
if (require.main === module && fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

const PORT = Number(process.env.PORT) || 4184;
const HOST = process.env.HOST || '127.0.0.1';

// Single source of truth for Business Pool monthly café commitment ($2,048/month)
const CAFE_MONTHLY_COMMITMENT_USD = 2048;
const CAFE_MONTHLY_COMMITMENT_CENTS = 204800n;
const REQUEST_AUTH_DEPOSIT_USD = 10;
const REQUEST_AUTH_DEPOSIT_CENTS = 1000n;
const PATH_USD_DECIMALS = 6;
const PATH_USD_UNITS_PER_CENT = 10n ** BigInt(PATH_USD_DECIMALS - 2);
const LIVE_NATIVE_BATCH_MAX = 10;
const LIVE_NATIVE_BATCH_MIN = 2;
// The escrow contract accepts at most 200 recipients per payout/refund call.
// A single Tempo Type 0x76 batch can carry several such calls atomically.
const LIVE_RECIPIENT_BATCH_MAX = 200;
// Keep a generous testnet reserve so a jury can replay the LIVE proof many
// times without the preset buyer wallets becoming the bottleneck.
const LIVE_DEMO_PREPARED_RUNS = 25;
const LIVE_DEMO_READINESS_RUNS = 1;
const LIVE_DEMO_BUYER_DEPOSIT_CENTS = 68000;
const LIVE_DEMO_BUYER_COUNT = 3;
const LIVE_DEMO_SELLER_BOND_CENTS = 1000;
const LIVE_SECURITY_VERSION = 17;
const PRICE_LADDER_VERSION = 17;

function centsToPathUsdUnits(cents) {
  return BigInt(Market.integer(cents, 'amount', true)) * PATH_USD_UNITS_PER_CENT;
}

function pathUsdUnitsToUsd(value, fractionDigits = 2) {
  const amount = BigInt(value);
  const divisor = 10n ** BigInt(PATH_USD_DECIMALS);
  const scale = 10n ** BigInt(fractionDigits);
  const rounded = (amount * scale + divisor / 2n) / divisor;
  const whole = (rounded / scale).toLocaleString('en-US');
  if (!fractionDigits) return whole;
  return whole + '.' + String(rounded % scale).padStart(fractionDigits, '0');
}

// --------------------------------------------------------------------------
// Tempo Moderato Testnet Configuration & Deployed Contract
// --------------------------------------------------------------------------
const deployedConfigPath = path.join(ROOT, 'contracts', 'deployed.json');
let deployedConfig = {};
try {
  deployedConfig = JSON.parse(fs.readFileSync(deployedConfigPath, 'utf8'));
} catch (err) {
  console.error('Warning: deployed.json not found, using defaults:', err.message);
  deployedConfig = {
    contractAddress: '0x9867224F7c3AB4CE3Ad4DE704bf8469ede32c66a',
    deployer: '0x212cf9d84795A9Ec6a7DC09256Eb5E8F949Bd40A',
    network: 'Tempo Testnet (Moderato)',
    chainId: 42431,
    rpc: 'https://rpc.moderato.tempo.xyz',
    explorer: 'https://explore.testnet.tempo.xyz',
    pathUsdAddress: '0x20c0000000000000000000000000000000000000',
  };
}

// LIVE readiness must describe the exact source that produced the current
// deployment. Version/token/owner checks alone cannot catch a same-version
// redeploy that still contains an older closing module.
const compiledArtifactPath = path.join(ROOT, 'contracts', 'compiled-v17.json');
let compiledArtifactSourceHash = null;
try {
  const compiledArtifact = JSON.parse(fs.readFileSync(compiledArtifactPath, 'utf8'));
  compiledArtifactSourceHash = String(compiledArtifact.sourceHash || '').trim() || null;
} catch (err) {
  console.error('Warning: compiled-v17.json not found or unreadable:', err.message);
}
const deployedSourceHash = String(deployedConfig.sourceHash || '').trim() || null;
const deploymentSourceHashMatch = Boolean(compiledArtifactSourceHash && deployedSourceHash
  && compiledArtifactSourceHash === deployedSourceHash);

const TEMPO_RPC = process.env.TEMPO_RPC_URL || deployedConfig.rpc || 'https://rpc.moderato.tempo.xyz';
const TEMPO_CHAIN_ID = Number(process.env.TEMPO_CHAIN_ID) || deployedConfig.chainId || 42431;
const TEMPO_EXPLORER = deployedConfig.explorer || 'https://explore.testnet.tempo.xyz';
let CONTRACT_ADDRESS = process.env.TEMPO_CONTRACT_ADDRESS || deployedConfig.contractAddress || '0x9867224F7c3AB4CE3Ad4DE704bf8469ede32c66a';
const PATH_USD_ADDRESS = deployedConfig.pathUsdAddress || '0x20c0000000000000000000000000000000000000';
// Public LIVE writes require two explicit opt-ins, including presenter mode.
const PUBLIC_DEMO_ENABLED = process.env.TEMPO_PUBLIC_DEMO === 'true' && process.env.TEMPO_PRESENTER_MODE === 'true';
// A public presenter action must carry a separate secret. Socket locality is
// not authorization: reverse proxies can make an internet request look local.
const PRESENTER_TOKEN = String(process.env.TEMPO_PRESENTER_TOKEN || '').trim();
// Explicit jury opt-in: only the fixed three-wallet testnet order and its
// current Deal close actions are public. Arbitrary operator actions still
// require the private presenter capability.
const JURY_DEMO_PUBLIC = PUBLIC_DEMO_ENABLED && TEMPO_CHAIN_ID === 42431
  && process.env.TEMPO_JURY_DEMO_PUBLIC === 'true';
const juryDailyRuns = new Map();
const PUBLIC_WRITE_RATE_LIMIT_MS = Math.max(2000, Number(process.env.TEMPO_PUBLIC_WRITE_RATE_LIMIT_MS) || 5000);
const publicWriteWindows = new Map();

// Standard TIP-20 interface for PathUSD
const TIP20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function transfer(address recipient, uint256 amount) external returns (bool)',
  'function transferWithMemo(address recipient, uint256 amount, bytes32 memo) external returns (bool)',
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
];

// Complete ABI for DealArenaEscrow (supports all 3 verticals + native Tempo batching)
const FULL_ESCROW_ABI = [
  'function CONTRACT_VERSION() view returns (uint256)',
  'function paymentToken() view returns (address)',
  'function owner() view returns (address)',
  'function authorizedSellers(address) view returns (bool)',
  'function sellerRevoked(address) view returns (bool)',
  'event DealJoined(string indexed dealId, address indexed buyer, uint256 depositAmount, uint256 totalBuyerDeposit, uint256 buyersCount, uint256 timestamp)',
  'event OfferSubmitted(string indexed dealId, address indexed seller, string sellerName, uint256 price, uint256 guaranteeBond, uint256 minimumBuyerCount, uint256 timestamp)',
  'event OfferCapacityUpdated(string indexed dealId, address indexed seller, uint256 maxBuyerUnits, uint256 offerExpiry, uint256 timestamp)',
  'event OfferExpired(string indexed dealId, address indexed seller, uint256 timestamp)',
  'event OfferDeactivated(string indexed dealId, address indexed seller, string reason, uint256 timestamp)',
  'event PriceLadderSubmitted(string indexed dealId, address indexed seller, uint256 guaranteeBond, uint256 tierCount, uint256 timestamp)',
  'event PriceTierActivated(string indexed dealId, address indexed seller, uint256 price, uint256 minimumBuyerCount, uint256 timestamp)',
  'event FulfillmentPaymentReleased(string indexed dealId, address indexed seller, uint256 sellerPayout, uint256 platformFee, uint256 timestamp)',
  'event DealBuyerAccountingCleared(string indexed dealId, uint256 buyerCount, uint256 timestamp)',
  'event FinalBiddingWindowOpened(string indexed dealId, uint256 endsAt, uint256 targetBuyerCount, uint256 timestamp)',
  'event DealStatusChanged(string indexed dealId, uint8 status, uint256 timestamp)',
  'event RefundInitiated(string indexed marketId, string reason, uint256 totalEscrow, uint256 timestamp)',
  'event DealPriceLocked(string indexed dealId, address indexed winningSeller, uint256 finalPrice, uint256 grossVolume, uint256 platformFee, uint256 timestamp)',
  'event DealRefunded(string indexed dealId, string reason, uint256 totalRefunded, uint256 timestamp)',
  'event BuyerRefunded(string indexed dealId, address indexed recipient, uint256 amount, uint256 timestamp)',
  'event GuaranteeSlashed(string indexed dealId, address indexed seller, uint256 slashedAmount, string reason, uint256 timestamp)',
  'event BusinessPoolJoined(string indexed poolId, address indexed businessUser, uint256 commitmentAmount, uint256 timestamp)',
  'event BusinessOfferSubmitted(string indexed poolId, address indexed supplier, string supplierName, uint256 discountPercent, uint256 guaranteeBond, uint256 timestamp)',
  'event BusinessPoolSettled(string indexed poolId, address indexed winningSupplier, uint256 netPayout, uint256 platformFee, uint256 timestamp)',
  'event BusinessPoolRefunded(string indexed poolId, string reason, uint256 totalRefunded, uint256 timestamp)',
  'event SupplierGuaranteeSlashed(string indexed marketId, uint8 marketType, address indexed supplier, uint256 slashedAmount, string reason, uint256 timestamp)',
  'event RequestCreated(string indexed requestId, address indexed creator, string title, uint256 maxPrice, uint256 authAmount, uint256 timestamp)',
  'event RequestJoined(string indexed requestId, address indexed buyer, uint256 authAmount, uint256 buyersCount, uint256 timestamp)',
  'event RequestFunded(string indexed requestId, address indexed buyer, uint256 amount, uint256 totalBuyerDeposit, uint256 timestamp)',
  'event RequestOfferSubmitted(string indexed requestId, address indexed supplier, string supplierName, uint256 price, uint256 guaranteeBond, uint256 timestamp)',
  'event RequestSettled(string indexed requestId, address indexed winningSupplier, uint256 finalPrice, uint256 timestamp)',
  'event RequestRefunded(string indexed requestId, string reason, uint256 totalRefunded, uint256 timestamp)',
  'event PaymentReference(bytes32 indexed memo, string marketId, string phase, address indexed recipient, uint256 amount)',
  'function joinDeal(string dealId, uint256 depositAmount) external returns (bool)',
  'function joinDealUnits(string dealId, uint256 depositAmount, uint256 units) external returns (bool)',
  'function topUpDeal(string dealId, uint256 amount) external returns (bool)',
  'function submitOfferWithCapacity(string dealId, string sellerName, uint256 price, uint256 guaranteeBond, uint256 minimumBuyerCount, uint256 maxBuyerUnits, uint256 offerExpiry) external returns (bool)',
  'function submitPriceLadder(string dealId, uint256[] prices, uint256[] minimumBuyerCounts, uint256 maxBuyerUnits, uint256 offerExpiry, uint256 guaranteeBond) external returns (bool)',
  'function setMarketDeadline(string marketId, uint256 deadline) external',
  'function setMarketDeadlineForMarket(uint8 marketType, string marketId, uint256 deadline) external',
  'function settleDeal(string dealId) external returns (bool)',
  'function finalizeDealAfterDeadline(string dealId, string reason) external returns (bool)',
  'function settleDealAfterDeadline(string dealId) external returns (bool)',
  'function removeUnfundedDealBuyers(string dealId, address[] recipients) external returns (bool)',
  'function removeUnfundedDealBuyersAfterDeadline(string dealId, address[] recipients) external returns (bool)',
  'function removeUnfundedRequestBuyersAfterDeadline(string requestId, address[] recipients) external returns (bool)',
  'function sweepBusinessSavingsDust(string poolId) external returns (bool)',
  'function sweepRequestSurplusDust(string requestId) external returns (bool)',
  'function confirmDealFulfillment(string dealId) external returns (bool)',
  'function slashSettledDealGuarantee(string dealId, string reason) external returns (bool)',
  'function refundDealAfterFulfillmentDeadline(string dealId, string reason) external returns (bool)',
  'function refundDealAfterDeadline(string dealId, string reason) external returns (bool)',
  'function disburseSurplusBatch(string dealId, address[] recipients) external returns (bool)',
  'function refundDeal(string dealId, string reason) external returns (bool)',
  'function refundBatch(string dealId, address[] recipients) external returns (bool)',
  'function slashSellerGuarantee(string dealId, string reason) external returns (bool)',
  'function getDealFundingState(string dealId) view returns (uint256 joinedBuyers, uint256 fundedBuyers, uint256 joinedUnits, uint256 fundedUnits, uint256 totalEscrow, uint256 currentPrice)',
  'function joinBusinessPool(string poolId, uint256 commitmentAmount) external returns (bool)',
  'function submitBusinessOffer(string poolId, string supplierName, uint256 discountPercent, uint256 guaranteeBond) external returns (bool)',
  'function submitBusinessOfferWithCapacity(string poolId, string supplierName, uint256 discountPercent, uint256 guaranteeBond, uint256 maxBuyerCount, uint256 offerExpiry) external returns (bool)',
  'function settleBusinessPool(string poolId) external returns (bool)',
  'function finalizeBusinessPoolAfterDeadline(string poolId, string reason) external returns (bool)',
  'function confirmSupplierFulfillment(uint8 marketType, string marketId) external returns (bool)',
  'function slashBusinessSupplierAfterFulfillmentDeadline(string poolId, string reason) external returns (bool)',
  'function slashRequestSupplierAfterFulfillmentDeadline(string requestId, string reason) external returns (bool)',
  'function slashSettledSupplierGuarantee(uint8 marketType, string marketId, string reason) external returns (bool)',
  'function refundBusinessPool(string poolId, string reason) external returns (bool)',
  'function refundBusinessPoolAfterDeadline(string poolId, string reason) external returns (bool)',
  'function refundBusinessBatch(string poolId, address[] recipients) external returns (bool)',
  'function disburseBusinessSavings(string poolId, address[] recipients) external returns (bool)',
  'function createRequest(string requestId, string title, uint256 maxPrice, uint256 authAmount) external returns (bool)',
  'function joinRequest(string requestId, uint256 authAmount) external returns (bool)',
  'function fundRequest(string requestId, uint256 amount) external returns (bool)',
  'function submitRequestOffer(string requestId, string supplierName, uint256 price, uint256 guaranteeBond) external returns (bool)',
  'function submitRequestOfferWithCapacity(string requestId, string supplierName, uint256 price, uint256 guaranteeBond, uint256 maxBuyerCount, uint256 offerExpiry) external returns (bool)',
  'function settleRequest(string requestId) external returns (bool)',
  'function finalizeRequestAfterDeadline(string requestId, string reason) external returns (bool)',
  'function refundRequest(string requestId, string reason) external returns (bool)',
  'function refundRequestAfterDeadline(string requestId, string reason) external returns (bool)',
  'function refundRequestBatch(string requestId, address[] recipients) external returns (bool)',
  'function disburseRequestSurplusBatch(string requestId, address[] recipients) external returns (bool)',
  'function getDealBuyers(string dealId) external view returns (address[])',
  'function getRequestBuyers(string requestId) external view returns (address[])',
  'function getBusinessBuyers(string poolId) external view returns (address[])',
  'function buyerDeposits(string dealId, address buyer) external view returns (uint256)',
  'function buyerUnits(string dealId, address buyer) external view returns (uint256)',
  'function requestDeposits(string requestId, address buyer) external view returns (uint256)',
  'function getDealState(string dealId) external view returns (uint256 buyersCount, uint256 bestPrice, address bestSeller, uint256 totalEscrow, uint256 sellerGuaranteeBond, bool isSettled, bool isRefunded)',
  'function getDealSettlementState(string dealId) external view returns (uint256 sellerPayout, uint256 platformFee, uint256 settledGrossVolume, uint256 settlementTargetBuyerCount)',
  'function getDealTimingState(string dealId) external view returns (uint256 finalBiddingEndsAt, uint256 marketDeadline, uint256 fulfillmentDeadline)',
  'function refundDealAfterFulfillmentDeadline(string dealId, string reason) external returns (bool)',
  'function getDealOffer(string dealId, address seller) external view returns (uint256 price, uint256 guaranteeBond, uint256 maxBuyerUnits, uint256 offerExpiry, uint256 minimumBuyerCount, bool active)',
  'function businessPools(string poolId) external view returns (uint256 buyersCount, uint256 totalDemand, uint256 bestDiscountPercent, address bestSupplier, uint256 supplierGuaranteeBond, bool isSettled, bool isRefunded)',
  'function demandRequests(string requestId) external view returns (uint256 maxPrice, uint256 bestPrice, address bestSupplier, uint256 buyersCount, uint256 totalEscrow, uint256 supplierGuaranteeBond, bool isSettled, bool isRefunded)',
  'function CONTRACT_VERSION() external view returns (uint256)',
  'function paymentToken() external view returns (address)',
  'function owner() external view returns (address)',
  'function treasury() external view returns (address)',
  'function authorizedSellers(address) external view returns (bool)',
  'function marketDeadlines(string marketId) external view returns (uint256)',
  'function businessDeadlines(string marketId) external view returns (uint256)',
  'function requestDeadlines(string marketId) external view returns (uint256)',
  'function businessFulfillmentDeadlines(string marketId) external view returns (uint256)',
  'function requestFulfillmentDeadlines(string marketId) external view returns (uint256)',
  'function businessSupplierOfferExpiry(string marketId) external view returns (uint256)',
  'function businessBackupOffers(string marketId) external view returns (address supplier, uint256 value, uint256 guaranteeBond, uint256 maxBuyers, uint256 offerExpiry)',
  'function businessSupplierMaxBuyers(string marketId) external view returns (uint256)',
  'function requestSupplierOfferExpiry(string marketId) external view returns (uint256)',
  'function requestBackupOffers(string marketId) external view returns (address supplier, uint256 value, uint256 guaranteeBond, uint256 maxBuyers, uint256 offerExpiry)',
  'function requestSupplierMaxBuyers(string marketId) external view returns (uint256)',
  'function refundTotals(string marketId) external view returns (uint256)',
  'function businessRefundTotals(string marketId) external view returns (uint256)',
  'function requestRefundTotals(string marketId) external view returns (uint256)',
];

// Use a fresh RPC session for every server start. Tempo's public RPC is backed
// by multiple nodes; a long-lived provider can otherwise stay on the deployment
// block and make a healthy contract look absent after a redeploy.
const providerRpcUrl = `${TEMPO_RPC}${TEMPO_RPC.includes('?') ? '&' : '?'}dealarena_session=${Date.now()}`;

function createTempoProvider(url) {
  // Tempo's public endpoint can briefly answer with HTTP 429 while a receipt
  // or a burst of read calls is being processed. Keep the retry policy on the
  // provider itself so a transient RPC throttle never turns a valid LIVE
  // action into a misleading PENDING failure.
  const request = new ethers.FetchRequest(url);
  request.setThrottleParams({ slotInterval: 1000, maxAttempts: 60 });
  request.retryFunc = async (_request, response) => {
    const message = String(response?.bodyJson?.error?.message || '');
    const retryAfterMs = Number(message.match(/try again in (\d+)ms/i)?.[1] || 1000);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, retryAfterMs + 250)));
    return true;
  };
  return new ethers.JsonRpcProvider(
    request,
    { name: 'tempo-moderato', chainId: TEMPO_CHAIN_ID },
    { staticNetwork: true, batchMaxCount: 1 }
  );
}

// Static network initialization to prevent Ethers v6 startup detectNetwork hangs
const provider = createTempoProvider(providerRpcUrl);

// Server-side dedicated settlement wallet (strictly from environment)
let activePrivateKey = process.env.TEMPO_PRIVATE_KEY || null;
let activeWallet = activePrivateKey ? new ethers.Wallet(activePrivateKey, provider) : null;
let escrowContract = activeWallet ? new ethers.Contract(CONTRACT_ADDRESS, FULL_ESCROW_ABI, activeWallet) : null;
let tokenContract = (PATH_USD_ADDRESS && activeWallet) ? new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, activeWallet) : null;

// Preset testnet wallets for the one-click live mini-deal. These are deliberately
// separate from the owner wallet so the receipt proves buyer -> seller -> owner
// roles on-chain. There is deliberately no public fallback mnemonic.
const DEMO_MNEMONIC = String(process.env.TEMPO_DEMO_MNEMONIC || '').trim() || null;
const DEMO_ROLE_KEYS = [
  'TEMPO_DEMO_BUYER_PRIVATE_KEY',
  'TEMPO_DEMO_BUYER_2_PRIVATE_KEY',
  'TEMPO_DEMO_BUYER_3_PRIVATE_KEY',
  'TEMPO_DEMO_SELLER_A_PRIVATE_KEY',
  'TEMPO_DEMO_SELLER_B_PRIVATE_KEY',
  'TEMPO_DEMO_SELLER_C_PRIVATE_KEY',
  'TEMPO_DEMO_SUPPLIER_A_PRIVATE_KEY',
  'TEMPO_DEMO_SUPPLIER_B_PRIVATE_KEY',
  'TEMPO_DEMO_SUPPLIER_C_PRIVATE_KEY',
];
const DEMO_KEYS_CONFIGURED = Boolean(DEMO_MNEMONIC || DEMO_ROLE_KEYS.every((key) => String(process.env[key] || '').trim()));
function deriveRoleWallet(index, envKey) {
  const configuredKey = process.env[envKey];
  if (configuredKey) return new ethers.Wallet(configuredKey, provider);
  if (DEMO_MNEMONIC) {
    const hd = ethers.HDNodeWallet.fromPhrase(DEMO_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
    return new ethers.Wallet(hd.privateKey, provider);
  }
  // Status endpoints still expose valid addresses, but these are deliberately
  // non-signing placeholders; readiness checks the dedicated-key flag above.
  const readonlyAddresses = {
    TEMPO_DEMO_BUYER_PRIVATE_KEY: '0x0000000000000000000000000000000000000001',
    TEMPO_DEMO_BUYER_2_PRIVATE_KEY: '0x0000000000000000000000000000000000000008',
    TEMPO_DEMO_BUYER_3_PRIVATE_KEY: '0x0000000000000000000000000000000000000009',
    TEMPO_DEMO_SELLER_A_PRIVATE_KEY: '0x0000000000000000000000000000000000000002',
    TEMPO_DEMO_SELLER_B_PRIVATE_KEY: '0x0000000000000000000000000000000000000003',
    TEMPO_DEMO_SELLER_C_PRIVATE_KEY: '0x0000000000000000000000000000000000000004',
    TEMPO_DEMO_SUPPLIER_A_PRIVATE_KEY: '0x0000000000000000000000000000000000000005',
    TEMPO_DEMO_SUPPLIER_B_PRIVATE_KEY: '0x0000000000000000000000000000000000000006',
    TEMPO_DEMO_SUPPLIER_C_PRIVATE_KEY: '0x0000000000000000000000000000000000000007',
  };
  return { address: readonlyAddresses[envKey], provider };
}

const demoBuyerWallets = [
  deriveRoleWallet(0, 'TEMPO_DEMO_BUYER_PRIVATE_KEY'),
  deriveRoleWallet(2, 'TEMPO_DEMO_BUYER_2_PRIVATE_KEY'),
  deriveRoleWallet(3, 'TEMPO_DEMO_BUYER_3_PRIVATE_KEY'),
];
const demoBuyerWallet = demoBuyerWallets[0];

const sellerWallets = {
  A: deriveRoleWallet(1, 'TEMPO_DEMO_SELLER_A_PRIVATE_KEY'),
  // These fresh deterministic accounts are not the pre-existing Moderato
  // demo accounts whose TIP-403 policy state can reject a new approval.
  B: deriveRoleWallet(4, 'TEMPO_DEMO_SELLER_B_PRIVATE_KEY'),
  C: deriveRoleWallet(5, 'TEMPO_DEMO_SELLER_C_PRIVATE_KEY'),
};

const supplierWallets = {
  A: deriveRoleWallet(6, 'TEMPO_DEMO_SUPPLIER_A_PRIVATE_KEY'),
  B: deriveRoleWallet(7, 'TEMPO_DEMO_SUPPLIER_B_PRIVATE_KEY'),
  C: deriveRoleWallet(8, 'TEMPO_DEMO_SUPPLIER_C_PRIVATE_KEY'),
};

function getSellerByIndex(index, fallbackName) {
  if (Number(index) === 0) {
    return { key: 'A', name: fallbackName || 'Seller A (Nova Direct)', address: sellerWallets.A.address, wallet: sellerWallets.A };
  }
  if (Number(index) === 1) {
    return { key: 'B', name: fallbackName || 'Seller B (Apex Supply)', address: sellerWallets.B.address, wallet: sellerWallets.B };
  }
  return { key: 'C', name: fallbackName || 'Seller C (Vertex Global)', address: sellerWallets.C.address, wallet: sellerWallets.C };
}

function getSupplierById(id, fallbackName) {
  const key = String(id || 'C').toUpperCase();
  if (key === 'A') {
    return { key: 'A', name: fallbackName || 'Supplier A (RoastWorks)', address: supplierWallets.A.address, wallet: supplierWallets.A };
  }
  if (key === 'B') {
    return { key: 'B', name: fallbackName || 'Supplier B (BeanCraft)', address: supplierWallets.B.address, wallet: supplierWallets.B };
  }
  return { key: 'C', name: fallbackName || 'Supplier C (Origin Bulk)', address: supplierWallets.C.address, wallet: supplierWallets.C };
}

// Resolve known seller/supplier wallet address to human-readable name
function resolveActorLabel(addr) {
  if (!addr) return 'Verified Supplier';
  const lower = String(addr).toLowerCase();
  if (sellerWallets.A.address.toLowerCase() === lower) return 'Seller A (Nova Direct)';
  if (sellerWallets.B.address.toLowerCase() === lower) return 'Seller B (Apex Supply)';
  if (sellerWallets.C.address.toLowerCase() === lower) return 'Seller C (Vertex Global)';
  if (supplierWallets.A.address.toLowerCase() === lower) return 'Supplier A (RoastWorks)';
  if (supplierWallets.B.address.toLowerCase() === lower) return 'Supplier B (BeanCraft)';
  if (supplierWallets.C.address.toLowerCase() === lower) return 'Supplier C (Origin Bulk)';
  return `${String(addr).slice(0, 6)}...${String(addr).slice(-4)}`;
}

// Contract deployment is explicit (contracts/deploy.js), never an implicit API side effect.

// Sequential transaction queue to avoid nonce collisions
let txQueue = Promise.resolve();
const verifiedProofTasks = new Map();



// Reconnect contracts when wallet changes
function updateActiveWallet(newPrivateKey) {
  try {
    const normalizedKey = String(newPrivateKey).trim().startsWith('0x')
      ? String(newPrivateKey).trim()
      : `0x${String(newPrivateKey).trim()}`;
    const newWallet = new ethers.Wallet(normalizedKey, provider);
    activePrivateKey = normalizedKey;
    activeWallet = newWallet;
    escrowContract = new ethers.Contract(CONTRACT_ADDRESS, FULL_ESCROW_ABI, activeWallet);
    if (PATH_USD_ADDRESS) {
      tokenContract = new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, activeWallet);
    }
    if (state && state.tempoNetwork) {
      state.mode = 'SIMULATED';
      state.tempoNetwork.treasury = activeWallet.address;
      state.tempoNetwork.status = 'CONNECTED';
    }
    console.log(`[Tempo] Active wallet updated to: ${activeWallet.address}`);
    return { success: true, address: activeWallet.address };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

let latestBlockNumber = deployedConfig.blockNumber || 37550250;
async function refreshBlockNumber() {
  try {
    const bn = await provider.getBlockNumber();
    if (bn) latestBlockNumber = bn;
  } catch {
    // keep current
  }
}
// Polling starts only in the executable server, not when imported by tests.

// Helper: Ensure TIP-20 allowance before contract pulls tokens


function numericFromText(val) {
  return Number(String(val || '').replace(/[^\d.]/g, '')) || 0;
}

// Format human-readable Live Log string directly from decoded on-chain event log
function formatEventLog(parsed) {
  if (!parsed || !parsed.name) return null;
  const a = parsed.args;
  switch (parsed.name) {
    case 'DealJoined': {
      const depUsd = pathUsdUnitsToUsd(a.depositAmount, 2);
      const count = Number(a.buyersCount);
      return `On-chain DealJoined: Buyer #${count} locked $${depUsd} PathUSD in Escrow`;
    }
    case 'OfferSubmitted': {
      const priceUsd = pathUsdUnitsToUsd(a.price, 2);
      const bondUsd = pathUsdUnitsToUsd(a.guaranteeBond, 2);
      return `On-chain OfferSubmitted: ${a.sellerName} bid $${priceUsd} (Bond $${bondUsd} locked · min ${a.minimumBuyerCount} buyer${Number(a.minimumBuyerCount) === 1 ? '' : 's'})`;
    }
    case 'PriceLadderSubmitted': {
      const bondUsd = pathUsdUnitsToUsd(a.guaranteeBond, 2);
      return `On-chain seller ladder: ${a.tierCount} price levels published · $${bondUsd} guarantee locked`;
    }
    case 'PriceTierActivated': {
      const priceUsd = pathUsdUnitsToUsd(a.price, 2);
      return `On-chain price tier unlocked: ${priceUsd} after ${a.minimumBuyerCount} funded buyer${Number(a.minimumBuyerCount) === 1 ? '' : 's'}`;
    }
    case 'DealPriceLocked': {
      const sellerLabel = resolveActorLabel(a.winningSeller);
      const finalUsd = pathUsdUnitsToUsd(a.finalPrice, 2);
      const volUsd = pathUsdUnitsToUsd(a.grossVolume, 2);
      const feeUsd = pathUsdUnitsToUsd(a.platformFee, 2);
      return `On-chain price locked: ${sellerLabel} won at $${finalUsd}/unit (${volUsd} order value · Fee ${feeUsd} after delivery)`;
    }
    case 'DealRefunded': {
      const refUsd = pathUsdUnitsToUsd(a.totalRefunded, 2);
      return `On-chain DealRefunded (${a.reason}) · $${refUsd} total returned ($0 fee)`;
    }
    case 'FulfillmentPaymentReleased': {
      const payoutUsd = pathUsdUnitsToUsd(a.sellerPayout, 2);
      const feeUsd = pathUsdUnitsToUsd(a.platformFee, 2);
      return `On-chain delivery confirmed: seller paid $${payoutUsd} · DealArena fee released $${feeUsd}`;
    }
    case 'BuyerRefunded': {
      const amtUsd = pathUsdUnitsToUsd(a.amount, 2);
      return `On-chain BuyerRefunded: $${amtUsd} PathUSD returned to ${String(a.recipient).slice(0, 6)}...`;
    }
    case 'GuaranteeSlashed': {
      const sellerLabel = resolveActorLabel(a.seller);
      const slashUsd = pathUsdUnitsToUsd(a.slashedAmount, 2);
      return `On-chain GuaranteeSlashed: ${sellerLabel} forfeited $${slashUsd} (${a.reason})`;
    }
    case 'BusinessPoolJoined': {
      const comUsd = pathUsdUnitsToUsd(a.commitmentAmount, 2);
      return `On-chain BusinessPoolJoined: $${comUsd} PathUSD locked in pool`;
    }
    case 'BusinessOfferSubmitted': {
      const disc = Number(a.discountPercent);
      const bondUsd = pathUsdUnitsToUsd(a.guaranteeBond, 2);
      return `On-chain BusinessOfferSubmitted: ${a.supplierName} offered −${disc}% (Bond $${bondUsd} locked)`;
    }
    case 'BusinessPoolSettled': {
      const supplierLabel = resolveActorLabel(a.winningSupplier);
      const payUsd = pathUsdUnitsToUsd(a.netPayout, 2);
      const feeUsd = pathUsdUnitsToUsd(a.platformFee, 2);
      return `On-chain BusinessPoolSettled: ${supplierLabel} won wholesale pool ($${payUsd} total net · Fee $${feeUsd})`;
    }
    case 'BusinessPoolRefunded': {
      const refUsd = pathUsdUnitsToUsd(a.totalRefunded, 2);
      return `On-chain BusinessPoolRefunded (${a.reason}) · $${refUsd} returned`;
    }
    case 'RequestCreated': {
      const maxUsd = pathUsdUnitsToUsd(a.maxPrice, 2);
      const authUsd = pathUsdUnitsToUsd(a.authAmount, 2);
      return `On-chain RequestCreated: "${a.title}" (cap $${maxUsd}, $${authUsd} auth locked)`;
    }
    case 'RequestJoined': {
      const authUsd = pathUsdUnitsToUsd(a.authAmount, 2);
      return `On-chain RequestJoined: Buyer #${Number(a.buyersCount)} locked $${authUsd} auth`;
    }
    case 'RequestOfferSubmitted': {
      const pUsd = pathUsdUnitsToUsd(a.price, 2);
      const bUsd = pathUsdUnitsToUsd(a.guaranteeBond, 2);
      return `On-chain RequestOfferSubmitted: ${a.supplierName} bid $${pUsd} (Bond $${bUsd} locked)`;
    }
    case 'RequestSettled': {
      const supplierLabel = resolveActorLabel(a.winningSupplier);
      const pUsd = pathUsdUnitsToUsd(a.finalPrice, 2);
      return `On-chain RequestSettled: ${supplierLabel} accepted at $${pUsd}/unit`;
    }
    case 'RequestRefunded': {
      const refUsd = pathUsdUnitsToUsd(a.totalRefunded, 2);
      return `On-chain RequestRefunded (${a.reason}) · $${refUsd} returned`;
    }
    case 'PaymentReference':
      return `Tempo payment memo ${a.memo} linked to ${a.marketId} (${a.phase})`;
    default:
      return null;
  }
}

function paymentMemo(marketId, phase) {
  return ethers.keccak256(ethers.toUtf8Bytes(`DealArena:${marketId}:${phase}`));
}

function nativeContractCall(method, args) {
  return {
    to: CONTRACT_ADDRESS,
    value: 0n,
    data: escrowContract.interface.encodeFunctionData(method, args),
  };
}

async function waitForTempoReceipt(hash, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

// Helper: Broadcast real transaction to Tempo Testnet through sequential nonce queue
function executeTempoTx(populate, type, details, amountStr, approvalAmount = 0n, extraMeta = {}) {
  const runTask = async () => {
    if (!activeWallet || !escrowContract) throw new Error('Settlement wallet is not configured');
    if (approvalAmount !== 0n) throw new Error('Server must not sponsor buyer or seller funds');
    const context = actionContext.getStore();
    if (!context) throw new Error('Durable action context is required');
    const prepared = await activeWallet.populateTransaction(await populate());
    const signed = await activeWallet.signTransaction(prepared);
    const hash = ethers.keccak256(signed);
    context.update({ status: 'BROADCASTING', hash, signedTransaction: signed, contract: CONTRACT_ADDRESS, chainId: TEMPO_CHAIN_ID });
    try { await provider.broadcastTransaction(signed); }
    catch (err) { err.txStatus = 'PENDING'; err.txHash = hash; throw err; }
    const receipt = await waitForTempoReceipt(hash);
    if (!receipt) {
      const err = new Error('Receipt pending; do not resend'); err.txStatus = 'PENDING'; err.txHash = hash; throw err;
    }
    return receiptProof(receipt, type, { ...extraMeta, amount: amountStr, details });
  };
  const result = txQueue.then(runTask, runTask);
  txQueue = result.catch(() => {});
  return result;
}

// Tempo Type 0x76 is the chain-native transaction envelope. Its calls array
// is atomic, so the settlement state change and the explicit buyer payout
// batch are committed together in one transaction.
function executeTempoNativeBatch(calls, type, details, amountStr, extraMeta = {}) {
  const runTask = async () => {
    if (!activeWallet || !escrowContract) throw new Error('Settlement wallet is not configured');
    if (!Array.isArray(calls) || calls.length < LIVE_NATIVE_BATCH_MIN || calls.length > LIVE_NATIVE_BATCH_MAX) {
      throw new Error(`Tempo native batch must contain ${LIVE_NATIVE_BATCH_MIN}-${LIVE_NATIVE_BATCH_MAX} calls`);
    }
    const context = actionContext.getStore();
    if (!context) throw new Error('Durable action context is required');
    const nonce = BigInt(await provider.getTransactionCount(activeWallet.address, 'pending'));
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits('1', 'gwei');
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 0n;
    const envelope = TxEnvelopeTempo.from({
      chainId: TEMPO_CHAIN_ID,
      type: 'tempo',
      calls,
      accessList: [],
      nonceKey: 0n,
      nonce,
      feeToken: PATH_USD_ADDRESS,
      gas: 5000000n,
      maxPriorityFeePerGas,
      maxFeePerGas,
    });
    const digest = TxEnvelopeTempo.getSignPayload(envelope);
    const signature = Secp256k1.sign({ payload: digest, privateKey: activePrivateKey });
    const signed = TxEnvelopeTempo.from(envelope, { signature });
    const raw = TxEnvelopeTempo.serialize(signed);
    const hash = ethers.keccak256(raw);
    context.update({ status: 'BROADCASTING', hash, signedTransaction: raw, contract: CONTRACT_ADDRESS, chainId: TEMPO_CHAIN_ID, transactionType: '0x76' });
    // Ethers v6 cannot wrap Tempo's custom 0x76 response as a legacy
    // TransactionResponse, so submit the signed bytes through raw JSON-RPC.
    try {
      const rpcHash = await provider.send('eth_sendRawTransaction', [raw]);
      if (rpcHash && rpcHash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC returned a different transaction hash');
    }
    catch (err) { err.txStatus = 'PENDING'; err.txHash = hash; throw err; }
    const receipt = await waitForTempoReceipt(hash);
    if (!receipt) {
      const err = new Error('Receipt pending; do not resend'); err.txStatus = 'PENDING'; err.txHash = hash; throw err;
    }
    return receiptProof(receipt, type, { ...extraMeta, amount: amountStr, details, transactionType: '0x76', nativeBatchCalls: calls.length });
  };
  const result = txQueue.then(runTask, runTask);
  txQueue = result.catch(() => {});
  return result;
}

// Server-owned preset wallets power the demo's one-click live mini-deal. They
// are real signers on Tempo, but they never require browser wallet access.
function executePresetWalletTx(wallet, populate, type, details, extraMeta = {}) {
  const runTask = async () => {
    if (!wallet) throw new Error('Preset demo wallet is not configured');
    const context = actionContext.getStore();
    if (!context) throw new Error('Durable action context is required');
    const prepared = await wallet.populateTransaction(await populate());
    const signed = await wallet.signTransaction(prepared);
    const hash = ethers.keccak256(signed);
    context.update({ status: 'BROADCASTING', hash, signedTransaction: signed, chainId: TEMPO_CHAIN_ID });
    try {
      const rpcHash = await provider.send('eth_sendRawTransaction', [signed]);
      if (rpcHash && rpcHash.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC returned a different transaction hash');
    } catch (err) {
      err.txStatus = 'PENDING'; err.txHash = hash; throw err;
    }
    const receipt = await waitForTempoReceipt(hash);
    if (!receipt) {
      const err = new Error('Receipt pending; do not resend'); err.txStatus = 'PENDING'; err.txHash = hash; throw err;
    }
    return receiptProof(receipt, type, { ...extraMeta, amount: '', details });
  };
  const result = txQueue.then(runTask, runTask);
  txQueue = result.catch(() => {});
  return result;
}

async function waitForTokenBalance(wallet, minimum, attempts = 12) {
  const token = new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, provider);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const balance = await token.balanceOf(wallet.address);
    if (BigInt(balance) >= BigInt(minimum)) return BigInt(balance);
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return BigInt(await token.balanceOf(wallet.address));
}

async function ensurePresetWalletFunds(wallet, required, recordStep) {
  const tokenRead = new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, provider);
  let balance = BigInt(await tokenRead.balanceOf(wallet.address));
  if (balance >= required) return;

  // Prefer a deterministic owner-funded top-up so the demo does not depend on
  // an external faucet being available during every browser session.
  if (activeWallet) {
    const ownerBalance = BigInt(await tokenRead.balanceOf(activeWallet.address));
    const topUp = required - balance + 2_000_000n;
    if (ownerBalance >= topUp) {
      const proof = await recordStep(() => executePresetWalletTx(activeWallet,
        () => tokenContract.transfer.populateTransaction(wallet.address, topUp),
        'DEMO_FUNDING', `Fund preset demo wallet ${wallet.address}`, { allowTokenOnly: true }));
      balance = await waitForTokenBalance(wallet, required);
      if (balance >= required) return;
      void proof;
    }
  }

  try { await provider.send('tempo_fundAddress', [wallet.address]); } catch { /* faucet is a fallback only */ }
  balance = await waitForTokenBalance(wallet, required);
  if (balance < required) throw new Error(`Preset demo wallet ${wallet.address} has insufficient PathUSD; fund the testnet wallet or configure a dedicated demo key.`);
}

async function ensurePresetAllowance(wallet, amount, recordStep) {
  const tokenRead = new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, provider);
  const allowance = BigInt(await tokenRead.allowance(wallet.address, CONTRACT_ADDRESS));
  if (allowance >= amount) return;
  // Keep the preset actors ready across repeated demo resets without granting
  // the escrow an unbounded token allowance.
  const durableApproval = amount * 10n;
  await recordStep(() => executePresetWalletTx(wallet,
    () => new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, wallet).approve.populateTransaction(CONTRACT_ADDRESS, durableApproval),
    'DEMO_APPROVAL', `Approve escrow for preset wallet ${wallet.address}`, { allowTokenOnly: true }));
}

let presetReadinessCache = null;
let presetReadinessTask = null;
async function getPresetDemoReadiness() {
  // Several open pages poll together. Share one read-only check instead of
  // flooding the public RPC and turning a healthy payment gate red on 429s.
  if (presetReadinessCache && Date.now() < presetReadinessCache.expiresAt) return presetReadinessCache.result;
  if (!presetReadinessTask) {
    presetReadinessTask = readPresetDemoReadiness().then((result) => {
      presetReadinessCache = { result, expiresAt: Date.now() + (result.ready ? 10000 : 2000) };
      return result;
    }).finally(() => { presetReadinessTask = null; });
  }
  return presetReadinessTask;
}
async function readPresetDemoReadiness() {
  // Preparation can pre-fund several presenter runs, but readiness must only
  // require the next run. Otherwise the first successful run makes the status
  // red even though the wallet still has enough balance for another run.
  const buyerRequired = centsToPathUsdUnits(LIVE_DEMO_BUYER_DEPOSIT_CENTS * LIVE_DEMO_READINESS_RUNS);
  const sellerRequired = centsToPathUsdUnits(LIVE_DEMO_SELLER_BOND_CENTS * LIVE_DEMO_READINESS_RUNS);
  const minimumOwnerFeeBalance = centsToPathUsdUnits(100);
  const checks = {
    dedicatedDemoKeys: DEMO_KEYS_CONFIGURED,
    sourceHash: deploymentSourceHashMatch,
    compiledSourceHash: compiledArtifactSourceHash,
    deployedSourceHash,
    sellerAuthorization: false,
    contractVersion: false,
    ownerWallet: false,
    ownerFeeBalance: false,
    rpc: false,
    contract: false,
    paymentToken: false,
    wallets: {},
  };
  try {
    // Readiness is a read-only gate. Use a fresh provider here so a stale
    // long-lived RPC node cannot hide a contract that is already deployed.
    const readinessRpcUrl = `${TEMPO_RPC}${TEMPO_RPC.includes('?') ? '&' : '?'}readiness=${Date.now()}`;
    let readinessProvider = createTempoProvider(readinessRpcUrl);
    const network = await readinessProvider.getNetwork();
    checks.rpc = Number(network.chainId) === TEMPO_CHAIN_ID;
    let contractCode = await readinessProvider.getCode(CONTRACT_ADDRESS);
    let paymentTokenCode = await readinessProvider.getCode(PATH_USD_ADDRESS);
    // Tempo's public RPC is load-balanced. A fresh cache-busting URL can
    // occasionally land on a lagging node even while the normal session and
    // another read-only node already see the deployment. Retry against the
    // canonical endpoint before treating LIVE as unavailable.
    if (contractCode === '0x' || paymentTokenCode === '0x') {
      const fallbackProvider = createTempoProvider(TEMPO_RPC);
      const fallbackContractCode = await fallbackProvider.getCode(CONTRACT_ADDRESS);
      const fallbackPaymentTokenCode = await fallbackProvider.getCode(PATH_USD_ADDRESS);
      if (fallbackContractCode !== '0x' && fallbackPaymentTokenCode !== '0x') {
        readinessProvider = fallbackProvider;
        contractCode = fallbackContractCode;
        paymentTokenCode = fallbackPaymentTokenCode;
      }
    }
    checks.contract = contractCode !== '0x';
    checks.paymentToken = paymentTokenCode !== '0x';
    const escrowRead = new ethers.Contract(CONTRACT_ADDRESS, FULL_ESCROW_ABI, readinessProvider);
    const chainVersion = Number(await escrowRead.CONTRACT_VERSION());
    const chainPaymentToken = await escrowRead.paymentToken();
    const chainOwner = await escrowRead.owner();
    checks.contractVersion = chainVersion === LIVE_SECURITY_VERSION;
    checks.minimumSecurityVersion = LIVE_SECURITY_VERSION;
    checks.contractVersionOnChain = chainVersion;
    checks.paymentTokenAddress = chainPaymentToken;
    checks.paymentToken = checks.paymentToken && chainPaymentToken.toLowerCase() === PATH_USD_ADDRESS.toLowerCase();
    checks.ownerAddress = chainOwner;
    checks.ownerWallet = Boolean(activeWallet && activePrivateKey && chainOwner.toLowerCase() === activeWallet.address.toLowerCase());
    const tokenRead = new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, readinessProvider);
    const ownerBalance = activeWallet ? BigInt(await tokenRead.balanceOf(activeWallet.address)) : 0n;
    checks.ownerFeeBalance = ownerBalance >= minimumOwnerFeeBalance;
    checks.ownerFeeBalanceRaw = ownerBalance.toString();
    const roles = [
      ...demoBuyerWallets.map((wallet, index) => [`buyer${index + 1}`, wallet, buyerRequired]),
      ['sellerA', sellerWallets.A, sellerRequired],
      ['sellerB', sellerWallets.B, sellerRequired],
      ['sellerC', sellerWallets.C, sellerRequired],
      ['supplierA', supplierWallets.A, sellerRequired],
      ['supplierB', supplierWallets.B, sellerRequired],
      ['supplierC', supplierWallets.C, sellerRequired],
    ];
    // v17 uses the public seller path: sellers do not need a private
    // allow-list entry, but a revoked seller must never be used for proof.
    // Keep the old authorization values as diagnostics so the status page
    // explains why an old deployment may still differ from the current rule.
    const actorWallets = [sellerWallets.A, sellerWallets.B, sellerWallets.C, supplierWallets.A, supplierWallets.B, supplierWallets.C];
    const sellerAuthorization = [];
    const sellerRevocations = [];
    for (const actor of actorWallets) {
      sellerAuthorization.push(await escrowRead.authorizedSellers(actor.address));
      sellerRevocations.push(await escrowRead.sellerRevoked(actor.address));
    }
    checks.sellerAuthorization = sellerRevocations.every((revoked) => !revoked);
    checks.sellerAuthorizationAddresses = {
      A: { address: sellerWallets.A.address, authorized: Boolean(sellerAuthorization[0]), revoked: Boolean(sellerRevocations[0]) },
      B: { address: sellerWallets.B.address, authorized: Boolean(sellerAuthorization[1]), revoked: Boolean(sellerRevocations[1]) },
      C: { address: sellerWallets.C.address, authorized: Boolean(sellerAuthorization[2]), revoked: Boolean(sellerRevocations[2]) },
      supplierA: { address: supplierWallets.A.address, authorized: Boolean(sellerAuthorization[3]), revoked: Boolean(sellerRevocations[3]) },
      supplierB: { address: supplierWallets.B.address, authorized: Boolean(sellerAuthorization[4]), revoked: Boolean(sellerRevocations[4]) },
      supplierC: { address: supplierWallets.C.address, authorized: Boolean(sellerAuthorization[5]), revoked: Boolean(sellerRevocations[5]) },
    };
    for (const [role, wallet, required] of roles) {
      const balance = BigInt(await tokenRead.balanceOf(wallet.address));
      const allowance = BigInt(await tokenRead.allowance(wallet.address, CONTRACT_ADDRESS));
      checks.wallets[role] = {
        address: wallet.address,
        funded: balance >= required,
        approved: allowance >= required,
        balance: balance.toString(),
        allowance: allowance.toString(),
      };
    }
  } catch (error) {
    const nested = Array.isArray(error?.errors) ? error.errors.map((entry) => entry?.message || String(entry)).join(' | ') : '';
    checks.error = [error?.message || String(error), nested].filter(Boolean).join(': ');
  }
  const walletsReady = Object.values(checks.wallets).length === LIVE_DEMO_BUYER_COUNT + 6
    && Object.values(checks.wallets).every((wallet) => wallet.funded && wallet.approved);
  return {
    ready: checks.dedicatedDemoKeys && checks.sourceHash && checks.sellerAuthorization && checks.contractVersion && checks.ownerWallet && checks.ownerFeeBalance && checks.rpc && checks.contract && checks.paymentToken && walletsReady,
    checks,
    mode: PUBLIC_DEMO_ENABLED ? 'PUBLIC_PRESET_TESTNET' : 'LOCAL_PRESET_TESTNET',
  };
}

async function preparePresetDemoWallets() {
  if (!DEMO_KEYS_CONFIGURED) throw new Error('Dedicated LIVE demo keys are required; configure TEMPO_DEMO_MNEMONIC or all TEMPO_DEMO_*_PRIVATE_KEY variables.');
  if (!activeWallet || !escrowContract) throw new Error('Owner wallet is required to prepare the preset demo wallets');
  const buyerDeposit = centsToPathUsdUnits(LIVE_DEMO_BUYER_DEPOSIT_CENTS * LIVE_DEMO_PREPARED_RUNS);
  const sellerBond = centsToPathUsdUnits(LIVE_DEMO_SELLER_BOND_CENTS * LIVE_DEMO_PREPARED_RUNS);
  const receipts = [];
  const recordStep = async (factory) => {
    const proof = await actionContext.run({ update: () => {} }, factory);
    receipts.push(proof);
    return proof;
  };
  for (const buyer of demoBuyerWallets) await ensurePresetWalletFunds(buyer, buyerDeposit, recordStep);
  await ensurePresetWalletFunds(sellerWallets.A, sellerBond, recordStep);
  await ensurePresetWalletFunds(sellerWallets.B, sellerBond, recordStep);
  await ensurePresetWalletFunds(sellerWallets.C, sellerBond, recordStep);
  for (const supplier of Object.values(supplierWallets)) await ensurePresetWalletFunds(supplier, sellerBond, recordStep);
  for (const buyer of demoBuyerWallets) await ensurePresetAllowance(buyer, buyerDeposit, recordStep);
  await ensurePresetAllowance(sellerWallets.A, sellerBond, recordStep);
  await ensurePresetAllowance(sellerWallets.B, sellerBond, recordStep);
  await ensurePresetAllowance(sellerWallets.C, sellerBond, recordStep);
  for (const supplier of Object.values(supplierWallets)) await ensurePresetAllowance(supplier, sellerBond, recordStep);
  return { success: true, preparationTransactions: receipts, readiness: await getPresetDemoReadiness() };
}

function liveDealIdFor(simulationDealId) {
  return requiredId(`LIVE-${simulationDealId}`);
}

function freshLiveDealId(simulationDealId) {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  return requiredId(`LIVE-${simulationDealId}-${suffix}`);
}

const liveDemoTasks = new Map();
const LIVE_DEMO_STEP_KEYS = ['BUYER_1', 'LADDER', 'SELLER_B', 'BUYER_2', 'BUYER_3'];
const LIVE_DEMO_STEP_DONE = ['BUYER_1_DONE', 'LADDER_DONE', 'SELLER_B_DONE', 'BUYER_2_DONE', 'BUYER_3_DONE'];

function freshLiveStepStates() {
  return LIVE_DEMO_STEP_KEYS.map((key) => ({ key, status: 'PENDING', hash: null }));
}

function liveStepStatesFor(demo) {
  const existing = Array.isArray(demo?.stepStates) ? demo.stepStates : [];
  return LIVE_DEMO_STEP_KEYS.map((key, index) => ({
    key,
    status: existing[index]?.status || 'PENDING',
    hash: existing[index]?.hash || null,
  }));
}

function liveDemoSteps(simulationDealId) {
  const liveDealId = state.liveDemo?.simulationDealId === simulationDealId && state.liveDemo.liveDealId
    ? requiredId(state.liveDemo.liveDealId)
    : liveDealIdFor(simulationDealId);
  const [buyer1, buyer2, buyer3] = demoBuyerWallets;
  const sellerA = sellerWallets.A;
  const sellerB = sellerWallets.B;
  const buyerDeposit = centsToPathUsdUnits(LIVE_DEMO_BUYER_DEPOSIT_CENTS);
  const sellerBond = centsToPathUsdUnits(LIVE_DEMO_SELLER_BOND_CENTS);
  const offerExpiry = Math.floor(Date.now() / 1000) + 30 * 60;
  return [
    {
      wallet: buyer1,
      type: 'DEMO_BUYER_JOIN',
      details: 'First buyer commits up to $680',
      meta: { simulationDealId, liveDealId, actor: 'buyer1', actorAddress: buyer1.address, unitPriceCents: LIVE_DEMO_BUYER_DEPOSIT_CENTS },
      populate: () => escrowContract.connect(buyer1).joinDeal.populateTransaction(liveDealId, buyerDeposit),
    },
    {
      wallet: sellerA,
      type: 'DEMO_SELLER_LADDER',
      details: 'Seller A publishes $680 → $670 → $660 ladder',
      meta: { simulationDealId, liveDealId, actor: 'sellerA', actorAddress: sellerA.address, priceCents: 68000, minimumBuyerCount: 1, ladder: true },
      populate: () => escrowContract.connect(sellerA).submitPriceLadder.populateTransaction(
        liveDealId,
        [centsToPathUsdUnits(68000), centsToPathUsdUnits(67000), centsToPathUsdUnits(66000)],
        [1, 2, 3],
        LIVE_DEMO_BUYER_COUNT,
        offerExpiry,
        sellerBond,
      ),
    },
    {
      wallet: sellerB,
      type: 'DEMO_SELLER_OFFER',
      details: 'Seller B enters at $675 and makes the market compete',
      meta: { simulationDealId, liveDealId, actor: 'sellerB', actorAddress: sellerB.address, priceCents: 67500, minimumBuyerCount: 1 },
      populate: () => escrowContract.connect(sellerB).submitOfferWithCapacity.populateTransaction(liveDealId, 'Seller B (Apex Supply)', centsToPathUsdUnits(67500), sellerBond, 1, LIVE_DEMO_BUYER_COUNT, offerExpiry),
    },
    {
      wallet: buyer2,
      type: 'DEMO_BUYER_JOIN',
      details: 'Second buyer unlocks the $670 tier',
      meta: { simulationDealId, liveDealId, actor: 'buyer2', actorAddress: buyer2.address, unitPriceCents: LIVE_DEMO_BUYER_DEPOSIT_CENTS },
      populate: () => escrowContract.connect(buyer2).joinDeal.populateTransaction(liveDealId, buyerDeposit),
    },
    {
      wallet: buyer3,
      type: 'DEMO_BUYER_JOIN',
      details: 'Third buyer unlocks the $660 tier',
      meta: { simulationDealId, liveDealId, actor: 'buyer3', actorAddress: buyer3.address, unitPriceCents: LIVE_DEMO_BUYER_DEPOSIT_CENTS },
      populate: () => escrowContract.connect(buyer3).joinDeal.populateTransaction(liveDealId, buyerDeposit),
    },
  ];
}

function liveDemoHasEvent(receipts, eventName) {
  return receipts.some((entry) => entry.events?.some((event) => event.name === eventName));
}

function liveDemoBuyerCount(receipts) {
  const buyers = new Set();
  for (const receipt of receipts || []) {
    for (const event of receipt.events || []) {
      if (event.name !== 'DealJoined') continue;
      const address = event.args?.[1] || event.args?.buyer;
      if (address) buyers.add(String(address).toLowerCase());
    }
  }
  return buyers.size;
}

function liveDemoResponse(status, error = null) {
  const demo = state.liveDemo;
  return {
    success: status === 'CONFIRMED',
    status,
    isOnChain: status === 'CONFIRMED',
    simulationDealId: demo?.simulationDealId,
    liveDealId: demo?.liveDealId,
    hash: demo?.lastHash || demo?.receipts?.at(-1)?.hash || null,
    receipts: demo?.receipts || [],
    demo,
    liveDemo: demo,
    error,
  };
}

async function executeLiveDemoSteps(simulationDealId, update) {
  const steps = liveDemoSteps(simulationDealId);
  const receipts = Array.isArray(state.liveDemo?.receipts) ? [...state.liveDemo.receipts] : [];
  state.liveDemo = { ...state.liveDemo, stepStates: liveStepStatesFor(state.liveDemo) };

  const saveReceipt = (proof, stepIndex = state.liveDemo.currentStep?.index ?? receipts.length) => {
    if (!receipts.some((entry) => entry.hash?.toLowerCase() === proof.hash?.toLowerCase())) receipts.push(proof);
    const stepStates = liveStepStatesFor(state.liveDemo);
    if (stepStates[stepIndex]) stepStates[stepIndex] = { ...stepStates[stepIndex], status: LIVE_DEMO_STEP_DONE[stepIndex], hash: proof.hash };
    const updated = {
      ...state.liveDemo,
      status: 'IN_PROGRESS',
      phase: LIVE_DEMO_STEP_DONE[stepIndex],
      buyersCount: liveDemoBuyerCount(receipts),
      transactionCount: receipts.length,
      individualTransactionCount: receipts.length,
      receipts,
      currentStep: null,
      lastHash: proof.hash,
      lastError: null,
      stepStates,
    };
    state.liveDemo = updated;
    persistLiveDemo(updated);
    return proof;
  };

  // If the previous HTTP request timed out, check the already-broadcast hash.
  // Never recreate that transaction: a later poll either confirms it or leaves
  // the deal recoverable for refund.
  if (state.liveDemo?.lastHash && state.liveDemo?.currentStep) {
    const pendingStep = steps[Number(state.liveDemo.currentStep.index)];
    const receipt = await waitForTempoReceipt(state.liveDemo.lastHash, 1000);
    if (!receipt) {
      state.liveDemo = { ...state.liveDemo, status: 'PENDING', lastError: 'Receipt pending; check again without resending.' };
      persistLiveDemo(state.liveDemo);
      return liveDemoResponse('PENDING', state.liveDemo.lastError);
    }
    try {
      saveReceipt(receiptProof(receipt, pendingStep.type, { ...pendingStep.meta, amount: '', details: pendingStep.details }), Number(state.liveDemo.currentStep.index));
    } catch (error) {
      error.txStatus = error.txStatus || 'FAILED';
      error.txHash = error.txHash || state.liveDemo.lastHash;
      state.liveDemo = { ...state.liveDemo, status: 'PARTIAL_FAILED', lastError: error.message };
      persistLiveDemo(state.liveDemo);
      return liveDemoResponse('FAILED', error.message);
    }
  }

  const recordStep = async (step, index) => {
    const currentStep = { index, key: LIVE_DEMO_STEP_KEYS[index], type: step.type, details: step.details, meta: step.meta };
    state.liveDemo = { ...state.liveDemo, status: 'IN_PROGRESS', phase: `${currentStep.key}_IN_FLIGHT`, currentStep, lastError: null };
    persistLiveDemo(state.liveDemo);
    try {
      const proof = await executePresetWalletTxWithLiveJournal(step, update, currentStep);
      return saveReceipt(proof);
    } catch (error) {
      error.partialReceipts = receipts;
      state.liveDemo = {
        ...state.liveDemo,
        status: error.txStatus === 'PENDING' ? 'PENDING' : 'PARTIAL_FAILED',
        phase: error.txStatus === 'PENDING' ? `${LIVE_DEMO_STEP_KEYS[index]}_BROADCASTED` : `${LIVE_DEMO_STEP_KEYS[index]}_FAILED`,
        buyersCount: liveDemoBuyerCount(receipts),
        transactionCount: receipts.length,
        receipts,
        lastHash: error.txHash || state.liveDemo.lastHash || receipts.at(-1)?.hash || null,
        lastError: error.message || String(error),
        stepStates: liveStepStatesFor(state.liveDemo).map((entry, stepIndex) => stepIndex === index
          ? { ...entry, status: error.txStatus === 'PENDING' ? 'PENDING' : 'FAILED', hash: error.txHash || entry.hash }
          : entry),
      };
      persistLiveDemo(state.liveDemo);
      throw error;
    }
  };

  while (receipts.length < steps.length) {
    await recordStep(steps[receipts.length], receipts.length);
  }

  const demo = { ...state.liveDemo, status: 'READY_TO_SETTLE', phase: 'READY_TO_SETTLE', buyersCount: liveDemoBuyerCount(receipts), transactionCount: receipts.length, individualTransactionCount: receipts.length, groupedTransactionCount: 0, receipts, currentStep: null, lastError: null, stepStates: LIVE_DEMO_STEP_KEYS.map((key, index) => ({ key, status: LIVE_DEMO_STEP_DONE[index], hash: receipts[index]?.hash || null })) };
  state.liveDemo = demo;
  persistLiveDemo(demo);
  return {
    success: true,
    status: 'CONFIRMED',
    isOnChain: true,
    simulationDealId,
    liveDealId: demo.liveDealId,
    hash: receipts.at(-1).hash,
    transactionType: 'STANDARD_PRESET_WALLET',
    receipts,
    receipt: receipts.at(-1),
    demo,
    liveDemo: demo,
  };
}

function executePresetWalletTxWithLiveJournal(step, update, currentStep) {
  return actionContext.run({
    update: (patch) => {
      if (typeof update === 'function') update(patch);
      if (patch?.hash) {
        state.liveDemo = {
          ...state.liveDemo,
          status: 'PENDING',
          phase: `${currentStep.key}_BROADCASTED`,
          currentStep,
          lastHash: patch.hash,
          lastError: null,
          stepStates: liveStepStatesFor(state.liveDemo).map((entry, index) => index === currentStep.index ? { ...entry, status: 'BROADCASTED', hash: patch.hash } : entry),
        };
        persistLiveDemo(state.liveDemo);
      }
    },
  }, () => executePresetWalletTx(step.wallet, step.populate, step.type, step.details, step.meta));
}

async function runPresetLiveMiniDeal(simulationDealId, update) {
  if (state.liveDemo?.simulationDealId === simulationDealId && ['PENDING', 'IN_PROGRESS'].includes(state.liveDemo.status)) {
    return executeLiveDemoSteps(simulationDealId, update);
  }
  if (state.liveDemo?.simulationDealId === simulationDealId && ['READY_TO_SETTLE', 'SETTLED', 'AWAITING_FULFILLMENT', 'COMPLETED', 'REFUNDED'].includes(state.liveDemo.status)) {
    throw new Error('This LIVE demo id is already closed. Reset the demo to create a fresh proof.');
  }
  if (!activeWallet || !escrowContract) throw new Error('Live mini-deal requires the configured Tempo owner wallet');
  const readiness = await getPresetDemoReadiness();
  if (!readiness.ready) {
    const error = new Error('LIVE TESTNET is not ready: pre-funded and approved preset wallets are required before starting the proof.');
    error.readiness = readiness;
    throw error;
  }
  const liveDealId = freshLiveDealId(simulationDealId);
  const buyer = demoBuyerWallet;
  const sellerA = sellerWallets.A;
  const sellerB = sellerWallets.B;
  const sellerC = sellerWallets.C;
  const existingDeadline = BigInt(await escrowContract.marketDeadlines(liveDealId));
  if (existingDeadline === 0n) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
    await executePresetWalletTx(activeWallet,
      () => escrowContract.setMarketDeadline.populateTransaction(liveDealId, deadline),
      'DEMO_DEADLINE', 'Set 30-minute LIVE_TESTNET deal deadline', { allowTokenOnly: true });
  }
  const demoBase = {
    status: 'IN_PROGRESS', simulationDealId, liveDealId,
    contract: CONTRACT_ADDRESS, contractVersion: LIVE_SECURITY_VERSION,
    buyersCount: 0, buyerAddress: demoBuyerWallet.address, buyerAddresses: demoBuyerWallets.map((wallet) => wallet.address),
    sellerAddresses: { A: sellerA.address, B: sellerB.address, C: sellerC.address },
    winningSeller: sellerA.address, bestPriceCents: 66000, minimumBuyerCount: LIVE_DEMO_BUYER_COUNT, deadlineSeconds: Number(existingDeadline || BigInt(Math.floor(Date.now() / 1000) + 30 * 60)),
    phase: 'BUYER_PENDING', transactionCount: 0, individualTransactionCount: 0, groupedTransactionCount: 0,
    receipts: [], currentStep: null, lastHash: null, settlementHash: null, fulfillmentHash: null, refundHash: null,
    settlementReceipt: null, fulfillmentReceipt: null, refundReceipt: null, lastError: null, stepStates: freshLiveStepStates(),
  };
  state.liveDemo = demoBase;
  state.liveProofUsed = true;
  persistLiveDemo(demoBase);
  return executeLiveDemoSteps(simulationDealId, update);
}

function receiptProof(receipt, type, meta = {}) {
  const { allowTokenOnly = false, ...proofMeta } = meta;
  const receiptHash = receipt.hash || receipt.transactionHash;
  const receiptStatus = typeof receipt.status === 'string' && receipt.status.startsWith('0x') ? Number.parseInt(receipt.status, 16) : Number(receipt.status);
  const blockNumber = typeof receipt.blockNumber === 'string' && receipt.blockNumber.startsWith('0x') ? Number.parseInt(receipt.blockNumber, 16) : receipt.blockNumber;
  if (receiptStatus !== 1) {
    const err = new Error('Transaction reverted'); err.txStatus = 'FAILED'; err.txHash = receiptHash; throw err;
  }
  const escrowInterface = new ethers.Interface(FULL_ESCROW_ABI);
  const tokenInterface = new ethers.Interface(TIP20_ABI);
  const events = receipt.logs.filter((log) => log.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase()).map((log) => {
    try {
      const parsed = escrowInterface.parseLog(log);
      if (!parsed) return null;
      return { name: parsed.name, args: parsed.args.toArray().map((value) => typeof value === 'bigint' ? value.toString() : value), message: formatEventLog(parsed) };
    } catch { return null; }
  }).filter(Boolean);
  if (!events.length && !allowTokenOnly) throw new Error('Receipt has no escrow event');
  const paymentReferences = receipt.logs.filter((log) => log.address.toLowerCase() === PATH_USD_ADDRESS.toLowerCase()).map((log) => {
    try {
      const parsed = tokenInterface.parseLog(log);
      if (!parsed || parsed.name !== 'TransferWithMemo') return null;
      return { from: parsed.args.from, to: parsed.args.to, amount: parsed.args.amount.toString(), memo: parsed.args.memo };
    } catch { return null; }
  }).filter(Boolean);
  return { ...proofMeta, hash: receiptHash, blockNumber, from: receipt.from, to: receipt.to || CONTRACT_ADDRESS,
    type, timestamp: new Date().toISOString(), chainId: TEMPO_CHAIN_ID, network: 'Tempo Testnet (Moderato)',
    contract: receipt.to || CONTRACT_ADDRESS, status: 'CONFIRMED', isOnChain: true, events, paymentReferences,
    eventLogMessage: events.map((event) => event.message).filter(Boolean).join(' · '), explorerUrl: TEMPO_EXPLORER + '/receipt/' + receiptHash };
}

// --------------------------------------------------------------------------
// MIME Types
// --------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// --------------------------------------------------------------------------
// Unique Session / Scenario Run IDs Generator
// Prevents settled/refunded state collisions across repeated demo runs
// --------------------------------------------------------------------------
let sessionRunCounter = 1042;
function generateSessionIds() {
  const num = sessionRunCounter++;
  const rand = Date.now().toString(36).slice(-4);
  return {
    dealId: `DEAL-${num}-${rand}`,
    poolId: `coffee-bulk-${num}-${rand}`,
    laptopReqId: `laptop-req-${num}-${rand}`,
    crmReqId: `crm-req-${num}-${rand}`,
  };
}

// --------------------------------------------------------------------------
// Single Source of Truth: Canonical Scenarios Definition
// Used by both server state and frontend UI (zero duplication)
// --------------------------------------------------------------------------
const SCENARIO_DEFINITIONS = {
  normal: [
    {
      buyers: 50,
      retail: '$900',
      best: '—',
      saving: 'Price unlocks at 200 buyers',
      ladder: ['—', '$680', '$590', '$550'],
      offers: ['—', '—', '—'],
      winnerIndex: -1,
      winnerSeller: null,
      status: 'OPEN',
      offerStatus: 'WAITING',
      timer: '05:00:00',
      depositUnitPrice: 680,
      activity: '50 buyers reserved up to $680 · the first price tier starts at 200 buyers',
      log: '50 buyers reserved up to $680 · no seller price tier unlocked yet (200 buyers needed)',
    },
    {
      buyers: 200,
      retail: '$900',
      best: '$680',
      saving: 'You save $220',
      ladder: ['—', '$680', '$590', '$550'],
      offers: ['$780', '$680', '$680'],
      winnerIndex: 1,
      winnerSeller: 'Seller B (Apex Supply)',
      status: 'OPEN',
      offerStatus: 'COMPETING',
      timer: '05:00:00',
      depositUnitPrice: 680,
      activity: '200 buyers reached the $680 tier · demand reached $136,000',
      log: '200 buyers reserved $136,000 at their $680 cap · Seller B leads at $680 (Nova $780 · Vertex $680)',
    },
    {
      buyers: 500,
      retail: '$900',
      best: '$590',
      saving: 'You save $310',
      ladder: ['—', '$680', '$590', '$550'],
      offers: ['$620', '$605', '$590'],
      winnerIndex: 2,
      winnerSeller: 'Seller C (Vertex Global)',
      status: 'WON',
      offerStatus: 'WON',
      timer: 'CLOSED',
      depositUnitPrice: 680,
      activity: '500 buyers reached the $590 tier · $45,000 modeled surplus returns',
      finalize: true,
      finalizeAction: 'settleDeal',
      log: '500 modeled buyers reached the $590 tier · $340,000 modeled order → $45,000 modeled surplus · Seller C won at $590',
    },
  ],
  war: [
    {
      buyers: 120,
      retail: '$900',
      best: '$780',
      saving: 'You save $120',
      ladder: ['$780', '$680', '$590'],
      offers: ['$780', '$795', '—'],
      priceTiers: [
        { buyers: 120, price: '$780' },
        { buyers: 200, price: '$680' },
        { buyers: 500, price: '$590' },
      ],
      winnerIndex: 0,
      winnerSeller: 'Seller A (Nova Direct)',
      status: 'OPEN',
      offerStatus: 'COMPETING',
      timer: '05:00:00',
      depositUnitPrice: 780,
      activity: '120 buyers joined · Nova opened at $780',
      log: '120 buyers pooled ($93.6k) · Seller A leads at $780',
    },
    {
      buyers: 200,
      retail: '$900',
      best: '$680',
      saving: 'You save $220',
      ladder: ['$780', '$680', '$590'],
      offers: ['$720', '$680', '$695'],
      priceTiers: [
        { buyers: 120, price: '$780' },
        { buyers: 200, price: '$680' },
        { buyers: 500, price: '$590' },
      ],
      winnerIndex: 1,
      winnerSeller: 'Seller B (Apex Supply)',
      status: 'OPEN',
      offerStatus: 'COMPETING',
      timer: '05:00:00',
      depositUnitPrice: 680,
      activity: '80 buyers joined · Apex entered at $680 · Demand reached $141k',
      log: '200 buyers pooled ($141k retained commitments) · Seller B entered at $680 (Nova $780 · Vertex $695)',
    },
    {
      buyers: 500,
      retail: '$900',
      best: '$560',
      saving: 'You save $340',
      ladder: ['$780', '$680', '$590'],
      offers: ['$780', '$680', '$560'],
      priceTiers: [
        { buyers: 120, price: '$780' },
        { buyers: 200, price: '$680' },
        { buyers: 500, price: '$560' },
      ],
      winnerIndex: 2,
      winnerSeller: 'Seller C (Vertex Global)',
      status: 'WON',
      offerStatus: 'WON',
      timer: 'CLOSED',
      depositUnitPrice: 680,
      activity: '300 buyers joined · Vertex entered at $560 · New best price',
      finalize: true,
      finalizeAction: 'settleDeal',
      log: '500 buyers pooled ($328k committed) · Seller C entered at $560 and won (Saved $340/buyer)',
    },
  ],
  failed: [
    {
      buyers: 500,
      retail: '$900',
      best: '$590',
      saving: 'You save $310',
      ladder: ['$780', '$680', '$590'],
      offers: ['$720', '$680', '$590'],
      winnerIndex: 2,
      winnerSeller: 'Seller C (Vertex Global)',
      status: 'OPEN',
      offerStatus: 'COMPETING',
      timer: '05:00:00',
      depositUnitPrice: 680,
      activity: '500 buyers reached $590 · Seller C wins and locks a $55 delivery guarantee',
      log: 'Seller C won at $590 · price locked · $55 delivery guarantee held until delivery',
    },
    {
      buyers: 500,
      retail: '$900',
      best: '$590',
      saving: 'You save $310',
      ladder: ['$780', '$680', '$590'],
      offers: ['$720', '$680', '$590'],
      // The seller that won the price lock remains the winner until delivery
      // resolves. A cheaper backup is not silently substituted after lock.
      winnerIndex: 2,
      winnerSeller: 'Seller C (Vertex Global)',
      status: 'AWAITING_FULFILLMENT',
      offerStatus: 'LOCKED',
      timer: '05:00:00',
      depositUnitPrice: 680,
      activity: 'Price locked at $590 · Seller C must deliver before payout',
      log: 'Seller C is the locked winner · delivery is still required before payout',
    },
    {
      buyers: 500,
      retail: '$900',
      best: '—',
      saving: 'Buyer funds returned',
      ladder: ['$780', '$680', '$590'],
      offers: ['$720', '$680', 'FAILED'],
      winnerIndex: -1,
      winnerSeller: null,
      status: 'REFUNDED',
      offerStatus: 'CLOSED',
      timer: 'CLOSED',
      depositUnitPrice: 680,
      finalize: true,
      finalizeAction: 'refundDeal',
      reason: 'Seller C failed after price lock. Guarantee forfeited; seller payout and 1% fee are $0.',
      failureType: 'DELIVERY_FAILED',
      log: 'Seller C failed delivery after price lock · seller payout $0 · fee $0 · buyer money returned',
    },
  ],
  refund: [
    {
      buyers: 120,
      retail: '$900',
      best: '—',
      saving: 'No valid seller offer',
      ladder: ['$780', '$680', '$590'],
      offers: ['—', '—', '—'],
      winnerIndex: -1,
      winnerSeller: null,
      status: 'OPEN',
      offerStatus: 'COMPETING',
      timer: '05:00:00',
      depositUnitPrice: 780,
      commitmentPrice: '$780',
      activity: '120 buyers modeled up to $780 · no valid final seller offer',
      log: '120 buyers pooled ($93.6k) · no valid final seller offer before the deadline',
    },
    {
      buyers: 120,
      retail: '$900',
      best: '—',
      saving: 'Buyer funds returned',
      ladder: ['$780', '$680', '$590'],
      offers: ['—', '—', '—'],
      winnerIndex: -1,
      winnerSeller: null,
      status: 'REFUNDED',
      offerStatus: 'CLOSED',
      timer: 'CLOSED',
      depositUnitPrice: 780,
      commitmentPrice: '$780',
      finalize: true,
      finalizeAction: 'refundDeal',
      reason: 'Deadline passed with no valid seller offer. Buyer money was returned; seller payout and fee are $0.',
      failureType: 'NO_VALID_OFFER',
      activity: 'Deadline passed · buyer money returned because no valid seller offer existed',
      log: 'Deadline passed · no valid final seller offer · buyer money returned',
    },
  ],
  business: [
    {
      buyers: 47,
      count: 47,
      demand: '$96,256',
      bestOffer: '−24%',
      offerA: '−18%',
      offerB: '−21%',
      offerC: '−24%',
      winnerId: 'C',
      winnerSupplier: 'Supplier C (Origin Bulk)',
      stage: '47 joined',
      hint: '3 more cafés unlock the next price tier',
      time: '18:51',
      activity: '47 cafés pooled in wholesale coffee order ($96,256/mo) · 3 suppliers competing',
      log: '47 cafés pooled in wholesale coffee order ($96,256/mo) · 3 suppliers competing',
    },
    {
      buyers: 48,
      count: 48,
      demand: '$98,304',
      bestOffer: '−24%',
      offerA: '−18%',
      offerB: '−21%',
      offerC: '−24%',
      winnerId: 'C',
      winnerSupplier: 'Supplier C (Origin Bulk)',
      stage: '48 joined',
      hint: '2 more cafés unlock the next price tier',
      time: '18:52',
      activity: 'Cafe #48 joined ($2,048/mo) · Demand reached $98,304/mo',
      log: 'Cafe #48 joined ($2,048/mo) · Demand reached $98,304/mo',
    },
    {
      buyers: 49,
      count: 49,
      demand: '$100,352',
      bestOffer: '−25%',
      offerA: '−18%',
      offerB: '−25%',
      offerC: '−24%',
      winnerId: 'B',
      winnerSupplier: 'Supplier B (BeanCraft)',
      stage: '49 joined',
      hint: '1 more café unlocks the next price tier',
      time: '18:53',
      activity: 'Demand crossed $100k/mo · Supplier B undercut to −25%',
      log: 'Demand crossed $100k/mo · Supplier B undercut to −25%',
    },
    {
      buyers: 50,
      count: 50,
      demand: '$102,400',
      bestOffer: '−27%',
      offerA: '−18%',
      offerB: '−25%',
      offerC: '−27%',
      winnerId: 'C',
      winnerSupplier: 'Supplier C (Origin Bulk)',
      stage: '50 joined (wholesale unlocked)',
      hint: '50-café wholesale tier unlocked (−27%)',
      time: '18:54',
      activity: '50-café tier unlocked ($102,400/mo) · Best offer improved to −27%',
      log: '50-café tier unlocked ($102,400/mo) · Best offer improved to −27%',
    },
    {
      buyers: 50,
      count: 50,
      demand: '$102,400',
      bestOffer: '−27%',
      offerA: '−18%',
      offerB: '−25%',
      offerC: '−27%',
      winnerId: 'C',
      winnerSupplier: 'Supplier C (Origin Bulk)',
      stage: '50 joined (wholesale unlocked)',
      hint: '50-café wholesale tier unlocked (−27%)',
      time: '18:55',
      activity: 'Supplier C won the 50-café wholesale contract at −27%',
      log: 'Supplier C won the 50-café wholesale contract at −27%',
      finalize: true,
      finalizeAction: 'settleBusinessPool',
    },
  ],
  request: [
    {
      buyers: 1,
      offers: 0,
      price: '$700',
      bestPrice: '$700',
      savings: '$0',
      time: '18:51',
      meta: '1 buyer · $1k · 10:00 left',
      activity: 'Request created: Laptop under $700 · Buyer #1 joined',
      log: 'Request created: Laptop under $700 · Buyer #1 joined',
    },
    {
      buyers: 48,
      offers: 0,
      price: '$700',
      bestPrice: '$700',
      savings: '$0',
      time: '18:52',
      meta: '48 buyers · $34k · 09:30 left',
      activity: '48 buyers joined request pool · Wholesale demand unlocked',
      log: '48 buyers joined request pool · Wholesale demand unlocked',
    },
    {
      buyers: 120,
      offers: 2,
      price: '$690',
      bestPrice: '$690',
      savings: '$10',
      winnerId: 'A',
      winnerSupplier: 'Seller A (Nova Direct)',
      time: '18:53',
      meta: '120 buyers · $83k · 09:00 left',
      activity: 'Seller A offered $690 · Cap undercut by $10',
      log: 'Seller A offered $690 · Cap undercut by $10',
    },
    {
      buyers: 210,
      offers: 4,
      price: '$620',
      bestPrice: '$620',
      savings: '$80',
      winnerId: 'B',
      winnerSupplier: 'Seller B (Apex Supply)',
      time: '18:54',
      meta: '210 buyers · $130k · 08:45 left',
      activity: 'Seller B offered $620 · Save $80 per unit',
      log: 'Seller B offered $620 · Save $80 per unit',
    },
    {
      buyers: 300,
      offers: 7,
      price: '$520',
      bestPrice: '$520',
      savings: '$180',
      winnerId: 'C',
      winnerSupplier: 'Seller C (Vertex Global)',
      time: '18:55',
      meta: '300 buyers · $156k · 08:19 left',
      activity: 'Seller C offered $520 · New best offer',
      log: 'Seller C offered $520 · New best offer',
    },
    {
      buyers: 300,
      offers: 7,
      price: '$520',
      bestPrice: '$520',
      savings: '$180',
      winnerId: 'C',
      winnerSupplier: 'Seller C (Vertex Global)',
      time: '18:56',
      meta: '300 buyers · $156k · Offer accepted',
      activity: 'Offer accepted: Seller C at $520 · Buyers save $180 each',
      log: 'Offer accepted: Seller C at $520 · Buyers save $180 each',
      finalize: true,
      finalizeAction: 'settleRequest',
    },
  ],
};

// The phone deal's signature mechanic: a seller publishes binding price tiers
// before buyers commit. Buyers reserve up to $680 once; when the funded count
// reaches each threshold, the lower published tier becomes the active price automatically.
const PHONE_SELLER_LADDER = {
  seller: 'Seller C (Vertex Global)',
  maxBuyerPrice: '$680',
  capacity: 800,
  expiry: '24h',
  delivery: '7 days',
  guarantee: '$55 minimum seller guarantee for this 800-item ladder',
  tiers: [
    { buyers: 200, price: '$680', priceCents: 68000, capacity: 800, delivery: '7 days', status: 'ACTIVE' },
    { buyers: 500, price: '$590', priceCents: 59000, capacity: 800, delivery: '7 days', status: 'NEXT' },
    { buyers: 800, price: '$550', priceCents: 55000, capacity: 800, delivery: '7 days', status: 'NEXT' },
  ],
};
for (const step of SCENARIO_DEFINITIONS.normal) {
  step.sellerLadder = PHONE_SELLER_LADDER;
  step.commitmentPrice = '$680';
  step.buyerMaxPrice = '$680';
}

// --------------------------------------------------------------------------
// Initial State
// --------------------------------------------------------------------------

const SCENARIOS = Market.compileScenarios(SCENARIO_DEFINITIONS);
// The first screen should feel like a market people can still join. The
// completed 500-buyer result remains available when the scenario is run.
// The example opens at the first meaningful price tier. The Play example
// action then makes the buyer growth, seller competition and lower tier visible.
const DEFAULT_DEAL_STEP = SCENARIOS.normal[1];
function getDefaultState() {
  const activeIds = generateSessionIds();
  const recoveredLiveDemo = loadLiveDemoSnapshot();
  const latestLiveProof = loadLatestLiveProof();
  const historicalLiveProof = loadHistoricalLiveProof();
  const canonicalDeal = DEFAULT_DEAL_STEP;
  return {
    mode: 'SIMULATED',
    activeIds,
    sellers: {
      A: { name: 'Seller A (Nova Direct)', address: sellerWallets.A.address },
      B: { name: 'Seller B (Apex Supply)', address: sellerWallets.B.address },
      C: { name: 'Seller C (Vertex Global)', address: sellerWallets.C.address },
    },
    suppliers: {
      A: { name: 'Supplier A (RoastWorks)', address: supplierWallets.A.address },
      B: { name: 'Supplier B (BeanCraft)', address: supplierWallets.B.address },
      C: { name: 'Supplier C (Origin Bulk)', address: supplierWallets.C.address },
    },
    tempoNetwork: {
      name: 'Tempo Testnet (Moderato)',
      chainId: TEMPO_CHAIN_ID,
      rpc: TEMPO_RPC,
      explorer: TEMPO_EXPLORER,
      contract: CONTRACT_ADDRESS,
      contractVersion: deployedConfig.contractVersion || 0,
      livePaymentsEnabled: false,
      pathUsdDecimals: PATH_USD_DECIMALS,
      treasury: activeWallet ? activeWallet.address : null,
      currency: 'USD (PathUSD)',
      status: activeWallet ? 'CONNECTED' : 'STANDBY',
    },
    deal: {
      ...canonicalDeal,
      dealId: activeIds.dealId,
      title: 'Phone group order',
      retail: '$900',
      ladder: ['—', '$680', '$590', '$550'],
      sellerLadder: PHONE_SELLER_LADDER,
      buyerMaxPrice: '$680',
      depositUnitPrice: 680,
      paymentLedger: canonicalDeal.paymentLedger,
      log: [
        ['12:05', '300 more buyers unlock the $590 tier · unused commitment returns at the final price'],
        ['12:04', 'Seller B (Apex Supply) leads at the current $680 price'],
        ['12:03', 'Seller competition is open for the modeled order'],
        ['12:00', `500 modeled buyers reached the $590 tier · $45,000 modeled surplus at the final price (${activeIds.dealId})`],
      ],
    },
    business: {
      poolId: activeIds.poolId,
      title: 'Coffee supplies',
      buyers: 47,
      unitCommitmentUsd: CAFE_MONTHLY_COMMITMENT_USD,
      demand: '$96,256',
      offer: '−24%',
      offerA: '−18%',
      offerB: '−21%',
      offerC: '−24%',
      winnerId: 'C',
      winnerSupplier: 'Supplier C (Origin Bulk)',
      stage: '47 joined',
      status: 'COMPETING',
      timer: '02:46',
      log: [
        ['18:55', 'Best offer improved to −24% · Supplier C leading'],
        ['18:54', 'Supplier B offered −21%'],
        ['18:53', 'Supplier A offered −18%'],
        ['18:52', 'Demand reached $96k/mo · 3 suppliers competing'],
        ['18:51', '47 cafés pooled in wholesale coffee order'],
      ],
    },
    requests: [
      {
        id: activeIds.laptopReqId,
        need: 'Laptop under $700',
        buyers: 300,
        maxPrice: '$700',
        bestPrice: '$520',
        winnerId: 'C',
        winnerSupplier: 'Seller C (Vertex Global)',
        offers: 7,
        savings: '$180',
        meta: '300 buyers · $156k · 08:19 left',
        status: 'OPEN',
      },
      {
        id: activeIds.crmReqId,
        need: 'CRM under $30 / user',
        buyers: 120,
        maxPrice: '$30',
        bestPrice: '$19',
        winnerId: 'B',
        winnerSupplier: 'Seller B (Apex Supply)',
        offers: 3,
        savings: '$11',
        meta: '120 buyers · $2k · 08:19 left',
        status: 'OPEN',
      },
    ],
    requestLog: [['12:04', 'Best offer is $520 — $180 below the $700 buyer cap.']],
    liveDemo: recoveredLiveDemo,
    latestLiveProof: latestLiveProof || (isLiveProofDisplayable(recoveredLiveDemo) && recoveredLiveDemo.chainVerified === true ? recoveredLiveDemo : null),
    historicalLiveProof,
    liveProofUsed: Boolean(recoveredLiveDemo),
    transactions: [],
  };
}

globalState = loadProductStateSnapshot() || getDefaultState();
state.generation = randomUUID();
// A persisted presentation snapshot can outlive a contract redeployment.
// Never let an open proof from an older contract block reset or appear as the
// current LIVE run. It remains available only through the historical proof
// view, while the current deployment starts with a clean recovery state.
if (state.liveDemo && !liveDemoUsesCurrentContract(state.liveDemo)) {
  state.liveDemo = null;
  state.latestLiveProof = null;
  state.liveProofUsed = false;
}
// A persisted product snapshot may outlive a contract deployment. Refresh the
// public network facts from the current runtime so the UI/API never pairs a
// v17 proof with an old contract address.
state.tempoNetwork = {
  ...state.tempoNetwork,
  name: 'Tempo Testnet (Moderato)',
  chainId: TEMPO_CHAIN_ID,
  rpc: TEMPO_RPC,
  explorer: TEMPO_EXPLORER,
  contract: CONTRACT_ADDRESS,
  contractVersion: deployedConfig.contractVersion || 0,
  pathUsdDecimals: PATH_USD_DECIMALS,
  treasury: activeWallet ? activeWallet.address : state.tempoNetwork?.treasury || null,
  currency: 'USD (PathUSD)',
  status: activeWallet ? 'CONNECTED' : 'STANDBY',
};
const persistedDealId = state.deal?.dealId || state.activeIds?.dealId;
state.deal = {
  ...state.deal,
  ...DEFAULT_DEAL_STEP,
  dealId: persistedDealId,
  title: 'Phone group order',
  sellerLadder: PHONE_SELLER_LADDER,
};
state.deal.cohorts = DEFAULT_DEAL_STEP.cohorts;
state.deal.accounting = DEFAULT_DEAL_STEP.accounting;
// The default view is always the open 200-buyer example. Do not let a stale
// persisted snapshot bring back the old completed-500-buyer activity entry.
state.deal.log = DEFAULT_DEAL_STEP.log;
// Keep the persisted presentation model aligned with the contract rule. A
// stale snapshot must not reintroduce outdated seller-guarantee copy.
state.deal.sellerLadder = PHONE_SELLER_LADDER;
let globalCurrentRun = null;
void verifyLatestLiveProofSnapshot();

function requiredId(value) {
  if (typeof value !== 'string' || !/^[\w-]{1,120}$/.test(value)) throw new Error('Explicit valid market ID is required');
  return value;
}
function resetState() {
  if (liveDealNeedsRecovery(state.liveDemo)) {
    const error = new Error('LIVE deal is still open. Refund or settle it before resetting the simulation.');
    error.statusCode = 409;
    throw error;
  }
  // Reset only the presentation model. Keep the product registry and its
  // market IDs stable so “Start over” can never orphan a real commitment,
  // seller offer, or user-created request. A reset is not a new market.
  const previous = state;
  const next = freshPublicState();
  next.activeIds = previous.activeIds;
  next.deal.dealId = previous.activeIds.dealId;
  next.business.poolId = previous.activeIds.poolId;
  next.requests = previous.requests;
  next.business = previous.business;
  next.sellers = previous.sellers;
  next.suppliers = previous.suppliers;
  replaceActiveState(next);
  // Reset starts a new presentation run. Do not attach the previous deal's
  // proof to the new IDs; the durable snapshot remains available for an
  // explicit recovery after restart, but it is not mixed into this run.
  state.liveDemo = null;
  state.latestLiveProof = null;
  state.liveProofUsed = false;
  persistLiveDemo(null);
  state.generation = randomUUID();
  state.deal.cohorts = DEFAULT_DEAL_STEP.cohorts;
  state.deal.accounting = DEFAULT_DEAL_STEP.accounting;
  replaceCurrentRun(null);
  return state;
}

function usdFromCents(value) {
  const cents = Math.max(0, Number(value || 0));
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

// A confirmed user action becomes part of the shared marketplace registry.
// This keeps a newly-created request or offer visible after refresh and to
// other visitors; the transaction receipt remains the source of truth for
// the money itself.
function reflectConfirmedProductAction(action, payload = {}) {
  if (!state || !payload) return;
  if (action === 'createRequest') {
    const requestId = requiredId(payload.requestId);
    const title = String(payload.title || '').trim();
    const maxPriceCents = Number(payload.targetPriceCents || 0);
    if (!title || maxPriceCents <= 0) return;
    const request = {
      id: requestId,
      need: title,
      buyers: 1,
      maxPrice: usdFromCents(maxPriceCents),
      bestPrice: usdFromCents(maxPriceCents),
      winnerId: null,
      winnerSupplier: null,
      offers: 0,
      savings: '$0',
      meta: `1 buyer · ${usdFromCents(maxPriceCents)} maximum · open`,
      status: 'OPEN',
      source: 'LIVE_TEMPO',
    };
    state.requests = [request, ...(state.requests || []).filter((entry) => entry.id !== requestId)];
    state.requestLog = [[new Date().toISOString().slice(11, 16), `Request created on Tempo · ${title}`], ...(state.requestLog || [])].slice(0, 20);
    return;
  }
  if (action === 'joinRequest') {
    const request = (state.requests || []).find((entry) => entry.id === payload.requestId);
    if (request) {
      request.buyers = Number(request.buyers || 0) + 1;
      request.meta = `${request.buyers} buyers · ${request.maxPrice} maximum · open`;
    }
    return;
  }
  if (action === 'joinDeal' && state.deal?.dealId === payload.dealId) {
    state.deal.buyers = Number(state.deal.buyers || 0) + Number(payload.quantity || 1);
    state.deal.meta = `${state.deal.buyers} funded buyers · live Tempo demand`;
    return;
  }
  if (action === 'joinBusinessPool' && state.business?.poolId === payload.poolId) {
    state.business.buyers = Number(state.business.buyers || 0) + 1;
    state.business.stage = `${state.business.buyers} joined`;
    return;
  }
  if (action === 'submitOffer' && payload.marketType === 'request') {
    const request = (state.requests || []).find((entry) => entry.id === payload.targetId);
    if (!request) return;
    const priceCents = Number(payload.priceCents || 0);
    request.offers = Number(request.offers || 0) + 1;
    if (priceCents > 0 && (!request.bestPrice || Number(request.bestPrice.replace(/[$,]/g, '')) * 100 > priceCents)) {
      request.bestPrice = usdFromCents(priceCents);
      request.savings = usdFromCents(Math.max(0, Number(request.maxPrice.replace(/[$,]/g, '')) * 100 - priceCents));
    }
    request.meta = `${request.buyers} buyers · ${request.offers} offers · open`;
  }
}
function scenarioStep(body) {
  const { scenario, runId, generation } = body;
  const index = Number(body.stepIndex);
  const steps = SCENARIOS[scenario];
  let currentRun = activeCurrentRun();
  if (generation !== state.generation) throw new Error('Stale generation');
  if (!steps || !Number.isInteger(index) || index < 0 || index >= steps.length || typeof runId !== 'string') throw new Error('Invalid scenario step');
  // The preview has its own scenario state and IDs. It can be watched while a
  // separate real payment is waiting for delivery or refund; only resetState
  // remains blocked so an unresolved live record can never be erased.
  if (index === 0 && (!currentRun || currentRun.id !== runId)) {
    if (currentRun?.retired?.includes(runId)) throw new Error('Stale run');
    currentRun = { id: runId, scenario, index: -1, responses: [], retired: [...(currentRun?.retired || []), ...(currentRun ? [currentRun.id] : [])] };
    replaceCurrentRun(currentRun);
    const fresh = generateSessionIds();
    if (scenario === 'business') state.activeIds.poolId = fresh.poolId;
    else if (scenario === 'request') {
      const request = state.requests.find((entry) => entry.id === state.activeIds.laptopReqId);
      state.activeIds.laptopReqId = fresh.laptopReqId;
      if (request) request.id = fresh.laptopReqId;
    } else state.activeIds.dealId = fresh.dealId;
    state.deal.dealId = state.activeIds.dealId;
    state.business.poolId = state.activeIds.poolId;
  }
  if (!currentRun || currentRun.id !== runId || currentRun.scenario !== scenario) throw new Error('Stale run');
  if (currentRun.responses[index]) return currentRun.responses[index];
  if (index !== currentRun.index + 1) throw new Error('Scenario steps must run in order');
  const data = steps[index];
  if (index === 0 && scenario !== 'business' && scenario !== 'request') {
    // A new deal scenario must not inherit failure/refund fields from the
    // previous run. Start from the clean presentation model, then apply the
    // selected scenario's first step.
    const freshDeal = getDefaultState().deal;
    state.deal = { ...freshDeal, dealId: state.activeIds.dealId };
  }
  if (scenario === 'business') Object.assign(state.business, data, { offer: data.bestOffer, buyers: data.count || data.buyers });
  else if (scenario === 'request') {
    const request = state.requests.find((entry) => entry.id === state.activeIds.laptopReqId);
    if (!request) throw new Error('Scenario request was not found');
    Object.assign(request, data);
  } else Object.assign(state.deal, data);
  const response = structuredClone({ success: true, stepData: data, deal: state.deal, business: state.business, requests: state.requests,
    activeIds: state.activeIds, generation: state.generation, runId, mode: 'SIMULATED', step: index, totalSteps: steps.length, isFinished: index === steps.length - 1 });
  currentRun.index = index;
  currentRun.responses[index] = response;
  replaceCurrentRun(currentRun);
  return response;
}

// --------------------------------------------------------------------------
// On-Chain Settlement & Refund Helpers (Dynamic amounts + Real Winning Seller)
// --------------------------------------------------------------------------
function requireOpen(record) {
  if (record.isSettled || record.isRefunded) throw new Error('Market is already closed; ID will not be replaced');
}
function chunkRecipients(recipients) {
  const chunks = [];
  for (let index = 0; index < recipients.length; index += LIVE_RECIPIENT_BATCH_MAX) {
    chunks.push(recipients.slice(index, index + LIVE_RECIPIENT_BATCH_MAX));
  }
  return chunks;
}
async function deployedHasFunction(name) {
  const entry = Array.isArray(deployedConfig.abi)
    ? deployedConfig.abi.find((item) => item?.type === 'function' && item?.name === name)
    : null;
  if (!entry) return false;
  // ABI presence is only a description. Verify the deployed runtime actually
  // contains the function selector before enabling a LIVE action.
  const signature = `${name}(${(entry.inputs || []).map((input) => input.type).join(',')})`;
  const selector = ethers.id(signature).slice(2, 10).toLowerCase();
  if (deployedConfig.architecture === 'dealarena-fixed-modules-v1') {
    const module = deployedConfig.modules?.find((item) => item.selectors?.some((value) => value.toLowerCase() === `0x${selector}`));
    if (module) {
      const code = await provider.getCode(module.address);
      return code !== '0x' && ethers.keccak256(code) === module.codeHash && code.toLowerCase().includes(selector);
    }
  }
  const code = await provider.getCode(CONTRACT_ADDRESS);
  return code !== '0x' && code.toLowerCase().includes(selector);
}
function requireNativeBatchSize(count, label, fixedCalls = 1) {
  if (count < 1) throw new Error(`No ${label} commitments exist on-chain`);
  const recipientCalls = Math.ceil(count / LIVE_RECIPIENT_BATCH_MAX);
  if (fixedCalls + recipientCalls > LIVE_NATIVE_BATCH_MAX) {
    throw new Error(`LIVE_LIMIT: ${label} needs ${fixedCalls + recipientCalls} native batch calls; the Tempo batch limit is ${LIVE_NATIVE_BATCH_MAX}.`);
  }
  return recipientCalls;
}
async function performDealSettlement(payload = {}) {
  const dealId = requiredId(payload.dealId);
  let onChain = await escrowContract.getDealState(dealId);
  requireOpen(onChain);
  // Close against the chain's actual deadline/final window. Calling
  // settleDeal() before that point is not a valid close attempt; after the
  // deadline the single deterministic entry point is finalizeDealAfterDeadline.
  let timing = await escrowContract.getDealTimingState(dealId);
  try {
    const finalBiddingEndsAt = Number(timing.finalBiddingEndsAt);
    const marketDeadline = Number(timing.marketDeadline);
    const closeAt = finalBiddingEndsAt > 0 ? finalBiddingEndsAt : marketDeadline;
    const waitMs = Math.max(0, (closeAt - Math.floor(Date.now() / 1000) + 1) * 1000);
    if (waitMs > 15_000) throw new Error('Deal is still open; settlement will be available at its deadline');
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 15_000)));
  } catch {
    // A missing timing view is not permission to submit the wrong close call.
    throw new Error('Deal timing is unavailable; settlement was not submitted');
  }
  onChain = await escrowContract.getDealState(dealId);
  timing = await escrowContract.getDealTimingState(dealId);
  requireOpen(onChain);
  const price = BigInt(onChain.bestPrice), buyerCount = BigInt(onChain.buyersCount);
  if (!buyerCount || !price || onChain.bestSeller === ethers.ZeroAddress) throw new Error('No funded winning order exists on-chain');
  if (payload.finalPriceCents !== undefined && centsToPathUsdUnits(payload.finalPriceCents) !== price) throw new Error('Winning price does not match chain');
  if (payload.expectedSeller && payload.expectedSeller.toLowerCase() !== onChain.bestSeller.toLowerCase()) throw new Error('Winning seller does not match chain');
  const committedBuyers = await escrowContract.getDealBuyers(dealId);
  const buyerChunks = chunkRecipients(committedBuyers);
  requireNativeBatchSize(committedBuyers.length, 'deal', 1);
  const funding = await escrowContract.getDealFundingState(dealId);
  const fundedBuyerCount = BigInt(funding.fundedBuyers);
  const totalUnits = BigInt(funding.fundedUnits);
  if (!fundedBuyerCount || !totalUnits) throw new Error('No fully funded buyers remain at the selected price');
  if (!totalUnits || BigInt(onChain.totalEscrow) < totalUnits * price) throw new Error('Insufficient escrow for the selected units');
  const afterDeadline = Number(timing.marketDeadline) > 0 && Math.floor(Date.now() / 1000) > Number(timing.marketDeadline);
  const closeMethod = afterDeadline ? 'finalizeDealAfterDeadline' : 'settleDeal';
  const calls = [
    nativeContractCall(closeMethod, afterDeadline ? [dealId, 'Deal deadline reached'] : [dealId]),
    ...buyerChunks.map((recipients) => nativeContractCall('disburseSurplusBatch', [dealId, recipients])),
  ];
  const grossUnits = totalUnits * price;
  const platformFeeUnits = grossUnits / 100n;
  const committedUnits = BigInt(onChain.totalEscrow);
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_SETTLEMENT', 'Deal settlement + surplus disbursement', '', {
     dealId, unitPriceCents: price.toString(), buyersCount: fundedBuyerCount.toString(), joinedBuyersCount: buyerCount.toString(), totalUnits: totalUnits.toString(), winningSellerAddress: onChain.bestSeller,
    paymentMemo: paymentMemo(dealId, 'settlement'),
    settlementSummary: {
      committedCents: Number(committedUnits / PATH_USD_UNITS_PER_CENT),
      totalUnits: Number(totalUnits),
      unitPriceCents: Number(price / PATH_USD_UNITS_PER_CENT),
      grossOrderCents: Number(grossUnits / PATH_USD_UNITS_PER_CENT),
      finalPriceCents: Number(price / PATH_USD_UNITS_PER_CENT),
      sellerPayoutCents: Number((grossUnits - platformFeeUnits) / PATH_USD_UNITS_PER_CENT),
      feeCents: Number(platformFeeUnits / PATH_USD_UNITS_PER_CENT),
      buyerRefundCents: Number((committedUnits - grossUnits) / PATH_USD_UNITS_PER_CENT),
    },
  });
}
async function performDealRefund(payload = {}) {
  const dealId = requiredId(payload.dealId);
  const record = await escrowContract.getDealState(dealId);
  requireOpen(record);
  if (!BigInt(record.buyersCount)) throw new Error('No buyer commitments exist on-chain');
  const committedBuyers = await escrowContract.getDealBuyers(dealId);
  const buyerChunks = chunkRecipients(committedBuyers);
  if (payload.sellerFailed === true && BigInt(record.sellerGuaranteeBond) > 0n) {
    // First remove the failed seller and refresh the offer book on-chain.
    // A failed seller must not atomically force a refund before we have checked
    // whether a valid backup offer can still carry the funded order.
    const slash = await executeTempoNativeBatch([
      nativeContractCall('slashSellerGuarantee', [dealId, String(payload.reason || 'Seller failed before price lock')]),
    ], 'TEMPO_NATIVE_SELLER_FAILURE', 'Failed seller removed; checking backup offer', '', {
      dealId, buyersCount: committedBuyers.length, paymentMemo: paymentMemo(dealId, 'seller-failure'),
    });
    const afterSlash = await escrowContract.getDealState(dealId);
    if (afterSlash.bestSeller !== ethers.ZeroAddress && BigInt(afterSlash.bestPrice) > 0n) {
      const timing = await escrowContract.getDealTimingState(dealId);
      const now = Math.floor(Date.now() / 1000);
      const closeAt = Number(timing.finalBiddingEndsAt) || Number(timing.marketDeadline);
      if (closeAt > 0 && now >= closeAt) {
        return performDealSettlement({ dealId, expectedSeller: afterSlash.bestSeller });
      }
      return slash;
    }
    // No backup exists yet. Keep the deal open until its deadline; the single
    // deadline finalizer will settle a later backup or start the refund.
    return slash;
  }
  requireNativeBatchSize(committedBuyers.length, 'deal', 1);
  const calls = [];
  calls.push(nativeContractCall('refundDeal', [dealId, payload.reason || 'Market did not complete']));
  calls.push(...buyerChunks.map((recipients) => nativeContractCall('refundBatch', [dealId, recipients])));
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_REFUND', 'Deal refund + buyer refund batch', '', {
    dealId, buyersCount: committedBuyers.length, paymentMemo: paymentMemo(dealId, 'refund'),
  });
}
async function performDealFulfillment(payload = {}) {
  const dealId = requiredId(payload.dealId);
  const record = await escrowContract.getDealState(dealId);
  if (!record.isSettled || record.isRefunded) throw new Error('Deal must be settled and awaiting fulfillment confirmation');
  if (BigInt(record.sellerGuaranteeBond) <= 0n) throw new Error('Seller guarantee is already released or slashed');
  return executeTempoTx(() => escrowContract.confirmDealFulfillment.populateTransaction(dealId), 'TEMPO_FULFILLMENT_CONFIRMATION', 'Seller fulfillment confirmed; guarantee released', '', 0n, {
    dealId, paymentMemo: paymentMemo(dealId, 'fulfillment'),
  });
}
async function performDealGuaranteeSlash(payload = {}) {
  const dealId = requiredId(payload.dealId);
  const record = await escrowContract.getDealState(dealId);
  if (!record.isSettled || record.isRefunded) throw new Error('Deal must be settled and awaiting fulfillment resolution');
  if (BigInt(record.sellerGuaranteeBond) <= 0n) throw new Error('Seller guarantee is already released or slashed');
  if (Number(deployedConfig.contractVersion) >= LIVE_SECURITY_VERSION) {
    const buyers = await escrowContract.getDealBuyers(dealId);
    const buyerChunks = chunkRecipients(buyers);
    requireNativeBatchSize(buyers.length, 'deal', 1);
    const settlement = await escrowContract.getDealSettlementState(dealId);
    const previousSummary = state.liveDemo?.liveDealId === dealId ? state.liveDemo.settlementSummary : null;
    const grossOrderCents = Number(BigInt(settlement.settledGrossVolume) / PATH_USD_UNITS_PER_CENT);
    const buyerRefundCents = previousSummary
      ? Number(previousSummary.buyerRefundCents || 0) + grossOrderCents
      : grossOrderCents;
    return executeTempoNativeBatch([
      nativeContractCall('slashSettledDealGuarantee', [dealId, String(payload.reason || 'Seller failed to fulfill the order')]),
      ...buyerChunks.map((recipients) => nativeContractCall('refundBatch', [dealId, recipients])),
    ], 'TEMPO_NATIVE_FULFILLMENT_FAILURE', 'Seller failure + buyer refund batch', '',  {
      dealId, buyersCount: buyers.length, paymentMemo: paymentMemo(dealId, 'refund'),
      settlementSummary: {
        committedCents: previousSummary?.committedCents || grossOrderCents,
        totalUnits: previousSummary?.totalUnits || Number(BigInt(settlement.settledGrossVolume) / BigInt(record.bestPrice || 1)),
        unitPriceCents: previousSummary?.unitPriceCents || Number(BigInt(record.bestPrice) / PATH_USD_UNITS_PER_CENT),
        grossOrderCents,
        finalPriceCents: previousSummary?.finalPriceCents || Number(BigInt(record.bestPrice) / PATH_USD_UNITS_PER_CENT),
        sellerPayoutCents: 0,
        feeCents: 0,
        buyerRefundCents,
      },
    });
  }
  return executeTempoTx(() => escrowContract.slashSettledDealGuarantee.populateTransaction(
    dealId,
    String(payload.reason || 'Seller failed to fulfill the order'),
  ), 'TEMPO_FULFILLMENT_FAILURE', 'Seller guarantee slashed after failed fulfillment', '', 0n, {
    dealId, paymentMemo: paymentMemo(dealId, 'fulfillment-failure'),
  });
}
async function performDealTimeoutRefund(payload = {}) {
  const dealId = requiredId(payload.dealId);
  const record = await escrowContract.getDealState(dealId);
  if (!record.isSettled || record.isRefunded) throw new Error('Deal must be settled and awaiting fulfillment resolution');
  const timing = await escrowContract.getDealTimingState(dealId);
  if (!timing.fulfillmentDeadline || BigInt(timing.fulfillmentDeadline) >= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error('Seller fulfillment deadline has not passed');
  }
  const buyers = await escrowContract.getDealBuyers(dealId);
  const buyerChunks = chunkRecipients(buyers);
  requireNativeBatchSize(buyers.length, 'deal', 1);
  return executeTempoNativeBatch([
    nativeContractCall('refundDealAfterFulfillmentDeadline', [dealId, String(payload.reason || 'Seller did not confirm delivery in time')]),
    ...buyerChunks.map((recipients) => nativeContractCall('refundBatch', [dealId, recipients])),
  ], 'TEMPO_NATIVE_FULFILLMENT_TIMEOUT', 'Fulfillment deadline passed; buyer refund batch', '', {
    dealId, buyersCount: buyers.length, paymentMemo: paymentMemo(dealId, 'fulfillment-timeout'),
  });
}
async function performBusinessFulfillment(payload = {}) {
  requiredId(payload.poolId);
  const poolId = requiredId(payload.poolId);
  const record = await escrowContract.businessPools(poolId);
  if (!record.isSettled || record.isRefunded) throw new Error('Business pool must be settled and awaiting fulfillment confirmation');
  if (BigInt(record.supplierGuaranteeBond) <= 0n) throw new Error('Supplier guarantee is already released or slashed');
  const buyers = await escrowContract.getBusinessBuyers(poolId);
  const chunks = chunkRecipients(buyers);
  requireNativeBatchSize(buyers.length, 'business', 1);
  return executeTempoNativeBatch([
    ...chunks.map((recipients) => nativeContractCall('disburseBusinessSavings', [poolId, recipients])),
    nativeContractCall('confirmSupplierFulfillment', [1, poolId]),
  ], 'TEMPO_NATIVE_BUSINESS_FULFILLMENT', 'Business savings returned; supplier fulfillment confirmed', '', {
    poolId, buyersCount: buyers.length, paymentMemo: paymentMemo(poolId, 'fulfillment'),
  });
}
async function performRequestFulfillment(payload = {}) {
  requiredId(payload.requestId);
  const requestId = requiredId(payload.requestId);
  const record = await escrowContract.demandRequests(requestId);
  if (!record.isSettled || record.isRefunded) throw new Error('Request must be settled and awaiting fulfillment confirmation');
  if (BigInt(record.supplierGuaranteeBond) <= 0n) throw new Error('Supplier guarantee is already released or slashed');
  const buyers = await escrowContract.getRequestBuyers(requestId);
  const chunks = chunkRecipients(buyers);
  requireNativeBatchSize(buyers.length, 'request', 1);
  return executeTempoNativeBatch([
    ...chunks.map((recipients) => nativeContractCall('disburseRequestSurplusBatch', [requestId, recipients])),
    nativeContractCall('confirmSupplierFulfillment', [2, requestId]),
  ], 'TEMPO_NATIVE_REQUEST_FULFILLMENT', 'Request surplus returned; supplier fulfillment confirmed', '', {
    requestId, buyersCount: buyers.length, paymentMemo: paymentMemo(requestId, 'fulfillment'),
  });
}
async function performBusinessSupplierFailure(payload = {}) {
  const poolId = requiredId(payload.poolId);
  if (!(await deployedHasFunction('slashSettledSupplierGuarantee'))) {
    throw new Error('Supplier failure refund needs the redeployed escrow with the post-settlement recovery action; the configured Tempo deployment does not expose it yet.');
  }
  const record = await escrowContract.businessPools(poolId);
  if (!record.isSettled || record.isRefunded) throw new Error('Business pool must be settled and awaiting supplier failure resolution');
  if (BigInt(record.supplierGuaranteeBond) <= 0n) throw new Error('Supplier guarantee is already released or slashed');
  const buyers = await escrowContract.getBusinessBuyers(poolId);
  const chunks = chunkRecipients(buyers);
  requireNativeBatchSize(buyers.length, 'business', 1);
  const fulfillmentDeadline = BigInt(await escrowContract.businessFulfillmentDeadlines(poolId));
  const timedOut = fulfillmentDeadline > 0n && BigInt(Math.floor(Date.now() / 1000)) > fulfillmentDeadline;
  return executeTempoNativeBatch([
    ...chunks.map((recipients) => nativeContractCall('disburseBusinessSavings', [poolId, recipients])),
    nativeContractCall(timedOut ? 'slashBusinessSupplierAfterFulfillmentDeadline' : 'slashSettledSupplierGuarantee', timedOut
      ? [poolId, String(payload.reason || 'Supplier missed the delivery deadline')]
      : [1, poolId, String(payload.reason || 'Supplier failed after settlement')]),
    ...chunks.map((recipients) => nativeContractCall('refundBusinessBatch', [poolId, recipients])),
  ], 'TEMPO_NATIVE_BUSINESS_FAILURE_REFUND', 'Supplier failure + business buyer refund batch', '', {
    poolId, buyersCount: buyers.length, paymentMemo: paymentMemo(poolId, 'refund'),
  });
}
async function performRequestSupplierFailure(payload = {}) {
  const requestId = requiredId(payload.requestId);
  if (!(await deployedHasFunction('slashSettledSupplierGuarantee'))) {
    throw new Error('Supplier failure refund needs the redeployed escrow with the post-settlement recovery action; the configured Tempo deployment does not expose it yet.');
  }
  const record = await escrowContract.demandRequests(requestId);
  if (!record.isSettled || record.isRefunded) throw new Error('Request must be settled and awaiting supplier failure resolution');
  if (BigInt(record.supplierGuaranteeBond) <= 0n) throw new Error('Supplier guarantee is already released or slashed');
  const buyers = await escrowContract.getRequestBuyers(requestId);
  const chunks = chunkRecipients(buyers);
  requireNativeBatchSize(buyers.length, 'request', 1);
  const fulfillmentDeadline = BigInt(await escrowContract.requestFulfillmentDeadlines(requestId));
  const timedOut = fulfillmentDeadline > 0n && BigInt(Math.floor(Date.now() / 1000)) > fulfillmentDeadline;
  return executeTempoNativeBatch([
    ...chunks.map((recipients) => nativeContractCall('disburseRequestSurplusBatch', [requestId, recipients])),
    nativeContractCall(timedOut ? 'slashRequestSupplierAfterFulfillmentDeadline' : 'slashSettledSupplierGuarantee', timedOut
      ? [requestId, String(payload.reason || 'Supplier missed the delivery deadline')]
      : [2, requestId, String(payload.reason || 'Supplier failed after settlement')]),
    ...chunks.map((recipients) => nativeContractCall('refundRequestBatch', [requestId, recipients])),
  ], 'TEMPO_NATIVE_REQUEST_FAILURE_REFUND', 'Supplier failure + request buyer refund batch', '', {
    requestId, buyersCount: buyers.length, paymentMemo: paymentMemo(requestId, 'refund'),
  });
}
async function performBusinessPoolSettlement(payload = {}) {
  const poolId = requiredId(payload.poolId);
  const record = await escrowContract.businessPools(poolId);
  requireOpen(record);
  if (!BigInt(record.totalDemand)) throw new Error('No funded business order exists on-chain');
  const deadline = BigInt(await escrowContract.businessDeadlines(poolId));
  let selected = record.bestSupplier === ethers.ZeroAddress ? null : {
    supplier: record.bestSupplier,
    value: record.bestDiscountPercent,
    maxBuyers: await escrowContract.businessSupplierMaxBuyers(poolId),
    offerExpiry: await escrowContract.businessSupplierOfferExpiry(poolId),
  };
  if (selected) {
    const revoked = await escrowContract.sellerRevoked(selected.supplier);
    if (BigInt(selected.offerExpiry) < deadline || BigInt(selected.maxBuyers) < BigInt(record.buyersCount) || revoked) selected = null;
  }
  if (!selected) {
    const backup = await escrowContract.businessBackupOffers(poolId);
    if (backup.supplier !== ethers.ZeroAddress) {
      const revoked = await escrowContract.sellerRevoked(backup.supplier);
      if (BigInt(backup.offerExpiry) >= deadline && BigInt(backup.maxBuyers) >= BigInt(record.buyersCount) && !revoked) selected = backup;
    }
  }
  if (!selected) throw new Error('No funded business supplier offer is available on-chain');
  if (payload.discountPercent !== undefined && BigInt(payload.discountPercent) !== BigInt(selected.value)) throw new Error('Discount does not match the selected on-chain offer');
  const businesses = await escrowContract.getBusinessBuyers(poolId);
  requireNativeBatchSize(businesses.length, 'business', 1);
  const calls = [nativeContractCall('settleBusinessPool', [poolId])];
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_BUSINESS_SETTLEMENT', 'Business order settled; savings return is the next step', '', {
    poolId, buyersCount: businesses.length, paymentMemo: paymentMemo(poolId, 'settlement'),
  });
}
async function performBusinessPoolFinalization(payload = {}) {
  const poolId = requiredId(payload.poolId);
  const record = await escrowContract.businessPools(poolId);
  requireOpen(record);
  const deadline = BigInt(await escrowContract.businessDeadlines(poolId));
  if (!deadline || BigInt(Math.floor(Date.now() / 1000)) <= deadline) throw new Error('Business order deadline has not passed');
  const businesses = await escrowContract.getBusinessBuyers(poolId);
  const chunks = chunkRecipients(businesses);
  requireNativeBatchSize(businesses.length, 'business', 1);
  let hasSupplier = record.bestSupplier !== ethers.ZeroAddress && BigInt(record.totalDemand) > 0n;
  if (hasSupplier) {
    const [offerExpiry, capacity, revoked] = await Promise.all([
      escrowContract.businessSupplierOfferExpiry(poolId),
      escrowContract.businessSupplierMaxBuyers(poolId),
      escrowContract.sellerRevoked(record.bestSupplier),
    ]);
    hasSupplier = BigInt(offerExpiry) >= deadline && BigInt(capacity) >= BigInt(record.buyersCount) && !revoked;
  }
  if (!hasSupplier) {
    const backup = await escrowContract.businessBackupOffers(poolId);
    if (backup.supplier !== ethers.ZeroAddress) {
      const revoked = await escrowContract.sellerRevoked(backup.supplier);
      hasSupplier = BigInt(backup.offerExpiry) >= deadline
        && BigInt(backup.maxBuyers) >= BigInt(record.buyersCount)
        && BigInt(record.totalDemand) > 0n
        && !revoked;
    }
  }
  const calls = [nativeContractCall('finalizeBusinessPoolAfterDeadline', [poolId, payload.reason || 'Business order deadline reached'])];
  if (hasSupplier) {
    calls.push(...chunks.map((recipients) => nativeContractCall('disburseBusinessSavings', [poolId, recipients])));
  } else {
    calls.push(...chunks.map((recipients) => nativeContractCall('refundBusinessBatch', [poolId, recipients])));
  }
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_BUSINESS_FINALIZE', 'Business deadline finalization', '', {
    poolId, buyersCount: businesses.length, paymentMemo: paymentMemo(poolId, hasSupplier ? 'settlement' : 'refund'),
  });
}
async function performBusinessPoolRefund(payload = {}) {
  const poolId = requiredId(payload.poolId);
  const record = await escrowContract.businessPools(poolId);
  requireOpen(record);
  if (!BigInt(record.buyersCount)) throw new Error('No business commitments exist on-chain');
  const businesses = await escrowContract.getBusinessBuyers(poolId);
  const businessChunks = chunkRecipients(businesses);
  requireNativeBatchSize(businesses.length, 'business', 1);
  const calls = [
    nativeContractCall('refundBusinessPool', [poolId, payload.reason || 'Business order did not complete']),
    ...businessChunks.map((recipients) => nativeContractCall('refundBusinessBatch', [poolId, recipients])),
  ];
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_BUSINESS_REFUND', 'Business refund + buyer refund batch', '', {
    poolId, buyersCount: businesses.length, paymentMemo: paymentMemo(poolId, 'refund'),
  });
}
async function performRequestSettlement(payload = {}) {
  const requestId = requiredId(payload.requestId);
  const record = await escrowContract.demandRequests(requestId);
  requireOpen(record);
  if (!BigInt(record.buyersCount)) throw new Error('No funded request exists on-chain');
  const buyers = await escrowContract.getRequestBuyers(requestId);
  requireNativeBatchSize(buyers.length, 'request', 1);
  const deadline = BigInt(await escrowContract.requestDeadlines(requestId));
  let selected = record.bestSupplier === ethers.ZeroAddress ? null : {
    supplier: record.bestSupplier,
    value: record.bestPrice,
    maxBuyers: await escrowContract.requestSupplierMaxBuyers(requestId),
    offerExpiry: await escrowContract.requestSupplierOfferExpiry(requestId),
  };
  if (selected) {
    const revoked = await escrowContract.sellerRevoked(selected.supplier);
    if (BigInt(selected.offerExpiry) < deadline || BigInt(selected.maxBuyers) < BigInt(record.buyersCount) || revoked) selected = null;
  }
  if (selected && BigInt(record.totalEscrow) < BigInt(record.buyersCount) * BigInt(selected.value)) selected = null;
  if (selected) {
    for (const buyer of buyers) {
      if (await escrowContract.requestDeposits(requestId, buyer) < BigInt(selected.value)) { selected = null; break; }
    }
  }
  if (!selected) {
    const backup = await escrowContract.requestBackupOffers(requestId);
    if (backup.supplier !== ethers.ZeroAddress) {
      const revoked = await escrowContract.sellerRevoked(backup.supplier);
      let funded = BigInt(backup.offerExpiry) >= deadline
        && BigInt(backup.maxBuyers) >= BigInt(record.buyersCount)
        && BigInt(record.totalEscrow) >= BigInt(record.buyersCount) * BigInt(backup.value)
        && !revoked;
      for (const buyer of funded ? buyers : []) {
        if (await escrowContract.requestDeposits(requestId, buyer) < BigInt(backup.value)) { funded = false; break; }
      }
      if (funded) selected = backup;
    }
  }
  if (!selected) throw new Error('No fully funded request supplier offer is available on-chain');
  if (payload.bestPriceCents !== undefined && centsToPathUsdUnits(payload.bestPriceCents) !== BigInt(selected.value)) throw new Error('Request price does not match the selected on-chain offer');
  const calls = [nativeContractCall('settleRequest', [requestId])];
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_REQUEST_SETTLEMENT', 'Request settled; surplus return is the next step', '', {
    requestId, buyersCount: buyers.length, paymentMemo: paymentMemo(requestId, 'settlement'),
  });
}
async function performRequestFinalization(payload = {}) {
  const requestId = requiredId(payload.requestId);
  const record = await escrowContract.demandRequests(requestId);
  requireOpen(record);
  const deadline = BigInt(await escrowContract.requestDeadlines(requestId));
  if (!deadline || BigInt(Math.floor(Date.now() / 1000)) <= deadline) throw new Error('Request deadline has not passed');
  const buyers = await escrowContract.getRequestBuyers(requestId);
  const chunks = chunkRecipients(buyers);
  requireNativeBatchSize(buyers.length, 'request', 1);
  let fullyFunded = record.bestSupplier !== ethers.ZeroAddress && BigInt(record.bestPrice) > 0n && BigInt(record.totalEscrow) >= BigInt(record.buyersCount) * BigInt(record.bestPrice);
  if (fullyFunded) {
    const [offerExpiry, capacity, revoked] = await Promise.all([
      escrowContract.requestSupplierOfferExpiry(requestId),
      escrowContract.requestSupplierMaxBuyers(requestId),
      escrowContract.sellerRevoked(record.bestSupplier),
    ]);
    fullyFunded = BigInt(offerExpiry) >= deadline && BigInt(capacity) >= BigInt(record.buyersCount) && !revoked;
  }
  if (!fullyFunded) {
    const backup = await escrowContract.requestBackupOffers(requestId);
    if (backup.supplier !== ethers.ZeroAddress && BigInt(backup.value) > 0n) {
      const revoked = await escrowContract.sellerRevoked(backup.supplier);
      fullyFunded = BigInt(backup.offerExpiry) >= deadline
        && BigInt(backup.maxBuyers) >= BigInt(record.buyersCount)
        && BigInt(record.totalEscrow) >= BigInt(record.buyersCount) * BigInt(backup.value)
        && !revoked;
      if (fullyFunded) {
        for (const buyer of buyers) {
          if (await escrowContract.requestDeposits(requestId, buyer) < BigInt(backup.value)) { fullyFunded = false; break; }
        }
      }
    }
  }
  if (fullyFunded) {
    for (const buyer of buyers) {
      if (await escrowContract.requestDeposits(requestId, buyer) < record.bestPrice) { fullyFunded = false; break; }
    }
  }
  const calls = [nativeContractCall('finalizeRequestAfterDeadline', [requestId, payload.reason || 'Request deadline reached'])];
  if (fullyFunded) {
    calls.push(...chunks.map((recipients) => nativeContractCall('disburseRequestSurplusBatch', [requestId, recipients])));
  } else {
    calls.push(...chunks.map((recipients) => nativeContractCall('refundRequestBatch', [requestId, recipients])));
  }
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_REQUEST_FINALIZE', 'Request deadline finalization', '', {
    requestId, buyersCount: buyers.length, paymentMemo: paymentMemo(requestId, fullyFunded ? 'settlement' : 'refund'),
  });
}
async function performRequestRefund(payload = {}) {
  const requestId = requiredId(payload.requestId);
  const record = await escrowContract.demandRequests(requestId);
  requireOpen(record);
  if (!BigInt(record.buyersCount)) throw new Error('No request commitments exist on-chain');
  const buyers = await escrowContract.getRequestBuyers(requestId);
  const buyerChunks = chunkRecipients(buyers);
  requireNativeBatchSize(buyers.length, 'request', 1);
  const calls = [
    nativeContractCall('refundRequest', [requestId, payload.reason || 'Request did not complete']),
    ...buyerChunks.map((recipients) => nativeContractCall('refundRequestBatch', [requestId, recipients])),
  ];
  return executeTempoNativeBatch(calls, 'TEMPO_NATIVE_REQUEST_REFUND', 'Request refund + buyer refund batch', '', {
    requestId, buyersCount: buyers.length, paymentMemo: paymentMemo(requestId, 'refund'),
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) {
        req.socket.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function prepareAction(action, payload, contractVersion = deployedConfig.contractVersion) {
  if (!deploymentSourceHashMatch) throw new Error('Live wallet actions are disabled until the deployed contract matches compiled-v17.sourceHash.');
  if (Number(contractVersion) !== LIVE_SECURITY_VERSION) throw new Error(`New live wallet actions require hardened escrow v${LIVE_SECURITY_VERSION}; the configured deployment is recovery-only.`);
  const iface = new ethers.Interface(FULL_ESCROW_ABI);
  let method, args, approvalAmount = 0n, marketId;
  if (action === 'joinDeal') {
    marketId = requiredId(payload.dealId);
    const amount = Market.integer(payload.unitPriceCents);
    const quantity = Market.integer(payload.quantity ?? 1, 'quantity');
    if (quantity > 20) throw new Error('Maximum 20 units per buyer action; units are not independent buyers');
    if (quantity > 1 && Number(contractVersion) < 6) throw new Error('The configured escrow does not support secure buyer batches; join one unit per transaction.');
    approvalAmount = centsToPathUsdUnits(Market.integer(amount * quantity));
    method = quantity === 1 ? 'joinDeal' : 'joinDealUnits';
    const unitPriceUnits = centsToPathUsdUnits(amount);
    args = quantity === 1 ? [marketId, unitPriceUnits] : [marketId, unitPriceUnits, quantity];
  } else if (action === 'joinBusinessPool') {
    method = 'joinBusinessPool'; marketId = requiredId(payload.poolId); approvalAmount = centsToPathUsdUnits(payload.commitmentCents);
    args = [marketId, approvalAmount];
  } else if (action === 'createRequest') {
    method = 'createRequest'; marketId = requiredId(payload.requestId);
    const maxCents = Market.integer(payload.targetPriceCents);
    const authCents = Market.integer(payload.authAmount ?? maxCents);
    const title = String(payload.title || '').trim();
    if (!title || title.length > 120 || authCents !== maxCents) throw new Error('Request authorization must match the maximum price');
    if (payload.buyers !== undefined && Market.integer(payload.buyers, 'buyers') !== 1) throw new Error('Each request buyer must sign independently');
    const max = centsToPathUsdUnits(maxCents);
    approvalAmount = centsToPathUsdUnits(authCents);
    args = [marketId, title, max, approvalAmount];
  } else if (action === 'joinRequest') {
    method = 'joinRequest'; marketId = requiredId(payload.requestId); approvalAmount = centsToPathUsdUnits(payload.authAmount);
    args = [marketId, approvalAmount];
  } else if (action === 'fundRequest') {
    method = 'fundRequest'; marketId = requiredId(payload.requestId);
    const amountCents = Market.integer(payload.amountCents, 'amount');
    if (amountCents <= 0) throw new Error('The remaining request amount must be positive');
    approvalAmount = centsToPathUsdUnits(amountCents);
    args = [marketId, approvalAmount];
  } else if (action === 'submitPriceLadder') {
    if (Number(contractVersion) < PRICE_LADDER_VERSION) throw new Error(`Seller price ladders require escrow v${PRICE_LADDER_VERSION}; the configured live deployment is still v${contractVersion}.`);
    marketId = requiredId(payload.targetId);
    if (payload.marketType !== 'deal') throw new Error('Price ladders are only supported for consumer deals');
    const prices = Array.isArray(payload.pricesCents) ? payload.pricesCents.map((value) => centsToPathUsdUnits(Market.integer(value, 'tier price'))) : [];
    const minimumBuyerCounts = Array.isArray(payload.minimumBuyerCounts) ? payload.minimumBuyerCounts.map((value) => Market.integer(value, 'tier buyer count')) : [];
    const maxBuyerUnits = Market.integer(payload.maxBuyerUnits, 'maxBuyerUnits');
    const offerExpiry = Market.integer(payload.offerExpiry ?? (Math.floor(Date.now() / 1000) + 86400), 'offerExpiry');
    if (!prices.length || prices.length !== minimumBuyerCounts.length || offerExpiry <= Math.floor(Date.now() / 1000)) throw new Error('A seller ladder needs matching future price tiers and buyer thresholds');
    approvalAmount = centsToPathUsdUnits(payload.guaranteeBond);
    method = 'submitPriceLadder';
    args = [marketId, prices, minimumBuyerCounts, maxBuyerUnits, offerExpiry, approvalAmount];
  } else if (action === 'submitOffer') {
    marketId = requiredId(payload.targetId);
    approvalAmount = centsToPathUsdUnits(payload.guaranteeBond);
    const name = String(payload.sellerName || 'Independent seller').slice(0, 120);
    if (!['deal', 'business', 'request'].includes(payload.marketType)) throw new Error('Explicit offer marketType is required');
    if (payload.marketType === 'business') {
      method = 'submitBusinessOfferWithCapacity';
      const discountPercent = Market.integer(payload.discountPercent ?? 0, 'discountPercent');
      const maxBuyerCount = Market.integer(payload.maxBuyerCount ?? 500, 'maxBuyerCount');
      const offerExpiry = Market.integer(payload.offerExpiry ?? (Math.floor(Date.now() / 1000) + 86400), 'offerExpiry');
      if (discountPercent <= 0 || discountPercent >= 100) throw new Error('Business supplier discount must be between 1 and 99 percent');
      if (maxBuyerCount <= 0 || offerExpiry <= Math.floor(Date.now() / 1000)) throw new Error('A positive supplier capacity and future offer expiry are required');
      args = [marketId, name, discountPercent, approvalAmount, maxBuyerCount, offerExpiry];
    } else if (payload.marketType === 'request') {
      method = 'submitRequestOfferWithCapacity';
      const priceCents = Market.integer(payload.priceCents, 'priceCents');
      const maxBuyerCount = Market.integer(payload.maxBuyerCount ?? 500, 'maxBuyerCount');
      const offerExpiry = Market.integer(payload.offerExpiry ?? (Math.floor(Date.now() / 1000) + 86400), 'offerExpiry');
      if (priceCents <= 0) throw new Error('Request supplier price must be positive');
      if (maxBuyerCount <= 0 || offerExpiry <= Math.floor(Date.now() / 1000)) throw new Error('A positive supplier capacity and future offer expiry are required');
      args = [marketId, name, centsToPathUsdUnits(priceCents), approvalAmount, maxBuyerCount, offerExpiry];
    } else {
        method = 'submitOfferWithCapacity';
        const minimumBuyerCount = Market.integer(payload.minimumBuyerCount ?? 1, 'minimumBuyerCount');
        const maxBuyerUnits = Market.integer(payload.maxBuyerUnits ?? 20, 'maxBuyerUnits');
        const offerExpiry = Market.integer(payload.offerExpiry ?? (Math.floor(Date.now() / 1000) + 1800), 'offerExpiry');
        if (maxBuyerUnits <= 0 || offerExpiry <= Math.floor(Date.now() / 1000)) throw new Error('A positive seller capacity and future offer expiry are required');
        args = [marketId, name, centsToPathUsdUnits(payload.priceCents), approvalAmount, minimumBuyerCount, maxBuyerUnits, offerExpiry];
    }
  } else throw new Error('Unsupported independent wallet action');
  return { transaction: { to: CONTRACT_ADDRESS, data: iface.encodeFunctionData(method, args), value: '0x0' },
    chainId: TEMPO_CHAIN_ID, token: PATH_USD_ADDRESS, approvalAmount: approvalAmount.toString(), method, targetId: marketId, actorMode: 'INDEPENDENT_WALLET' };
}

async function prepareWalletAction(action, payload = {}) {
  if (!deploymentSourceHashMatch) {
    throw new Error('Real Tempo payment requires a deployment built from the current compiled-v17 source.');
  }
  if (Number(deployedConfig.contractVersion) !== LIVE_SECURITY_VERSION) {
    throw new Error(`Real Tempo payment requires the current contract version ${LIVE_SECURITY_VERSION}.`);
  }
  // A LIVE action may only be prepared for a market that exists on the
  // configured escrow. The UI can still show a modeled request, but it must
  // never turn a fake ID into a wallet transaction that will revert.
  const assertOnChainMarket = async (marketType, marketId) => {
    // Unit/prepare tests can run without an RPC contract. In the real server
    // the contract is always initialized before a wallet action is exposed;
    // keep pure transaction preparation deterministic for those offline tests.
    if (!escrowContract) return;
    const id = requiredId(marketId);
    try {
      if (marketType === 'deal') {
        const record = await escrowContract.getDealState(id);
        if (BigInt(record[0]) === 0n && BigInt(record[1]) === 0n && BigInt(record[3]) === 0n && !record[5] && !record[6]) {
          throw new Error('This deal is only a market example; no LIVE deal exists on Tempo yet.');
        }
      } else if (marketType === 'business') {
        const record = await escrowContract.businessPools(id);
        if (BigInt(record[0]) === 0n && BigInt(record[1]) === 0n && BigInt(record[2]) === 0n && record[3] === ethers.ZeroAddress && !record[5] && !record[6]) {
          throw new Error('This business order is only a market example; no LIVE order exists on Tempo yet.');
        }
      } else if (marketType === 'request') {
        const record = await escrowContract.demandRequests(id);
        if (BigInt(record[0]) === 0n && BigInt(record[1]) === 0n && BigInt(record[3]) === 0n && BigInt(record[4]) === 0n && record[2] === ethers.ZeroAddress && !record[6] && !record[7]) {
          throw new Error('This request is only a market example; create it on Tempo before joining or offering.');
        }
      }
    } catch (error) {
      if (/only a market example|no LIVE|create it on Tempo/.test(error.message || '')) throw error;
      throw new Error(`Could not verify the LIVE ${marketType} market on Tempo. No transaction was prepared.`);
    }
  };
  const adjustedPayload = { ...payload };
  if (action === 'joinDeal' || action === 'submitOffer' && payload.marketType === 'deal') {
    await assertOnChainMarket('deal', payload.dealId || payload.targetId);
  }
  if (action === 'joinBusinessPool' || action === 'submitOffer' && payload.marketType === 'business') {
    await assertOnChainMarket('business', payload.poolId || payload.targetId);
  }
  if (action === 'joinRequest' || action === 'fundRequest' || action === 'submitOffer' && payload.marketType === 'request') {
    await assertOnChainMarket('request', payload.requestId || payload.targetId);
  }
  if (action === 'submitOffer' && ['business', 'request'].includes(payload.marketType)) {
    const marketId = requiredId(payload.targetId);
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(payload.marketType === 'business'
      ? await escrowContract.businessDeadlines(marketId)
      : await escrowContract.requestDeadlines(marketId));
    const marketClose = deadline > 0n ? Number(deadline) : now + 86400;
    const requestedExpiry = Market.integer(payload.offerExpiry ?? marketClose, 'offerExpiry');
    adjustedPayload.offerExpiry = Math.min(requestedExpiry, marketClose);
    if (adjustedPayload.offerExpiry <= now) throw new Error('This order is too close to closing for a new supplier offer.');
  }
  return prepareAction(action, adjustedPayload);
}

function mergeLiveOwnerAction(demo, result, action) {
  if (!demo || !result?.success) return demo;
  const receipt = result.receipt || result.receipts?.at(-1) || null;
  const receipts = Array.isArray(demo.receipts) ? [...demo.receipts] : [];
  if (receipt?.hash && !receipts.some((entry) => entry.hash?.toLowerCase() === receipt.hash.toLowerCase())) receipts.push(receipt);
  const next = {
    ...demo,
    receipts,
    transactionCount: receipts.length,
    individualTransactionCount: demo.individualTransactionCount || Math.min(4, receipts.length),
    groupedTransactionCount: (demo.groupedTransactionCount || 0) + (receipt?.transactionType === '0x76' ? 1 : 0),
    lastHash: result.hash || demo.lastHash || null,
  };
  if (action === 'settleDeal') {
    next.status = 'AWAITING_FULFILLMENT';
    next.fulfillmentConfirmed = false;
    next.guaranteeResolved = false;
    next.settlementHash = result.hash || next.settlementHash || null;
    next.settlementReceipt = receipt || next.settlementReceipt || null;
    next.settlementSummary = receipt?.settlementSummary || next.settlementSummary || null;
  } else if (action === 'refundDeal') {
    next.status = 'REFUNDED';
    next.refundHash = result.hash || next.refundHash || null;
    next.refundReceipt = receipt || next.refundReceipt || null;
  } else if (action === 'confirmDealFulfillment') {
    next.status = 'COMPLETED';
    next.fulfillmentConfirmed = true;
    next.guaranteeResolved = true;
    next.chainVerified = true;
    next.chainVerifiedAt = new Date().toISOString();
    next.chainVerifiedReceiptCount = receipts.filter((entry) => entry?.status === 'CONFIRMED' && entry?.isOnChain).length;
    next.proofSource = 'LIVE_RECEIPTS_CONFIRMED';
    next.fulfillmentHash = result.hash || next.fulfillmentHash || null;
    next.fulfillmentReceipt = receipt || next.fulfillmentReceipt || null;
  } else if (action === 'slashSettledDealGuarantee' || action === 'refundDealAfterFulfillmentDeadline') {
    next.status = 'REFUNDED';
    next.sellerFailed = true;
    next.guaranteeResolved = true;
    next.refundHash = result.hash || next.refundHash || null;
    next.refundReceipt = receipt || next.refundReceipt || null;
  }
  next.phase = next.status;
  return next;
}

async function ownerAction(action, payload) {
  if (!deploymentSourceHashMatch && !['refundDeal', 'confirmDealFulfillment', 'slashSettledDealGuarantee', 'refundDealAfterFulfillmentDeadline', 'slashSettledBusinessSupplier', 'slashSettledRequestSupplier'].includes(action)) {
    throw new Error('New Tempo actions are disabled until the deployed contract matches compiled-v17.sourceHash.');
  }
  if (Number(deployedConfig.contractVersion) < 10) throw new Error('Settlement is disabled until escrow v10 is deployed with conditional offers, seller authorization, deadlines, and Tempo native batching.');
  if (Number(deployedConfig.contractVersion) !== LIVE_SECURITY_VERSION
    && !['refundDeal', 'confirmDealFulfillment', 'slashSettledDealGuarantee', 'refundDealAfterFulfillmentDeadline', 'slashSettledBusinessSupplier', 'slashSettledRequestSupplier'].includes(action)) {
    throw new Error(`This deployment is recovery-only. New payment actions require hardened escrow v${LIVE_SECURITY_VERSION}.`);
  }
  if (!activeWallet || !escrowContract) throw new Error('Settlement wallet is not configured');
  let receipt;
  if (action === 'settleDeal') receipt = await performDealSettlement(payload);
  else if (action === 'settleDealFailedSeller') receipt = await performDealRefund({ ...payload, sellerFailed: true, reason: 'Failed seller backup is not funded; refund each buyer commitment' });
  else if (action === 'refundDeal') receipt = await performDealRefund(payload);
  else if (action === 'confirmDealFulfillment') receipt = await performDealFulfillment(payload);
  else if (action === 'slashSettledDealGuarantee') receipt = await performDealGuaranteeSlash(payload);
  else if (action === 'refundDealAfterFulfillmentDeadline') receipt = await performDealTimeoutRefund(payload);
  else if (action === 'confirmBusinessPoolFulfillment') receipt = await performBusinessFulfillment(payload);
  else if (action === 'confirmRequestFulfillment') receipt = await performRequestFulfillment(payload);
  else if (action === 'slashSettledBusinessSupplier') receipt = await performBusinessSupplierFailure(payload);
  else if (action === 'slashSettledRequestSupplier') receipt = await performRequestSupplierFailure(payload);
  else if (action === 'settleBusinessPool') receipt = await performBusinessPoolSettlement(payload);
  else if (action === 'finalizeBusinessPool') receipt = await performBusinessPoolFinalization(payload);
  else if (action === 'refundBusinessPool') receipt = await performBusinessPoolRefund(payload);
  else if (action === 'settleRequest') receipt = await performRequestSettlement(payload);
  else if (action === 'finalizeRequest') receipt = await performRequestFinalization(payload);
  else if (action === 'refundRequest') receipt = await performRequestRefund(payload);
  else if (['refundBatch', 'disburseSurplusBatch', 'slashSellerGuarantee'].includes(action)) {
    const id = requiredId(payload.dealId);
    const args = action === 'slashSellerGuarantee' ? [id, String(payload.reason || 'Seller default')]
      : [id, payload.recipients];
    if (action !== 'slashSellerGuarantee' && (!Array.isArray(payload.recipients) || !payload.recipients.length || payload.recipients.length > LIVE_RECIPIENT_BATCH_MAX || !payload.recipients.every(ethers.isAddress))) throw new Error(`Explicit valid recipients required; one recipient batch is limited to ${LIVE_RECIPIENT_BATCH_MAX} buyers`);
    receipt = await executeTempoTx(() => escrowContract[action].populateTransaction(...args), action, '', '');
  } else throw new Error('Unsupported owner action. Failed seller recovery requires refund or explicit funding, never an automatic price increase');
  return receipt.receipts ? receipt : { success: true, status: 'CONFIRMED', isOnChain: true, hash: receipt.hash, receipt };
}

function isCurrentEscrowProof(result) {
  const contract = result?.contract || result?.receipt?.contract || result?.to || result?.receipt?.to;
  return typeof contract === 'string' && contract.toLowerCase() === CONTRACT_ADDRESS.toLowerCase();
}

function confirmedProofs() {
  if (requestStateContext.getStore()?.public) return [];
  return Object.values(journal.records).map((entry) => entry.result)
    .filter((result) => result?.status === 'CONFIRMED' && result.isOnChain && isCurrentEscrowProof(result))
    .flatMap((result) => result.receipts || [result.receipt]).filter(Boolean);
}

async function verifyExternalProof(hash) {
  if (typeof hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(hash)) throw new Error('A valid transaction hash is required');
  const id = 'proof:' + hash.toLowerCase();
  const existing = journal.records[id];
  if (existing?.result?.status === 'CONFIRMED') return existing.result;
  if (verifiedProofTasks.has(id)) return verifiedProofTasks.get(id);
  const task = (async () => {
    const receipt = await waitForTempoReceipt(hash, 1000);
    if (!receipt) {
      const result = { success: false, status: 'PENDING', isOnChain: false, hash, error: 'Receipt is not confirmed yet; check again without resending.' };
      journal.update(id, { status: 'PENDING', result, createdAt: existing?.createdAt || new Date().toISOString() });
      return result;
    }
    if (receipt.to && receipt.to.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) throw new Error('Transaction did not target the DealArena escrow contract');
    const proof = receiptProof(receipt, 'WALLET_ACTION_PROOF');
    const result = { success: true, ...proof, receipt: proof };
    journal.update(id, { status: 'CONFIRMED', result, createdAt: existing?.createdAt || new Date().toISOString() });
    return result;
  })();
  verifiedProofTasks.set(id, task);
  try { return await task; } finally { verifiedProofTasks.delete(id); }
}

function chainRecordExists(record, type) {
  if (!record) return false;
  if (type === 'deal') return BigInt(record[0] || 0) > 0n || BigInt(record[1] || 0) > 0n || BigInt(record[3] || 0) > 0n || Boolean(record[5]) || Boolean(record[6]);
  if (type === 'business') return BigInt(record[0] || 0) > 0n || BigInt(record[1] || 0) > 0n || BigInt(record[2] || 0) > 0n || record[3] !== ethers.ZeroAddress || Boolean(record[5]) || Boolean(record[6]);
  return BigInt(record[0] || 0) > 0n || BigInt(record[1] || 0) > 0n || BigInt(record[3] || 0) > 0n || BigInt(record[4] || 0) > 0n || record[2] !== ethers.ZeroAddress || Boolean(record[6]) || Boolean(record[7]);
}
async function readOnChainMarketState(ids = state.activeIds) {
  if (!escrowContract || !ids) return { available: false, reason: 'Tempo escrow is not initialized' };
  const read = async (type, id, method) => {
    try {
      const record = await escrowContract[method](id);
      return { id, exists: chainRecordExists(record, type), record: Array.from(record, (value) => typeof value === 'bigint' ? value.toString() : value) };
    } catch (error) {
      return { id, exists: false, error: error.message || String(error) };
    }
  };
  const [deal, business, laptop, crm] = await Promise.all([
    read('deal', ids.dealId, 'getDealState'),
    read('business', ids.poolId, 'businessPools'),
    read('request', ids.laptopReqId, 'demandRequests'),
    read('request', ids.crmReqId, 'demandRequests'),
  ]);
  return { available: true, deal, business, requests: { laptop, crm }, readAt: new Date().toISOString() };
}
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host) throw new Error('Cross-origin writes are not allowed');
}
function localRequest(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
function hasPresenterToken(req, body = {}) {
  if (!PRESENTER_TOKEN) return false;
  const candidate = String(req.headers['x-dealarena-presenter-token'] || body.presenterToken || '').trim();
  if (!candidate || candidate.length !== PRESENTER_TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(PRESENTER_TOKEN));
  } catch {
    return false;
  }
}
function assertPresenterAuthorization(req, body = {}) {
  if (JURY_DEMO_PUBLIC) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const boundedAction = pathname === '/api/demo/mini-deal'
      || (pathname === '/api/wallet/execute' && ['settleDeal', 'refundDeal', 'confirmDealFulfillment', 'slashSettledDealGuarantee', 'refundDealAfterFulfillmentDeadline'].includes(body.action));
    if (boundedAction) return;
  }
  if (PUBLIC_DEMO_ENABLED) {
    if (!hasPresenterToken(req, body)) {
      const error = new Error('Presenter authorization is required for LIVE actions.');
      error.statusCode = 403;
      throw error;
    }
    return;
  }
  if (!localRequest(req)) {
    const error = new Error('LIVE actions are local-only unless public presenter mode is explicitly enabled.');
    error.statusCode = 403;
    throw error;
  }
}
function assertPublicWriteRateLimit(req, scope) {
  if (localRequest(req) || !PUBLIC_DEMO_ENABLED) return;
  const key = `${req.socket.remoteAddress || 'unknown'}:${scope}`;
  const now = Date.now();
  const previous = publicWriteWindows.get(key) || 0;
  if (now - previous < PUBLIC_WRITE_RATE_LIMIT_MS) {
    const error = new Error('Public demo is rate-limited; wait a few seconds before trying the same live action again.');
    error.statusCode = 429;
    error.retryAfter = Math.ceil((PUBLIC_WRITE_RATE_LIMIT_MS - (now - previous)) / 1000);
    throw error;
  }
  publicWriteWindows.set(key, now);
}
function assertPublicProofScope(req, simulationDealId) {
  if (!PUBLIC_DEMO_ENABLED) return;
  if (simulationDealId !== state.activeIds.dealId) throw new Error('Public proof must use the current simulation deal ID. Refresh the demo and try again.');
}
function assertPublicOwnerScope(req, action, payload) {
  if (!PUBLIC_DEMO_ENABLED) return;
  const dealAction = ['settleDeal', 'refundDeal', 'confirmDealFulfillment', 'slashSettledDealGuarantee', 'refundDealAfterFulfillmentDeadline'].includes(action);
  const businessAction = [
    'settleBusinessPool',
    'finalizeBusinessPool',
    'refundBusinessPool',
    'confirmBusinessPoolFulfillment',
    'slashSettledBusinessSupplier',
  ].includes(action);
  const requestAction = [
    'settleRequest',
    'finalizeRequest',
    'refundRequest',
    'confirmRequestFulfillment',
    'slashSettledRequestSupplier',
  ].includes(action);
  const allowed = (dealAction && state.liveDemo?.liveDealId === payload.dealId)
    || (businessAction && state.activeIds.poolId === payload.poolId)
    || (requestAction && [state.activeIds.laptopReqId, state.activeIds.crmReqId].includes(payload.requestId));
  if (!allowed) {
    throw new Error('This LIVE action is limited to the active market shown on this page.');
  }
}

// --------------------------------------------------------------------------
// HTTP Server
const server = http.createServer(async (req, res) => {
  const session = getPublicSession(req, res);
  return requestStateContext.run(session, async () => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      if (method === 'GET') {
        if (pathname === '/api/state' || pathname === '/api/scenarios') {
          const visibleLatestLiveProof = state.latestLiveProof || (requestStateContext.getStore()?.public ? loadLatestLiveProof() : null);
          const onChainMarkets = await readOnChainMarketState(state.activeIds);
          sendJson(res, 200, { success: true, state: { ...state, latestLiveProof: visibleLatestLiveProof, transactions: confirmedProofs(), onChainMarkets }, activeIds: state.activeIds, scenarios: SCENARIOS }); return;
        }
        if (pathname === '/api/demo/mini-deal/status') {
          const demo = state.liveDemo || state.latestLiveProof || loadLatestLiveProof();
          let receiptAvailable = false;
          if (demo?.lastHash && demo.currentStep && ['PENDING', 'IN_PROGRESS'].includes(demo.status)) {
            receiptAvailable = Boolean(await provider.send('eth_getTransactionReceipt', [demo.lastHash]));
          }
          const normalizedDemo = demo ? { ...demo, receipts: normalizeReceiptExplorerUrls(demo.receipts) } : demo;
          sendJson(res, 200, { success: true, liveDemo: normalizedDemo, receiptAvailable, readOnly: true }); return;
        }
        if (pathname === '/api/transactions') { sendJson(res, 200, { success: true, transactions: confirmedProofs() }); return; }
        if (pathname === '/api/tempo/status' || pathname === '/api/wallet/status') {
          const readiness = await getPresetDemoReadiness();
          const openLiveProof = Boolean(state.liveDemo?.liveDealId) && !isLiveDealTerminal(state.liveDemo);
          const liveAvailable = readiness.ready || openLiveProof;
          sendJson(res, 200, { success: true, connected: Boolean(activeWallet), network: 'Tempo Testnet (Moderato)',
             chainId: TEMPO_CHAIN_ID, contract: CONTRACT_ADDRESS, contractVersion: deployedConfig.contractVersion || 0,
             minimumSecurityVersion: LIVE_SECURITY_VERSION, livePaymentsEnabled: liveAvailable, liveReady: liveAvailable,
             sourceHashMatch: Boolean(readiness.checks?.sourceHash),
             compiledSourceHash: readiness.checks?.compiledSourceHash || null,
             deployedSourceHash: readiness.checks?.deployedSourceHash || null,
             connectedWalletPaymentsEnabled: Boolean(readiness.checks?.sourceHash && readiness.checks?.rpc && readiness.checks?.contract && readiness.checks?.paymentToken && readiness.checks?.contractVersion),
             newLiveProofEnabled: readiness.ready, liveRecoveryOnly: openLiveProof && !readiness.ready,
             readiness, nativeBatchEnabled: Number(deployedConfig.contractVersion) >= 6,
            nativeTransactionType: '0x76', liveBatchMaxCalls: LIVE_NATIVE_BATCH_MAX, liveRecipientBatchMax: LIVE_RECIPIENT_BATCH_MAX, liveBatchMaxBuyers: LIVE_RECIPIENT_BATCH_MAX, pathUsdDecimals: PATH_USD_DECIMALS,
            pathUsd: PATH_USD_ADDRESS, latestBlockNumber, rpc: TEMPO_RPC, explorer: TEMPO_EXPLORER,
            address: activeWallet?.address || null, activeIds: state.activeIds, sellers: state.sellers, suppliers: state.suppliers,
            demoActors: { buyer: demoBuyerWallet.address, buyers: demoBuyerWallets.map((wallet) => wallet.address), sellers: Object.fromEntries(Object.entries(sellerWallets).map(([key, wallet]) => [key, wallet.address])) },
            actorMode: 'PRESET_SERVER_DEMO_WALLETS', publicDemoEnabled: PUBLIC_DEMO_ENABLED,
            presenterAuthorized: JURY_DEMO_PUBLIC || (PUBLIC_DEMO_ENABLED ? hasPresenterToken(req) : localRequest(req)),
            juryDemoPublic: JURY_DEMO_PUBLIC,
            marketLogic: 'OFF_CHAIN', moneySettlement: 'ON_CHAIN',
             priceLadder: { version: Number(deployedConfig.contractVersion) || PRICE_LADDER_VERSION, minimumVersion: PRICE_LADDER_VERSION, mode: Number(deployedConfig.contractVersion) >= PRICE_LADDER_VERSION ? 'ON_CHAIN_SELLER_PRICE_LADDER' : 'PRICE_LADDER_DEPLOYMENT_PENDING', ready: Number(deployedConfig.contractVersion) >= PRICE_LADDER_VERSION, minimumBuyerCountSupported: true } }); return;
        }
        if (pathname.startsWith('/api/actions/')) {
          const id = decodeURIComponent(pathname.slice('/api/actions/'.length));
          const record = journal.records[id] || journal.records[scopedActionId(id)];
          if (!record) { sendJson(res, 404, { success: false, error: 'Unknown action' }); return; }
          if (record.payload?.liveProof === true || record.payload?.action === 'runPresetLiveMiniDeal') {
            const demo = state.liveDemo;
            if (demo?.status === 'READY_TO_SETTLE') {
              sendJson(res, 200, { success: true, status: 'CONFIRMED', isOnChain: true, hash: demo.lastHash || demo.receipts?.at(-1)?.hash || null, receipts: demo.receipts || [], liveDemo: demo, demo }); return;
            }
            const pendingStatus = demo?.status === 'PENDING' ? 'PENDING' : demo?.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : record.status;
            sendJson(res, pendingStatus === 'PENDING' ? 202 : 200, { success: false, status: pendingStatus, isOnChain: false, hash: demo?.lastHash || record.hash || null, receipts: demo?.receipts || [], liveDemo: demo, error: demo?.lastError || 'LIVE proof is not complete; wait for the individual steps to finish.' }); return;
          }
          if (record.hash && record.status !== 'CONFIRMED' && record.status !== 'FAILED') {
            const receipt = await waitForTempoReceipt(record.hash, 1000);
            if (receipt) {
              try {
                const proof = receiptProof(receipt, 'RECOVERED_ACTION');
                journal.update(id, { status: 'CONFIRMED', result: { success: true, status: 'CONFIRMED', isOnChain: true, hash: record.hash, receipt: proof } });
              } catch (err) {
                if (err.txStatus === 'FAILED') journal.update(id, { status: 'FAILED', result: { success: false, status: 'FAILED', hash: record.hash, error: err.message } });
                else throw err;
              }
            }
          }
          sendJson(res, 200, journal.records[id].result || { status: record.status, hash: record.hash || null }); return;
        }
        if (pathname === '/api/wallet/balance') {
          const address = parsedUrl.searchParams.get('address');
          if (!ethers.isAddress(address || '')) throw new Error('Explicit wallet address is required');
          const token = new ethers.Contract(PATH_USD_ADDRESS, TIP20_ABI, provider);
          const rawBalance = await token.balanceOf(address);
          sendJson(res, 200, { success: true, address, pathUsdBalance: pathUsdUnitsToUsd(rawBalance, 2), pathUsdBalanceRaw: rawBalance.toString(), decimals: PATH_USD_DECIMALS }); return;
        }
        if (pathname === '/api/tempo/benchmark') {
          const benchmark = require('./contracts/benchmark-batch.js');
          sendJson(res, 200, { success: true, benchmark: [1, 5, 10, 25, 50, 100, 200, 500].map(benchmark.calculateBatchGas), provenance: 'ESTIMATE' }); return;
        }
      }
      if (method === 'POST') {
        assertSameOrigin(req);
        const body = await readJsonBody(req);
        if (pathname === '/api/demo/mini-deal') {
          assertPresenterAuthorization(req, body);
          if (!localRequest(req) && !PUBLIC_DEMO_ENABLED) { sendJson(res, 403, { success: false, error: 'Preset demo actions are local-only. Public mode requires TEMPO_PUBLIC_DEMO=true and TEMPO_PRESENTER_MODE=true.' }); return; }
          if (Number(deployedConfig.contractVersion) !== LIVE_SECURITY_VERSION) throw new Error(`New LIVE proofs require escrow v${LIVE_SECURITY_VERSION}; the configured deployment is recovery-only until the current hardened contract is deployed.`);
          const simulationDealId = requiredId(body.simulationDealId || body.dealId || state.activeIds.dealId);
          assertPublicProofScope(req, simulationDealId);
          assertPublicWriteRateLimit(req, 'mini-deal');
          // A reset starts a new presenter run while preserving the public
          // simulation ID. Include the server generation so the durable
          // journal deduplicates retries within one run but never replays a
          // completed testnet proof for the next run.
          const actionId = scopedActionId(body.actionId || `demo:mini-deal:${simulationDealId}:${state.generation}`);
          const resumable = state.liveDemo?.simulationDealId === simulationDealId
            && ['PENDING', 'IN_PROGRESS'].includes(state.liveDemo.status);
          if (JURY_DEMO_PUBLIC && !resumable && !liveDemoTasks.has(requestStateContext.getStore()?.id || 'local')) {
            const day = new Date().toISOString().slice(0, 10);
            const count = juryDailyRuns.get(day) || 0;
            if (count >= 20) {
              const error = new Error('The daily testnet demo limit has been reached.');
              error.statusCode = 429;
              throw error;
            }
            juryDailyRuns.set(day, count + 1);
          }
          const run = () => {
            const update = (patch) => journal.update(actionId, patch);
            if (resumable) return actionContext.run({ update }, () => runPresetLiveMiniDeal(simulationDealId, update));
            return journal.run(actionId, { action: 'runPresetLiveMiniDeal', payload: { simulationDealId }, liveProof: true }, (journalUpdate) =>
              actionContext.run({ update: journalUpdate }, () => runPresetLiveMiniDeal(simulationDealId, journalUpdate)));
          };
          const taskKey = requestStateContext.getStore()?.id || 'local';
          if (!liveDemoTasks.has(taskKey)) {
            liveDemoTasks.set(taskKey, run().finally(() => liveDemoTasks.delete(taskKey)));
          }
          let result;
          try {
            result = await liveDemoTasks.get(taskKey);
          } catch (error) {
            result = {
              success: false,
              status: error.txStatus || 'FAILED',
              isOnChain: false,
              hash: error.txHash || state.liveDemo?.lastHash || null,
              error: error.message || String(error),
              receipts: state.liveDemo?.receipts || [],
              liveDemo: state.liveDemo,
            };
          }
          if (result.success && result.demo) {
            state.liveDemo = result.demo;
            state.liveProofUsed = true;
            persistLiveDemo(result.demo);
            if (body.autoSettle === true && result.demo.status === 'READY_TO_SETTLE') {
              const settlementPayload = {
                dealId: result.demo.liveDealId,
                expectedSeller: result.demo.winningSeller,
              };
              const settleActionId = `${actionId}:settle`;
              const settlement = await journal.run(
                settleActionId,
                { action: 'settleDeal', payload: settlementPayload, liveProof: true },
                (update) => actionContext.run({ update }, () => ownerAction('settleDeal', settlementPayload)),
              );
              if (!settlement.success) {
                result = { ...result, success: false, status: settlement.status || 'FAILED', error: settlement.error || 'Live proof offers were confirmed, but settlement needs recovery.', settlement };
              } else {
                state.liveDemo = mergeLiveOwnerAction(state.liveDemo, settlement, 'settleDeal');
                state.latestLiveProof = state.liveDemo;
                state.liveProofUsed = true;
                persistLatestLiveProof(state.liveDemo);
                persistLiveDemo(state.liveDemo);
                result = {
                  ...result,
                  status: 'CONFIRMED',
                  hash: settlement.hash,
                  receipt: settlement.receipt,
                  settlement,
                  demo: state.liveDemo,
                  liveDemo: state.liveDemo,
                  latestLiveProof: state.latestLiveProof,
                };
              }
            }
          }
          const response = result.success ? { ...result, latestLiveProof: state.latestLiveProof || null } : { ...result, liveDemo: state.liveDemo, latestLiveProof: state.latestLiveProof || null };
          sendJson(res, result.success ? 200 : result.status === 'PENDING' ? 202 : 400, response); return;
        }
        if (pathname === '/api/scenario/reset') {
          if (body.generation !== state.generation) throw new Error('Stale reset generation');
          resetState();
          sendJson(res, 200, { success: true, state, activeIds: state.activeIds, scenarios: SCENARIOS }); return;
        }
        if (pathname === '/api/scenario/step') { sendJson(res, 200, scenarioStep(body)); return; }
        if (pathname === '/api/proof') {
          const result = await verifyExternalProof(body.hash);
          if (result.success && result.status === 'CONFIRMED') {
            const actionByMethod = {
              joinDeal: 'joinDeal',
              joinDealUnits: 'joinDeal',
              joinBusinessPool: 'joinBusinessPool',
              createRequest: 'createRequest',
              joinRequest: 'joinRequest',
              fundRequest: 'joinRequest',
              submitOfferWithCapacity: 'submitOffer',
              submitPriceLadder: 'submitOffer',
              submitBusinessOfferWithCapacity: 'submitOffer',
              submitRequestOfferWithCapacity: 'submitOffer',
            };
            const action = actionByMethod[body.action];
            if (action) reflectConfirmedProductAction(action, body.payload || {});
          }
          sendJson(res, result.status === 'PENDING' ? 202 : 200, result);
          return;
        }
        if (pathname === '/api/transaction/prepare') {
          sendJson(res, 200, { success: true, status: 'PREPARED', isOnChain: false, ...await prepareWalletAction(body.action, body.payload || {}) }); return;
        }
        const independentRoutes = { '/api/deal/join': 'joinDeal', '/api/business/join': 'joinBusinessPool',
          '/api/request/create': 'createRequest', '/api/deal/offer': 'submitOffer' };
        if (independentRoutes[pathname]) {
          let payload = body;
          if (pathname === '/api/request/create') {
            const price = body.targetPriceCents !== undefined ? Market.integer(body.targetPriceCents) : Market.cents(body.price ?? body.maxPrice);
            payload = { requestId: body.requestId, title: body.need || body.title, targetPriceCents: price,
              authAmount: body.authAmount ?? price, buyers: body.buyers };
          } else if (pathname === '/api/deal/offer') {
            const product = String(body.product || '');
            const marketType = product === 'Coffee supplies' ? 'business' : product === 'Phone group order' ? 'deal' :
              (product === 'Laptop under $700' || product === 'CRM under $30 / user' || body.marketType === 'request') ? 'request' : body.marketType;
            const amount = String(body.priceCents !== undefined ? body.priceCents : body.price || '');
            const guarantee = body.guaranteeBond !== undefined ? Market.integer(body.guaranteeBond) : Market.cents(body.guarantee || '$10');
            payload = { targetId: body.targetId, marketType, guaranteeBond: guarantee, sellerName: body.sellerName,
              priceCents: body.priceCents !== undefined ? body.priceCents : marketType === 'business' ? undefined : Market.cents(amount),
              discountPercent: body.discountPercent !== undefined ? body.discountPercent : marketType === 'business' ? Market.integer(amount.replace(/[−%\\s]/g, '')) : undefined };
          }
          sendJson(res, 200, { success: true, status: 'PREPARED', isOnChain: false, ...await prepareWalletAction(independentRoutes[pathname], payload) }); return;
        }
        const ownerRoutes = { '/api/business/settle': 'settleBusinessPool', '/api/business/finalize': 'finalizeBusinessPool', '/api/request/settle': 'settleRequest', '/api/request/finalize': 'finalizeRequest' };
        if (pathname === '/api/wallet/execute' || ownerRoutes[pathname]) {
          assertPresenterAuthorization(req, body);
          if (!localRequest(req) && !PUBLIC_DEMO_ENABLED) { sendJson(res, 403, { success: false, error: 'Owner actions are local-only. Public mode requires TEMPO_PUBLIC_DEMO=true and TEMPO_PRESENTER_MODE=true.' }); return; }
          const action = ownerRoutes[pathname] || body.action;
          const payload = ownerRoutes[pathname] ? body : (body.payload || {});
          const { actionId: ignored, ...financialPayload } = payload;
          assertPublicOwnerScope(req, action, financialPayload);
          assertPublicWriteRateLimit(req, 'owner-action');
          const result = await journal.run(scopedActionId(body.actionId), { action, payload: financialPayload }, (update) =>
            actionContext.run({ update }, () => ownerAction(action, financialPayload)));
          if (result.success && ['createRequest', 'joinRequest', 'joinDeal', 'joinBusinessPool', 'submitOffer'].includes(action)) {
            reflectConfirmedProductAction(action, financialPayload);
          }
          if (result.success && ['settleDeal', 'refundDeal', 'confirmDealFulfillment', 'slashSettledDealGuarantee', 'refundDealAfterFulfillmentDeadline'].includes(action) && state.liveDemo?.liveDealId === financialPayload.dealId) {
            state.liveDemo = mergeLiveOwnerAction(state.liveDemo, result, action);
            state.liveProofUsed = !['refundDeal', 'confirmDealFulfillment', 'slashSettledDealGuarantee', 'refundDealAfterFulfillmentDeadline'].includes(action);
            if (isLiveProofDisplayable(state.liveDemo)) {
              state.latestLiveProof = state.liveDemo;
              persistLatestLiveProof(state.liveDemo);
            }
            persistLiveDemo(state.liveDemo);
          }
          sendJson(res, result.success ? 200 : result.status === 'PENDING' ? 202 : 400, result); return;
        }
        if (pathname === '/api/wallet/configure') {
          sendJson(res, 403, { success: false, error: 'Never enter private keys into the website. Buyers use their own wallet; owner configuration stays in the server environment.' }); return;
        }
      }
      sendJson(res, 404, { success: false, error: 'Endpoint not found' });
    } catch (err) {
      const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 400;
      if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
      sendJson(res, statusCode, { success: false, status: statusCode === 429 ? 'RATE_LIMITED' : 'FAILED', isOnChain: false, error: err.message });
    }
    return;
  }

  // ------------------------------------------------------------------------
  // Static File Serving
  // ------------------------------------------------------------------------
  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''));
  filePath = path.normalize(filePath);
  const relativePath = path.relative(ROOT, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access denied');
    return;
  }

  // Block sensitive files and backend internals from being served
  const blockedPatterns = ['.env', '.gitignore', '.agents', 'node_modules', 'contracts', 'tests', 'server.js', 'action-journal.js', 'package.json', 'package-lock.json'];
  const isBlocked = blockedPatterns.some((p) => relativePath === p || relativePath.startsWith(p + path.sep) || relativePath.startsWith('.'));
  if (isBlocked) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(ROOT, 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Cache-Control': 'no-store, max-age=0',
        });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'no-store, max-age=0',
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end();
    });
    stream.pipe(res);
    });
  }).finally(() => {
    if (session?.public) persistPublicMarketSnapshot(session);
    else persistProductStateSnapshot();
  });
});

if (require.main === module) {
  if (process.env.TEMPO_PREPARE_DEMO === 'true') {
    preparePresetDemoWallets().then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.readiness.ready ? 0 : 1);
    }).catch((error) => {
      console.error(error.stack || error.message);
      process.exit(1);
    });
    return;
  }
  refreshBlockNumber();
  setInterval(refreshBlockNumber, 5000).unref();
  server.listen(PORT, HOST, () => {
    console.log('DealArena running at http://' + HOST + ':' + PORT);
    console.log('Market: SIMULATED; connected wallets sign live actions independently.');
    console.log('Owner settlement wallet: ' + (activeWallet ? activeWallet.address : 'not configured'));
  });
}

module.exports = { server, SCENARIOS, scenarioStep, resetState, prepareAction, requireOpen, chunkRecipients, requireNativeBatchSize,
  performDealSettlement, performDealRefund, performRequestSettlement, receiptProof, formatEventLog,
  getState: () => state, provider, centsToPathUsdUnits, pathUsdUnitsToUsd, verifyExternalProof, getPresetDemoReadiness, preparePresetDemoWallets,
  isLiveDealTerminal, isLiveProofDisplayable, liveDealNeedsRecovery,
  setChainForTests: (contract, wallet) => { if (require.main === module) throw new Error('Test injection is unavailable in executable server'); escrowContract = contract; activeWallet = wallet; } };
