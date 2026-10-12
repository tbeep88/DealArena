const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const Market = window.MarketModel;
const presenterAccess = window.DealArenaPresenterAccess.createPresenterAccess({
  location: window.location, history: window.history, storage: window.sessionStorage,
});
let viewEpoch = 0;
let currentDeal = null;
// A fresh jury/session view should start at the open market example even when
// the server retained the last completed presentation. Once the presenter
// runs a scenario, keep showing that run's real progression until refresh or
// an explicit reset.
let userHasRunScenario = false;
let businessStatus = 'COMPETING';
let requestStatus = 'OPEN';
let livePaymentsEnabled = false;
let connectedWalletPaymentsEnabled = false;
let connectedWalletPresent = false;
let connectedWalletOnTempo = false;
let livePublicDemoEnabled = false;
let liveReadinessKnown = false;
let liveReadiness = null;
let liveDemoState = null;
let latestLiveProof = null;
let historicalLiveProof = null;
let liveProofUsed = false;
let liveReceiptAvailable = false;
let simulatedBusinessJoin = null;
let dealStoryEvents = [];
let dealActivityLog = [];
let lastOfferValues = { A: null, B: null, C: null };
let lastDealWinner = -1;
let selectedRequestId = 'laptop';
const requestJoinState = {};
let businessJoinState = null;
let isScenarioActive = false;
let liveLaunchInProgress = false;
let liveLaunchStep = 'idle';
let resetInProgress = null;

// Keep the buyer's own payment state available before the first wallet/readiness
// sync runs. The initial sync happens while this script is loading.
let userJoinedState = {
  dealId: null,
  joined: false,
  buyerNum: 0,
  committedPrice: 0,
  txHash: null,
  receiptId: null,
  isOnChain: false,
};

// --------------------------------------------------------------------------
// Tempo Moderato Testnet Configuration & Dedicated Wallet
// --------------------------------------------------------------------------
const TEMPO_CHAIN_ID = 42431;
const TEMPO_RPC = 'https://rpc.moderato.tempo.xyz';
const TEMPO_EXPLORER = 'https://explore.testnet.tempo.xyz';
let CONTRACT_ADDRESS = '0x8C29c439F5F0161b8ff15d5dc24D89B7f47d47Bb';
const DEDICATED_WALLET_ADDRESS = '0x1eE8d10709a7028475f56988949Fb8aD6158003C';
const PATH_USD_ADDRESS = '0x20c0000000000000000000000000000000000000';

// Jury/public view uses the server-side preset demo wallets for LIVE proof.
// Browser-wallet writes stay off so a page visit can never open a wallet
// chooser or token-approval prompt. The product payment path remains in the
// server/contract code and is exercised by the explicit LIVE proof action.
const BROWSER_WALLET_ACTIONS_ENABLED = false;
const READ_ONLY_FLOW_LABEL = 'See the real payment proof';

function hasConfirmedTempoProof() {
  return [liveDemoState, latestLiveProof, historicalLiveProof].some((entry) => isConfirmedLiveProof(entry))
    || isCurrentPriceLockConfirmed(liveDemoState) || isCurrentRefundConfirmed(liveDemoState);
}

function readOnlyFlowLabel(kind = 'payment') {
  if (!hasConfirmedTempoProof()) return 'Open Tempo demo';
  return READ_ONLY_FLOW_LABEL;
}

function readOnlyFlowTitle(kind = 'payment') {
  return hasConfirmedTempoProof()
    ? 'Opens the confirmed payment record on the Deal page. Sends no transaction.'
    : 'Opens the LIVE proof control on the Deal page. Sends no transaction.';
}

function simulatedBuyerCount(data = currentDeal || canonicalServerState?.deal || {}) {
  return Math.max(0, Number(data.buyers || 0));
}

function syncSimulatedScaleCopy(data = currentDeal || canonicalServerState?.deal || {}) {
  const count = simulatedBuyerCount(data).toLocaleString('en-US');
  const set = (id, value) => { const node = $('#' + id); if (node) node.textContent = value; };
  set('dealIntroBuyerCount', count);
  set('simPaymentBuyerLabel', count);
  set('protocolBuyerNote', `${count}-buyer market example`);
}

// Single source of truth for Business Pool monthly café commitment ($2,048/month)
const CAFE_MONTHLY_COMMITMENT_USD = 2048;
const CAFE_MONTHLY_COMMITMENT_CENTS = 204800;

// Active unique IDs per session/scenario run (synced from server, rotated on every Run & Reset)
let activeIds = {
  dealId: 'DEAL-1042',
  poolId: 'coffee-bulk-1042',
  laptopReqId: 'laptop-req-1042',
  crmReqId: 'crm-req-1042',
};

// Single source of truth for state and scenarios (populated from server /api/state)
let canonicalServerState = null;
let serverScenarios = null;

function applyLiveReadinessStatus(status, ok = true) {
  livePaymentsEnabled = Boolean(status?.livePaymentsEnabled);
  connectedWalletPaymentsEnabled = Boolean(status?.connectedWalletPaymentsEnabled);
  livePublicDemoEnabled = Boolean(status?.publicDemoEnabled && status?.presenterAuthorized);
  liveReadiness = status?.readiness || null;
  liveReadinessKnown = Boolean(ok && status);
  updateLiveAvailability();
}

function connectedWalletReady() {
  return BROWSER_WALLET_ACTIONS_ENABLED
    && liveReadinessKnown
    && connectedWalletPaymentsEnabled
    && connectedWalletPresent
    && connectedWalletOnTempo;
}

function connectedWalletUnavailableText(checking = false) {
  if (checking) return 'Checking Tempo payment…';
  if (!window.ethereum) return 'Tempo wallet not found';
  if (!connectedWalletPresent) return 'Connect wallet to pay';
  if (!connectedWalletOnTempo) return 'Switch wallet to Tempo';
  return 'Tempo payment unavailable';
}

function browserWalletUnavailableText(checking = false) {
  if (checking) return 'Checking LIVE proof…';
  return BROWSER_WALLET_ACTIONS_ENABLED
    ? connectedWalletUnavailableText()
    : 'Use LIVE proof — the demo wallet needs no browser approval';
}

let walletConnectInFlight = null;
async function connectTempoWallet() {
  if (!BROWSER_WALLET_ACTIONS_ENABLED) {
    toast('LIVE proof uses the preset demo wallet. No browser wallet approval is needed.');
    return false;
  }
  if (!window.ethereum) {
    toast('Tempo-compatible wallet not found. Open this page with a wallet extension.');
    return false;
  }
  if (walletConnectInFlight) return walletConnectInFlight;
  walletConnectInFlight = (async () => {
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      // Connecting must not silently open a second wallet permission flow.
      // Network changes are a separate user choice; the payment action will
      // remain unavailable until the user switches to Tempo and clicks again.
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      connectedWalletPresent = true;
      connectedWalletOnTempo = Number.parseInt(String(chainId || '0x0'), 16) === TEMPO_CHAIN_ID;
      updateLiveAvailability();
      void hydrateConnectedWalletState();
      if (!connectedWalletOnTempo) {
        toast('Switch your wallet to Tempo Moderato before paying.');
        return false;
      }
      toast('Wallet connected to Tempo. No payment was sent. Choose the payment action to continue.');
      return true;
    } catch (error) {
      if (error?.code === 4001) toast('Wallet connection was cancelled. No payment was sent.');
      else toast(error?.message || 'Wallet could not be connected. No payment was sent.');
      return false;
    } finally {
      walletConnectInFlight = null;
    }
  })();
  return walletConnectInFlight;
}

function walletCanConnect() {
  return BROWSER_WALLET_ACTIONS_ENABLED
    && Boolean(window.ethereum)
    && liveReadinessKnown
    && connectedWalletPaymentsEnabled;
}

async function ensureTempoWalletForPayment() {
  if (!BROWSER_WALLET_ACTIONS_ENABLED) {
    toast('Use LIVE proof — the demo wallet sends the testnet payment without a browser approval prompt.');
    return false;
  }
  if (connectedWalletReady()) return true;
  if (walletCanConnect()) {
    await connectTempoWallet();
    // Connecting a wallet is deliberately separate from spending. The first
    // click only establishes the wallet/network connection; a later, explicit
    // payment action is the only place that can request token approval or send
    // a buyer/seller transaction.
    return false;
  }
  toast(!window.ethereum
    ? 'Tempo-compatible wallet not found. No payment was sent.'
    : !connectedWalletPresent
      ? 'Connect a Tempo wallet first. No payment was sent.'
      : !connectedWalletOnTempo
        ? 'Switch the connected wallet to Tempo Moderato. No payment was sent.'
        : 'Tempo payment is unavailable. No payment was sent.');
  return false;
}

async function syncConnectedWalletState() {
  // The jury/public view must not even probe the browser wallet provider.
  // Some wallet dispatchers show their chooser on read-only provider calls,
  // so an interval-based accounts/chain check would still create popups.
  if (!BROWSER_WALLET_ACTIONS_ENABLED) {
    connectedWalletPresent = false;
    connectedWalletOnTempo = false;
    updateLiveAvailability();
    return;
  }
  if (!window.ethereum) {
    connectedWalletPresent = false;
    connectedWalletOnTempo = false;
    updateLiveAvailability();
    return;
  }
  try {
    const [accounts, chainId] = await Promise.all([
      window.ethereum.request({ method: 'eth_accounts' }),
      window.ethereum.request({ method: 'eth_chainId' }),
    ]);
    connectedWalletPresent = Array.isArray(accounts) && accounts.length > 0;
    connectedWalletOnTempo = Number.parseInt(String(chainId || '0x0'), 16) === TEMPO_CHAIN_ID;
  } catch {
    connectedWalletPresent = false;
    connectedWalletOnTempo = false;
  }
  updateLiveAvailability();
  void hydrateConnectedWalletState();
}

// Wallet state is never inferred from browser memory. When user-signed
// actions are enabled, refresh reads the user's deposits from the escrow so
// the buttons describe the real chain state and cannot offer a duplicate join.
let walletHydrationInFlight = null;
async function hydrateConnectedWalletState() {
  if (!BROWSER_WALLET_ACTIONS_ENABLED || !connectedWalletPresent || !connectedWalletOnTempo || !window.ethereum || walletHydrationInFlight) return;
  walletHydrationInFlight = (async () => {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const address = (await provider.send('eth_accounts', [])).at(0);
      if (!address) return;
      const contract = new ethers.Contract(CONTRACT_ADDRESS, ESCROW_ABI, provider);
      const [dealDeposit, dealUnits, businessDeposit, laptopDeposit, crmDeposit] = await Promise.all([
        contract.buyerDeposits(activeIds.dealId, address),
        contract.buyerUnits(activeIds.dealId, address),
        contract.businessDeposits(activeIds.poolId, address),
        contract.requestDeposits(activeIds.laptopReqId, address),
        contract.requestDeposits(activeIds.crmReqId, address),
      ]);
      const dealAmount = Number(dealDeposit) / 1000000;
      if (dealAmount > 0 || BigInt(dealUnits) > 0n) {
        userJoinedState = { ...userJoinedState, dealId: activeIds.dealId, joined: true, buyerNum: Number(dealUnits || 1), committedPrice: dealAmount, isOnChain: true };
      } else if (userJoinedState.dealId === activeIds.dealId && !userJoinedState.txHash) {
        userJoinedState.joined = false;
      }
      const businessAmount = Number(businessDeposit) / 1000000;
      businessJoinState = businessAmount > 0 ? { poolId: activeIds.poolId, amount: businessAmount, isOnChain: true } : null;
      const laptopAmount = Number(laptopDeposit) / 1000000;
      const crmAmount = Number(crmDeposit) / 1000000;
      if (laptopAmount > 0) requestJoinState.laptop = { requestId: activeIds.laptopReqId, depositCents: Math.round(laptopAmount * 100), isOnChain: true };
      if (crmAmount > 0) requestJoinState.crm = { requestId: activeIds.crmReqId, depositCents: Math.round(crmAmount * 100), isOnChain: true };
      syncDealCommitAction();
      syncRequestActionCopy();
      updateLiveAvailability();
    } catch {
      // A disconnected or stale deployment must not overwrite the last known
      // UI state; the next explicit wallet/network change will retry.
    } finally {
      walletHydrationInFlight = null;
    }
  })();
}

// Sync live contract address, activeIds, canonical state, and scenarios from backend on startup
async function syncServerState() {
  const epoch = viewEpoch;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) return null;
    const data = await response.json();
    if (epoch !== viewEpoch || !data.state) return null;
    canonicalServerState = data.state;
    liveDemoState = data.state.liveDemo || null;
    latestLiveProof = data.state.latestLiveProof || null;
    historicalLiveProof = data.state.historicalLiveProof || null;
    liveProofUsed = data.state.liveProofUsed === true;
    liveReceiptAvailable = false;
    if (data.state.tempoNetwork?.contract) CONTRACT_ADDRESS = data.state.tempoNetwork.contract;
    if (data.activeIds) activeIds = { ...activeIds, ...data.activeIds };
    syncLiveRequestIds();
    updateHomeTempoProof([latestLiveProof, liveDemoState, historicalLiveProof].find((candidate) => isConfirmedLiveProof(candidate)) || null);
    serverScenarios = data.scenarios || serverScenarios;
    // Render the marketplace as soon as its canonical state arrives. The
    // read-only Tempo readiness check can be slower than the product data and
    // must never leave the page showing zeros while it is still running.
    if (!isScenarioActive) syncCanonicalStateToUi();
    try {
      const statusResponse = await fetch('/api/tempo/status', { headers: presenterAccess.headers() });
      const status = statusResponse.ok ? await statusResponse.json() : null;
      if (status && canonicalServerState?.tempoNetwork) {
        // Keep the page snapshot aligned with the authoritative readiness
        // endpoint; the initial /api/state object is intentionally cheap and
        // may still contain its startup value.
        canonicalServerState.tempoNetwork.livePaymentsEnabled = Boolean(status.livePaymentsEnabled);
        canonicalServerState.tempoNetwork.status = status.connected ? 'CONNECTED' : 'STANDBY';
      }
      applyLiveReadinessStatus(status, statusResponse.ok);
    } catch {
      livePaymentsEnabled = false;
      connectedWalletPaymentsEnabled = false;
      livePublicDemoEnabled = false;
      liveReadiness = null;
      liveReadinessKnown = true;
    }
    // Readiness is global runtime state, not page state. The RPC check can
    // finish after the user navigates, so never discard it just because the
    // current view epoch changed while the status request was in flight.
    if (epoch !== viewEpoch) {
      updateLiveAvailability();
      return data;
    }
    updateLiveAvailability();
    void checkLivePendingReceipt();
    if (!isScenarioActive) syncCanonicalStateToUi();
    return data;
  } catch { return null; }
}
syncServerState();
void syncConnectedWalletState();
if (BROWSER_WALLET_ACTIONS_ENABLED && window.ethereum?.on) {
  window.ethereum.on('accountsChanged', () => { void syncConnectedWalletState(); });
  window.ethereum.on('chainChanged', () => { void syncConnectedWalletState(); });
}

// Preparation happens outside the browser (once per presenter session). Poll
// the read-only readiness endpoint so an already-open jury page unlocks LIVE
// automatically after that preparation finishes; no transaction is sent here.
setInterval(async () => {
  try {
    const [statusResponse, stateResponse] = await Promise.all([
      fetch('/api/tempo/status', { cache: 'no-store', headers: presenterAccess.headers() }),
      fetch('/api/state', { cache: 'no-store' }),
    ]);
    const status = statusResponse.ok ? await statusResponse.json() : null;
    applyLiveReadinessStatus(status, statusResponse.ok);
    void syncConnectedWalletState();
    if (stateResponse.ok) {
      const data = await stateResponse.json();
      if (data.state) {
        liveDemoState = data.state.liveDemo || null;
        latestLiveProof = data.state.latestLiveProof || null;
        historicalLiveProof = data.state.historicalLiveProof || null;
        liveProofUsed = data.state.liveProofUsed === true;
        canonicalServerState = canonicalServerState
          ? { ...canonicalServerState, liveDemo: liveDemoState, liveProofUsed }
          : data.state;
        updateHomeTempoProof([latestLiveProof, liveDemoState, historicalLiveProof].find((candidate) => isConfirmedLiveProof(candidate)) || null);
        updateLiveAvailability();
      }
    }
  } catch {
    // Keep the last known state; the next poll will retry without disabling
    // an already-ready live proof because of one transient RPC failure.
  }
}, 10000);

const TIP20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ESCROW_ABI = [
  'function joinDeal(string dealId, uint256 depositAmount) returns (bool)',
  'function joinDealUnits(string dealId, uint256 depositAmount, uint256 units) returns (bool)',
  'function topUpDeal(string dealId, uint256 amount) returns (bool)',
  'function submitOfferWithCapacity(string dealId, string sellerName, uint256 price, uint256 guaranteeBond, uint256 minimumBuyerCount, uint256 maxBuyerUnits, uint256 offerExpiry) returns (bool)',
  'function submitPriceLadder(string dealId, uint256[] prices, uint256[] minimumBuyerCounts, uint256 maxBuyerUnits, uint256 offerExpiry, uint256 guaranteeBond) returns (bool)',
  'function settleDeal(string dealId) returns (bool)',
  'function confirmDealFulfillment(string dealId) returns (bool)',
  'function slashSettledDealGuarantee(string dealId, string reason) returns (bool)',
  'function disburseSurplusBatch(string dealId, address[] recipients) returns (bool)',
  'function refundDeal(string dealId, string reason) returns (bool)',
  'function refundBatch(string dealId, address[] recipients) returns (bool)',
  'function slashSellerGuarantee(string dealId, string reason) returns (bool)',
  'function joinBusinessPool(string poolId, uint256 commitmentAmount) returns (bool)',
  'function submitBusinessOffer(string poolId, string supplierName, uint256 discountPercent, uint256 guaranteeBond) returns (bool)',
  'function submitBusinessOfferWithCapacity(string poolId, string supplierName, uint256 discountPercent, uint256 guaranteeBond, uint256 maxBuyerCount, uint256 offerExpiry) returns (bool)',
  'function settleBusinessPool(string poolId) returns (bool)',
  'function finalizeBusinessPoolAfterDeadline(string poolId, string reason) returns (bool)',
  'function refundBusinessPool(string poolId, string reason) returns (bool)',
  'function refundBusinessBatch(string poolId, address[] recipients) returns (bool)',
  'function disburseBusinessSavings(string poolId, address[] recipients) returns (bool)',
  'function createRequest(string requestId, string title, uint256 maxPrice, uint256 authAmount) returns (bool)',
  'function joinRequest(string requestId, uint256 authAmount) returns (bool)',
  'function fundRequest(string requestId, uint256 amount) returns (bool)',
  'function submitRequestOffer(string requestId, string supplierName, uint256 price, uint256 guaranteeBond) returns (bool)',
  'function submitRequestOfferWithCapacity(string requestId, string supplierName, uint256 price, uint256 guaranteeBond, uint256 maxBuyerCount, uint256 offerExpiry) returns (bool)',
  'function settleRequest(string requestId) returns (bool)',
  'function finalizeRequestAfterDeadline(string requestId, string reason) returns (bool)',
  'function refundRequest(string requestId, string reason) returns (bool)',
  'function refundRequestBatch(string requestId, address[] recipients) returns (bool)',
  'function getDealState(string dealId) view returns (uint256, uint256, address, uint256, uint256, bool, bool)',
  'function buyerDeposits(string dealId, address buyer) view returns (uint256)',
  'function buyerUnits(string dealId, address buyer) view returns (uint256)',
  'function businessDeposits(string poolId, address buyer) view returns (uint256)',
  'function requestDeposits(string requestId, address buyer) view returns (uint256)',
  'function businessPools(string poolId) view returns (uint256, uint256, uint256, address, uint256, bool, bool)',
  'function demandRequests(string requestId) view returns (uint256, uint256, address, uint256, uint256, uint256, bool, bool)',
];

// Baseline Marketplace Data
const simulatedBuyerNames = ['Marcus T.', 'Elena R.', 'Alex C.', 'Sarah M.', 'David K.', 'Chloe P.', 'Liam B.', 'Nina S.', 'James W.', 'Sofia L.'];

const avatarColors = [
  { bg: '#fef3c7', text: '#b45309' }, // Amber
  { bg: '#e0e7ff', text: '#4338ca' }, // Indigo
  { bg: '#ecfdf5', text: '#047857' }, // Emerald
  { bg: '#f3e8ff', text: '#7e22ce' }, // Purple
  { bg: '#ffe4e6', text: '#be123c' }, // Rose
  { bg: '#e0f2fe', text: '#0369a1' }, // Sky
  { bg: '#fef9c3', text: '#a16207' }, // Yellow
];

function getFormattedTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function createTxLink(hash) {
  const shortHash = `${hash.slice(0, 6)}...${hash.slice(-4)}`;
  const link = document.createElement('a');
  link.className = 'tx-link';
  link.href = `${TEMPO_EXPLORER}/receipt/${hash}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = shortHash;
  return link;
}

function isConfirmedLiveProof(proof) {
  const receipts = Array.isArray(proof?.receipts) ? proof.receipts : [];
  return Boolean(
    proof?.chainVerified === true
    && proof?.settlementSummary
    && receipts.length > 0
    && receipts.every((receipt) => receipt?.status === 'CONFIRMED' && receipt?.isOnChain === true && /^0x[\da-f]{64}$/i.test(String(receipt.hash || ''))),
  );
}

function isCurrentPriceLockConfirmed(proof) {
  return Boolean(proof === liveDemoState
    && ['SETTLED', 'AWAITING_FULFILLMENT'].includes(proof?.status)
    && proof.settlementSummary && proof.receipts?.length > 0
    && proof.receipts.every((receipt) => receipt.status === 'CONFIRMED' && receipt.isOnChain === true && /^0x[\da-f]{64}$/i.test(String(receipt.hash || '')))
    && proof.receipts.some((receipt) => receipt.hash === proof.settlementHash));
}

function isCurrentRefundConfirmed(proof) {
  const summary = proof?.refundReceipt?.settlementSummary;
  return Boolean(proof === liveDemoState && proof?.status === 'REFUNDED'
    && summary && Number(summary.sellerPayoutCents) === 0 && Number(summary.feeCents) === 0
    && Number(summary.buyerRefundCents) === Number(summary.committedCents)
    && /^0x[\da-f]{64}$/i.test(String(proof.refundHash || ''))
    && proof.receipts?.length > 0
    && proof.receipts.every((receipt) => receipt.status === 'CONFIRMED' && receipt.isOnChain === true && /^0x[\da-f]{64}$/i.test(String(receipt.hash || '')))
    && proof.receipts.some((receipt) => receipt.hash === proof.refundHash));
}

function resetAvatarCrowd() {
  const stack = $('#dealAvatarStack');
  if (stack) stack.replaceChildren();
  const activeCount = $('#crowdActiveCount');
  const buyers = Number(currentDeal?.buyers || canonicalServerState?.deal?.buyers || 0);
  lastCrowdBuyerCount = 0;
  if (activeCount) activeCount.textContent = String(buyers);
  const dep = $('#dealEscrowPool');
  const committed = currentDeal?.accounting?.committedCents;
  const closed = Market.terminal(currentDeal?.status);
  if (dep) dep.textContent = committed !== undefined ? Market.dollars(committed) : '—';
  const cet = $('#crowdEscrowText');
  if (cet) cet.textContent = dep?.textContent ? `${dep.textContent} ${closed ? 'example total' : 'example total'}` : '—';
  renderBuyerProgress(buyers);
}

function renderBuyerProgress(count = 0) {
  const target = Number(currentDeal?.sellerLadder?.tiers?.at(-1)?.buyers || 500);
  const safeCount = Math.max(0, Math.min(Number(count || 0), target));
  const percent = Math.min(100, Math.round(safeCount / target * 100));
  const countLabel = $('#buyerCrowdProgressCount');
  const label = $('#buyerCrowdProgressLabel');
  const progress = $('#dealCrowdProgress');
  if (countLabel) countLabel.textContent = `${safeCount.toLocaleString('en-US')} / ${target.toLocaleString('en-US')}`;
  if (label) label.textContent = `${percent}%`;
  if (progress) progress.style.width = `${percent}%`;
}

let lastCrowdBuyerCount = 0;

function updateAvatarCrowd(count, newBuyer = null, isUser = false, explicitUnitPrice = null) {
  const stack = $('#dealAvatarStack');
  const activeCount = $('#crowdActiveCount');
  const grew = Number(count) > lastCrowdBuyerCount;
  if (activeCount) activeCount.textContent = String(count);

  const unitPrice = explicitUnitPrice ?? numericValue(currentDeal?.best);
  const totalCommitted = (currentDeal?.accounting?.committedCents ?? 0) / 100;
  const commitmentStr = `$${totalCommitted.toLocaleString('en-US')}`;
  const dep = $('#dealEscrowPool');
  if (dep) {
    if (dep.textContent !== commitmentStr) pulseValue(dep);
    dep.textContent = commitmentStr;
  }
  const cet = $('#crowdEscrowText');
  if (cet) cet.textContent = `${commitmentStr} example total`;
  renderBuyerProgress(count);

  const crowdStrip = $('.buyer-crowd-strip');
  if (grew && crowdStrip) {
    crowdStrip.classList.remove('crowd-growing');
    void crowdStrip.offsetWidth;
    crowdStrip.classList.add('crowd-growing');
    setTimeout(() => crowdStrip.classList.remove('crowd-growing'), 1500);
  }

  if (!stack) return;

  if (isUser) {
    const existing = stack.querySelector('.avatar-bubble.is-you');
    if (existing) existing.remove();
    const userBubble = document.createElement('span');
    userBubble.className = 'avatar-bubble is-you just-joined';
    userBubble.style.background = '#fed7aa';
    userBubble.style.color = '#c2410c';
    userBubble.title = `You (Buyer #${count}) · example buyer`;
    userBubble.textContent = 'YOU';
    stack.prepend(userBubble);
  } else if (newBuyer) {
    const bubble = document.createElement('span');
    bubble.className = 'avatar-bubble just-joined';
    const initials = newBuyer.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || 'B';
    const color = avatarColors[Math.abs(count) % avatarColors.length];
    bubble.style.background = color.bg;
    bubble.style.color = color.text;
    bubble.title = `${newBuyer} (Buyer #${count}) · example buyer`;
    bubble.textContent = initials;
    const youBubble = stack.querySelector('.avatar-bubble.is-you');
    if (youBubble) {
      youBubble.after(bubble);
    } else {
      stack.prepend(bubble);
    }
  }

  while (stack.querySelectorAll('.avatar-bubble').length > 5) {
    const nonUserBubbles = [...stack.querySelectorAll('.avatar-bubble:not(.is-you)')];
    if (!nonUserBubbles.length) break;
    nonUserBubbles[nonUserBubbles.length - 1].remove();
  }

  let more = $('#avatarMoreCount', stack);
  if (!more) {
    more = document.createElement('span');
    more.className = 'avatar-more';
    more.id = 'avatarMoreCount';
    stack.appendChild(more);
  }
  const curVisible = stack.querySelectorAll('.avatar-bubble').length;
  const remaining = Math.max(0, count - curVisible);
  more.textContent = `+${remaining}`;
  lastCrowdBuyerCount = Number(count) || 0;
}

// Single Source of Truth Deal State (populated from server /api/state)
function getDealDefaults() {
  if (canonicalServerState && canonicalServerState.deal) {
    const storedDeal = canonicalServerState.deal;
    const juryStart = !userHasRunScenario && Market.terminal(storedDeal.status)
      ? serverScenarios?.normal?.[1]
      : null;
    const sourceDeal = juryStart
      ? { ...storedDeal, ...juryStart, dealId: storedDeal.dealId, title: storedDeal.title }
      : storedDeal;
    const rawLog = sourceDeal.log;
    const normalizedLog = Array.isArray(rawLog)
      ? rawLog.map((entry) => Array.isArray(entry) ? [...entry] : [getFormattedTime(), String(entry)])
      : rawLog ? [[getFormattedTime(), String(rawLog)]] : [];
    return {
      ...sourceDeal,
      ladder: [...(sourceDeal.ladder || ['—', '—', '—', '—'])],
      offers: [...(sourceDeal.offers || ['—', '—', '—'])],
      log: normalizedLog,
    };
  }
  return {
    buyers: 0,
    retail: '—',
    best: '—',
    saving: '—',
    status: 'OPEN',
    ladder: ['—', '—', '—', '—'],
    offers: ['—', '—', '—'],
    winnerIndex: -1,
    winnerSeller: null,
    depositUnitPrice: 0,
    offerStatus: 'COMPETING',
    timer: '—',
    log: [],
  };
}

function syncCanonicalStateToUi() {
  const source = canonicalServerState;
  if (!source) return;
  if (source.deal) applyDeal(getDealDefaults(), 0, 1);
  const business = { ...(source.business || {}) };
  if (simulatedBusinessJoin) {
    business.buyers = simulatedBusinessJoin.buyers;
    business.demand = simulatedBusinessJoin.demand;
    business.stage = `${simulatedBusinessJoin.buyers} joined`;
    business.log = [simulatedBusinessJoin.log, ...(business.log || [])];
  }
  const supplierCount = [business.offerA, business.offerB, business.offerC]
    .filter((offer) => offer && offer !== '—').length;
  businessStatus = business.status || 'COMPETING';
  for (const [id, value] of [
    ['businessBuyerCount', business.buyers],
    ['homeBusinessCount', business.buyers],
    ['businessDemand', business.demand],
    ['businessDemandSummary', business.demand],
    ['homeBusinessDemand', business.demand],
    ['homeBusinessSuppliers', supplierCount],
    ['businessSuppliersCount', supplierCount],
    ['businessOffer', business.offer],
    ['homeBusinessOffer', business.offer],
    ['businessStage', business.stage],
    ['bizOfferStatus', displayBusinessStatus(business.status)],
    ['demandGroupCount', `${$$('.demand-item').length || 3} groups`],
  ]) {
    if ($('#' + id) && value !== undefined) $('#' + id).textContent = String(value);
  }
  syncBusinessProgress(Number(business.buyers) || 0);
  syncBusinessSuppliers(business.offerA || '—', business.offerB || '—', business.offerC || business.offer || '—', business.winnerId || 'C');
  updateBusinessEconomics(business);
  renderMiniLog('businessLog', business.log || []);
  renderSecondaryPaymentLedger('businessPaymentLedger', Market.flatSimulatedPaymentLedger('business', Number(business.buyers || 0), CAFE_MONTHLY_COMMITMENT_USD * 100, business.status === 'WON' ? 'WON' : 'OPEN', CAFE_MONTHLY_COMMITMENT_USD * 100), {
    countId: 'businessPaymentCount', amountId: 'businessMoneyLocked', statusId: 'businessPaymentStatus', noteId: 'businessPaymentNote', label: 'business commitments'
  });
  const requests = source.requests || [];
  const laptop = requests.find((entry) => entry.id === activeIds.laptopReqId) || requests[0] || {};
  const crm = requests.find((entry) => entry.id === activeIds.crmReqId) || requests[1] || {};
  requestStatus = laptop.status || 'OPEN';
  for (const [id, value] of [
    ['openRequestBuyers', laptop.buyers],
    ['homeRequestOffers', laptop.offers],
    ['homeRequestBuyers', laptop.buyers],
    ['openRequestOfferCount', laptop.offers],
    ['openRequestBestPrice', laptop.bestPrice],
    ['homeRequestBestPrice', laptop.bestPrice],
    ['laptopDemandBest', laptop.bestPrice],
    ['homeRequestSavings', laptop.savings],
    ['crmRequestBuyers', crm.buyers],
    ['crmRequestOfferCount', crm.offers],
    ['crmRequestBestPrice', crm.bestPrice],
  ]) {
    if ($('#' + id) && value !== undefined) $('#' + id).textContent = String(value);
  }
  if ($('#laptopDemandMeta') && laptop.meta) $('#laptopDemandMeta').textContent = laptop.meta;
  renderSecondaryPaymentLedger('requestPaymentLedger', Market.flatSimulatedPaymentLedger('request-laptop', Number(laptop.buyers || 0), 70000, laptop.status === 'WON' ? 'WON' : 'OPEN', 70000), {
    countId: 'requestPaymentCount', amountId: 'requestMoneyLocked', statusId: 'requestPaymentStatus', noteId: 'requestPaymentNote', label: 'funded requests'
  });
  const coffeeDemand = $('.demand-item[data-title="Coffee supplies"]');
  if (coffeeDemand) {
    coffeeDemand.dataset.price = business.offer || '−24%';
    coffeeDemand.querySelector('small')?.replaceChildren(document.createTextNode(`${business.buyers || 0} cafés · ${business.demand || 'ready to buy'} · open`));
    const coffeeBest = $('#coffeeDemandBest');
    if (coffeeBest) coffeeBest.textContent = business.offer || '−24%';
  }
  const laptopDemand = $('.demand-item[data-title="Laptop under $700"]');
  if (laptopDemand) {
    laptopDemand.dataset.price = laptop.bestPrice || '—';
    laptopDemand.querySelector('small')?.replaceChildren(document.createTextNode(laptop.meta || `${laptop.buyers || 0} people · open`));
  }
  const phoneDemand = $('.demand-item[data-title="Phone group order"]');
  const phoneIsClosed = Market.terminal(source.deal?.status);
  if (phoneDemand) {
    phoneDemand.dataset.closed = String(phoneIsClosed);
    phoneDemand.disabled = phoneIsClosed;
    phoneDemand.setAttribute('aria-disabled', String(phoneIsClosed));
    phoneDemand.title = phoneIsClosed
      ? 'This example is complete. Choose an open group to publish an offer.'
      : 'Choose this group to publish a seller offer.';
  }
  const openSellerDemand = $$('.demand-item').find((item) => item.dataset.closed !== 'true' && !item.disabled)
    || $$('.demand-item').find((item) => item.dataset.closed !== 'true');
  $$('.demand-item').forEach((item) => {
    const selected = item === openSellerDemand;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
  const sellerProduct = $('#offerProduct');
  const sellerValueLabel = $('#offerValueLabel');
  const selectedSellerTitle = openSellerDemand?.dataset.title || 'No open group available';
  if (sellerProduct) sellerProduct.textContent = selectedSellerTitle;
  if (sellerValueLabel) sellerValueLabel.textContent = selectedSellerTitle === 'Coffee supplies' ? 'Your discount' : 'Your price per item';
  if (openSellerDemand) syncSellerOfferForm(selectedSellerTitle, suggestNextBetterOffer(selectedSellerTitle, openSellerDemand.dataset.price));
  if ($('#phoneDemandMeta') && currentDeal) syncSellerPhone(currentDeal.buyers, currentDeal.retail, currentDeal.best, currentDeal.timer, currentDeal.accounting?.committedCents, currentDeal.offers);
  syncRequestActionCopy();
  updateMarketSummary();
  updateLiveAvailability();
}

function clearUserJoinedState() {
  userJoinedState = {
    dealId: null,
    joined: false,
    buyerNum: 0,
    committedPrice: 0,
    txHash: null,
    receiptId: null,
    isOnChain: false,
  };
}

let timers = [];
let toastTimer;
let addedRequestBuyers = 0;
let addedRequestDemand = 0;
let lastTxHash = null;

// Clock Countdown State — the demo order stays open for five hours.
const DEAL_DEADLINE_SECONDS = 5 * 60 * 60;
let dealTimeSeconds = DEAL_DEADLINE_SECONDS;
let coffeeTimeSeconds = 166;    // 02:46
let laptopTimeSeconds = 499;    // 08:19

function formatSeconds(totalSec) {
  if (totalSec <= 0) return '00:00';
  const hours = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function dealTimerLabel(data = {}) {
  if (['WON', 'REFUNDED', 'FAILED'].includes(data.status)) return data.timer || 'CLOSED';
  return formatSeconds(DEAL_DEADLINE_SECONDS);
}

let lastHomeWinnerIndex = -1;
let lastHomeOfferValues = [];

function pulseValue(el) {
  if (!el) return;
  el.classList.remove('value-pulse');
  void el.offsetWidth;
  el.classList.add('value-pulse');
  setTimeout(() => el.classList.remove('value-pulse'), 350);
}

let lastUnlockedTierIndex = 0;

function updateMarketPulse() {
  const closed = Market.terminal(currentDeal?.status);
  // A closed market should keep its final historical totals visible. Showing
  // zero here made the pulse contradict the settled deal card below it.
  const buyers = currentDeal?.buyers ?? 0;
  const sellers = (currentDeal?.offers || []).filter((offer) => String(offer).startsWith('$')).length;
  const committed = currentDeal?.accounting?.committedCents ?? 0;
  if ($('#pulseBuyers')) $('#pulseBuyers').textContent = String(buyers);
  if ($('#pulseSellers')) $('#pulseSellers').textContent = String(sellers);
  if ($('#pulseCommitted')) $('#pulseCommitted').textContent = Market.dollars(committed);
  if ($('#pulseTime')) $('#pulseTime').textContent = closed ? 'Deal closed' : ($('#dealTimer')?.textContent || '—');
  if ($('#pulseTimeSuffix')) $('#pulseTimeSuffix').textContent = closed ? '' : ' left';
  if ($('#dealRuleEnds')) $('#dealRuleEnds').textContent = closed ? 'Closed' : ($('#dealTimer')?.textContent || '—');
}

function updateFundedDemand(data = currentDeal || {}) {
  const accounting = data.accounting || {};
  const buyers = Number(data.buyers || 0);
  const bestOffer = data.winnerIndex >= 0 ? data.offers?.[data.winnerIndex] : data.best;
  const buyerEl = $('#fundedBuyers');
  const demandEl = $('#fundedDemand');
  const offerEl = $('#fundedBestOffer');
  const sellerEl = $('#fundedBestSeller');
  const stateEl = $('#fundedDemandState');
  if (buyerEl) buyerEl.textContent = buyers.toLocaleString('en-US');
  if (demandEl) demandEl.textContent = formatMetricCents(accounting.committedCents);
  if (offerEl) offerEl.textContent = bestOffer || '—';
  if (sellerEl) sellerEl.textContent = data.winnerSeller ? `${data.winnerSeller} · lowest price` : 'seller prices';
  if (stateEl) stateEl.textContent = 'EXAMPLE MARKET';
}

// Keep UI strictly synchronized with server state and real user/scenario actions

// Background Clock Ticker
setInterval(() => {
  if (isScenarioActive) return;
  if ($('#dealStatus')?.textContent === 'OPEN') {
    if (dealTimeSeconds > 0) dealTimeSeconds--;
    const str = formatSeconds(dealTimeSeconds);
    const dt = $('#dealTimer');
    const hdt = $('#homeDealTime');
    if (dt) dt.textContent = str;
    if (hdt) hdt.textContent = `${str} left`;
    const buyers = Number(currentDeal?.buyers ?? numericValue($('#dealBuyerCount')?.textContent) ?? 0);
    const retail = numericValue(currentDeal?.retail || $('#dealRetail')?.textContent || 0);
    const demand = Math.round((buyers * retail) / 1000);
    const pdm = $('#phoneDemandMeta');
    if (pdm) pdm.textContent = `${buyers} example buyers · $${demand}k calculated total · ${str} left`;
    updateMarketPulse();
  }
  if (!Market.terminal(businessStatus)) {
    if (coffeeTimeSeconds > 0) coffeeTimeSeconds--;
    const str = formatSeconds(coffeeTimeSeconds);
    if ($('#homeBusinessTime')) $('#homeBusinessTime').textContent = str + ' left';
    const cafes = numericValue($('#businessBuyerCount')?.textContent);
    const demand = numericValue($('#businessDemand')?.textContent);
    if ($('#coffeeDemandMeta')) $('#coffeeDemandMeta').textContent = cafes + ' cafés · $' + Math.round(demand / 1000) + 'k / month · ' + str + ' left';
  }
  if (!Market.terminal(requestStatus)) {
    if (laptopTimeSeconds > 0) laptopTimeSeconds--;
    const str = formatSeconds(laptopTimeSeconds);
    if ($('#homeRequestTime')) $('#homeRequestTime').textContent = str + ' left';
    const buyers = numericValue($('#openRequestBuyers')?.textContent);
    const price = numericValue($('#openRequestBestPrice')?.textContent);
    if ($('#laptopDemandMeta')) $('#laptopDemandMeta').textContent = buyers + ' people · $' + Math.round(buyers * price / 1000) + 'k · ' + str + ' left';
  }
}, 1000);

function numericValue(value) {
  return Number(String(value || '').replace(/[^\d.]/g, '')) || 0;
}

function updateMarketSummary() {
  // Terminal markets remain part of the marketplace history. Dropping them
  // from the headline totals made the Home page visibly shrink at the exact
  // moment a demo reached its strongest result.
  const phoneBuyers = currentDeal?.buyers ?? 0;
  const phoneOffer = numericValue(currentDeal?.best);
  const phoneRetail = numericValue(currentDeal?.retail);
  const businessBuyers = numericValue($('#businessBuyerCount')?.textContent);
  const businessDemand = businessBuyers ? numericValue($('#businessDemand')?.textContent) : 0;
  const businessDiscount = numericValue($('#businessOffer')?.textContent);
  const requestBuyers = numericValue($('#openRequestBuyers')?.textContent);
  const requestOffer = numericValue($('#openRequestBestPrice')?.textContent);
  const requestCap = numericValue(canonicalServerState?.requests?.find((entry) => entry.id === activeIds.laptopReqId)?.maxPrice);
  const demand = phoneBuyers * phoneRetail + businessDemand + requestBuyers * requestCap;
  const saved = (phoneOffer ? Math.max(0, phoneRetail - phoneOffer) * phoneBuyers : 0) + businessDemand * businessDiscount / 100 + (requestOffer ? Math.max(0, requestCap - requestOffer) * requestBuyers : 0);
  if ($('#buyersStat')) $('#buyersStat').textContent = (phoneBuyers + businessBuyers + requestBuyers).toLocaleString('en-US');
  if ($('#demandStat')) $('#demandStat').textContent = '$' + Math.round(demand / 1000).toLocaleString('en-US') + 'k';
  if ($('#savingsStat')) $('#savingsStat').textContent = demand ? (saved / demand * 100).toFixed(1) + '%' : '0%';
  if ($('#homeRequestSavings')) $('#homeRequestSavings').textContent = requestOffer && requestCap ? '$' + Math.max(0, requestCap - requestOffer) : '—';
  updateProtocolEconomics();
}

function formatMetricCents(value) {
  return Market.dollars(Math.max(0, Math.round(Number(value) || 0)));
}

function updateProtocolEconomics() {
  const accounting = currentDeal?.accounting || canonicalServerState?.deal?.accounting || {};
  const committed = Number(accounting.committedCents || 0);
  const volume = Number(accounting.grossCents || 0);
  const fee = Number(accounting.feeCents || 0);
  const payout = Number(accounting.payoutCents || 0);
  const refund = Number(accounting.refundedCents || 0);
  const settled = currentDeal?.status === 'WON';
  const refunded = currentDeal?.status === 'REFUNDED';
  const potentialFee = Math.floor(volume / 100);
  const displayedFee = settled ? fee : refunded ? 0 : potentialFee;
  const displayedPayout = settled ? payout : refunded ? 0 : Math.max(0, volume - potentialFee);
  const liveReceipts = Array.isArray(liveDemoState?.receipts) ? liveDemoState.receipts : [];
  const confirmedLive = liveReceipts.filter((receipt) => receipt.status === 'CONFIRMED').length;
  const buyerReceipt = liveReceipts.find((receipt) => receipt.actor === 'buyer');
  const liveDeposit = Number(buyerReceipt?.unitPriceCents || 0);
  const state = $('#protocolEconomicsState');
  const proof = $('#protocolProofSummary');
  const note = $('#protocolEconomicsNote');

  for (const [id, value] of [
    ['protocolCommitted', committed],
    ['protocolVolume', volume],
    ['protocolFee', displayedFee],
    ['protocolPayout', displayedPayout],
    ['protocolRefund', refund],
  ]) {
    const element = $('#' + id);
    if (element) element.textContent = formatMetricCents(value);
  }
  if (state) state.textContent = confirmedLive ? 'TEMPO CONFIRMED' : 'TEMPO PAYMENT REQUIRED';
  if (proof) proof.textContent = confirmedLive
    ? `${confirmedLive} real test payments confirmed · buyer money ${formatMetricCents(liveDeposit)}`
    : 'No real Tempo payment has been confirmed for this order yet.';
  if (note) {
    note.textContent = settled
      ? 'The order is complete: DealArena takes 1%, and the seller gets the rest.'
      : refunded
        ? 'The order did not close, so buyers get their money back. No fee is charged.'
        : 'These are example numbers. DealArena earns 1% only after the order is complete.';
  }
  const volumeLabel = $('#protocolVolumeLabel');
  const feeLabel = $('#protocolFeeLabel');
  const payoutLabel = $('#protocolPayoutLabel');
  if (volumeLabel) volumeLabel.textContent = settled ? 'Final order price' : 'Possible final price';
  if (feeLabel) feeLabel.textContent = settled ? 'Platform fee' : refunded ? 'Platform fee' : 'Platform fee if complete';
  if (payoutLabel) payoutLabel.textContent = settled ? 'Seller gets' : refunded ? 'Seller gets' : 'Seller gets if complete';
}

function updateBusinessEconomics(business = canonicalServerState?.business || {}) {
  const monthlyDemandCents = Math.round(Math.max(0, numericValue(business.demand)) * 100);
  const discountPercent = Math.max(0, numericValue(business.offer || business.bestOffer));
  const matchedVolumeCents = Math.round(monthlyDemandCents * Math.max(0, 1 - discountPercent / 100));
  const feeCents = Math.floor(matchedVolumeCents / 100);
  const supplierPayoutCents = Math.max(0, matchedVolumeCents - feeCents);
  const buyerSavingsCents = Math.max(0, monthlyDemandCents - matchedVolumeCents);
  for (const [id, value] of [
    ['businessEconomicsVolume', matchedVolumeCents],
    ['businessEconomicsPayout', supplierPayoutCents],
    ['businessEconomicsFee', feeCents],
    ['businessEconomicsSavings', buyerSavingsCents],
  ]) {
    const element = $('#' + id);
    if (element) element.textContent = formatMetricCents(value);
  }
  const note = $('#businessEconomicsNote');
  if (note) note.textContent = discountPercent
    ? `${business.buyers || 0} cafés combine one predictable order. At this offer, the group could save ${formatMetricCents(buyerSavingsCents)}; DealArena earns 1% only if the order completes.`
    : 'More cafés can join. A larger order gives suppliers a reason to compete.';
}

function toast(message) {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.classList.remove('show');
    element.textContent = '';
  }, 2600);
}

async function shareCurrentDeal() {
  const best = currentDeal?.best || 'a better price';
  const buyers = Number(currentDeal?.buyers || 0).toLocaleString('en-US');
  const ladder = currentDeal?.sellerLadder;
  const nextTier = ladder?.tiers?.find((tier) => Number(currentDeal?.buyers || 0) < Number(tier.buyers || 0));
  const unlockText = nextTier
    ? `${nextTier.buyers} buyers unlock ${nextTier.price}`
    : `the example is at ${best}`;
  const shareData = {
    title: 'DealArena · Phone group order',
    text: `See this DealArena group-order example: ${buyers} buyers at ${best}; ${unlockText}.`,
    url: `${window.location.origin}${window.location.pathname}#deal`,
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      toast('Deal shared.');
      return;
    }
    await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`);
    toast('Deal link copied.');
  } catch (error) {
    if (error?.name !== 'AbortError') toast('Copy the link from your browser to invite someone.');
  }
}

function updateProgress(count) {
  const dealClosed = Market.terminal(currentDeal?.status);
  const closedWithoutSale = currentDeal?.status === 'REFUNDED';
  const ladderTiers = Array.isArray(currentDeal?.priceTiers) && currentDeal.priceTiers.length
    ? currentDeal.priceTiers
    : currentDeal?.sellerLadder?.tiers || [];
  const target = Number(ladderTiers.at(-1)?.buyers || 500);
  const progress = Math.max(0, Math.min(100, (count / target) * 100));
  const dp = $('#dealProgress');
  if (dp) dp.style.width = `${progress}%`;
  const fallbackTiers = [
    { buyers: 200, price: currentDeal?.ladder?.[1] || $('#tier2Price')?.textContent || '—' },
    { buyers: 500, price: currentDeal?.ladder?.[2] || $('#tier3Price')?.textContent || '—' },
    { buyers: 800, price: currentDeal?.ladder?.[3] || $('#tier4Price')?.textContent || '—' },
  ];
  const tiers = [
    { buyers: 0, price: currentDeal?.ladder?.[0] || '—' },
    ...fallbackTiers.map((fallback, index) => ({
      buyers: Number(ladderTiers[index]?.buyers || fallback.buyers),
      price: ladderTiers[index]?.price || fallback.price,
    })),
  ];
  const h2 = $('#homeTier2Price');
  const h3 = $('#homeTier3Price');
  const h4 = $('#homeTier4Price');
  if (h2) h2.textContent = tiers[1].price;
  if (h3) h3.textContent = tiers[2].price;
  if (h4) h4.textContent = tiers[3].price;
  const nextTier = dealClosed ? null : tiers.slice(1).find((tier) => count < tier.buyers);
  const btn = $('#buyersToNextTier');
  if (btn) btn.textContent = closedWithoutSale ? 'No sale in this example' : dealClosed ? `Order complete at ${currentDeal?.best || 'the final price'}` : nextTier ? `${nextTier.buyers - count} more buyers to reach ${nextTier.price}` : 'Lowest example price reached';
  const shareReason = $('#homeShareReason');
  if (shareReason) shareReason.textContent = closedWithoutSale
    ? 'No sale in this example'
    : dealClosed
    ? `Order complete at ${currentDeal?.best || 'the locked price'}`
    : nextTier
    ? `${nextTier.buyers - count} more example buyers unlock ${nextTier.price}`
    : 'The lowest published example tier is active';
  const shareHint = $('#dealShareHint');
  if (shareHint) shareHint.textContent = closedWithoutSale
    ? 'No completed sale in this example.'
    : dealClosed
    ? `This order is complete at ${currentDeal?.best || 'the locked price'}.`
    : nextTier
    ? `${nextTier.buyers - count} more example buyers unlock ${nextTier.price}.`
    : 'The lowest published example tier is active.';
  const currentTier = tiers.slice(1).filter((tier) => count >= tier.buyers).at(-1) || tiers[0];
  const availableProof = latestLiveProof?.settlementSummary ? latestLiveProof : liveDemoState?.settlementSummary ? liveDemoState : historicalLiveProof;
  const proofCopy = isConfirmedLiveProof(availableProof)
    ? 'A separate confirmed Tempo payment shows the real money flow.'
    : 'A separate Tempo payment will show the real money flow once confirmed.';
  const intro = $('#dealIntroSummary');
  if (intro) intro.textContent = `${count.toLocaleString('en-US')} modeled buyers. Larger demand and seller competition lower the example price. These figures are not charged; the real testnet order is shown separately below.`;
  const ladderLead = $('#ladderLead');
  if (ladderLead) ladderLead.textContent = closedWithoutSale
    ? 'Example only: no seller completed the order; no Tempo refund was sent.'
    : dealClosed
    ? `This example order is complete at ${currentDeal?.best || 'the locked price'}. The next tier is not active.`
    : nextTier
    ? `${nextTier.buyers - count} more buyers unlock ${nextTier.price}. Any difference comes back to buyers.`
    : `The lowest example price is ${currentTier.price}.`;
  const ld = $('#ladderDescription');
  if (ld) {
    if (closedWithoutSale) {
      ld.textContent = `${count.toLocaleString('en-US')} buyers · example · no sale`;
    } else if (dealClosed) {
      ld.textContent = `${count.toLocaleString('en-US')} example buyers · Order complete at ${currentDeal?.best || 'the locked price'}`;
    } else if (nextTier) {
      ld.textContent = `${count} of ${target} example buyers · ${nextTier.buyers - count} more to reach ${nextTier.price}`;
    } else {
      ld.textContent = `${count} example buyers · Lowest example price reached`;
    }
  }
  const active = closedWithoutSale ? -1 : count >= tiers[3].buyers ? 2 : count >= tiers[2].buyers ? 1 : count >= tiers[1].buyers ? 0 : -1;
  $$('.price-step').forEach((step, index) => {
    const hasPrice = numericValue(step.querySelector('strong')?.textContent) > 0;
    step.hidden = !hasPrice;
    const wasActive = step.classList.contains('active');
    step.classList.toggle('active', index === active);
    if (!wasActive && index === active && index > lastUnlockedTierIndex) {
      step.classList.add('just-unlocked');
      setTimeout(() => step.classList.remove('just-unlocked'), 1800);
    }
  });
  $$('.home-price-step').forEach((step, index) => {
    const hasPrice = numericValue(step.querySelector('strong')?.textContent) > 0;
    step.hidden = !hasPrice;
    const wasActive = step.classList.contains('is-current');
    step.classList.toggle('is-current', index === active);
    if (!wasActive && index === active && index > lastUnlockedTierIndex) {
      step.classList.add('just-unlocked');
      setTimeout(() => step.classList.remove('just-unlocked'), 1800);
    }
  });
  if (active > lastUnlockedTierIndex) {
    lastUnlockedTierIndex = active;
  }
  updateMarketPulse();
}

function renderSellerLadder(data = {}) {
  const panel = $('#sellerLadderPanel');
  const ladder = data.sellerLadder;
  if (!panel) return;
  const hasCompetitionTiers = Array.isArray(data.priceTiers) && data.priceTiers.length && Number(data.priceTiers[0]?.buyers) !== 200;
  if (hasCompetitionTiers) {
    panel.hidden = true;
    return;
  }
  panel.hidden = !ladder;
  if (!ladder) return;
  const tiers = Array.isArray(ladder.tiers) ? ladder.tiers : [];
  const buyers = Number(data.buyers || 0);
  const activeTier = tiers.reduce((current, tier, index) => buyers >= Number(tier.buyers || 0) ? index : current, -1);
  const dealClosed = Market.terminal(data.status);
  const nextTier = dealClosed ? null : tiers.find((tier) => buyers < Number(tier.buyers || 0));
  const set = (id, value) => { const node = $('#' + id); if (node) node.textContent = value; };
  set('sellerLadderSeller', ladder.seller || 'Seller');
  set('sellerLadderSellerStatus', 'Seller ready');
  set('sellerLadderMax', `Up to ${ladder.maxBuyerPrice || data.buyerMaxPrice || '—'}`);
  set('sellerLadderCapacity', `${Number(ladder.capacity || 0).toLocaleString('en-US')} items`);
  set('sellerLadderExpiry', ladder.expiry || '—');
  const logText = Array.isArray(data.log) ? data.log.map((entry) => Array.isArray(entry) ? entry[1] : entry).join(' ') : String(data.log || '');
  const sellerFailed = data.failureType === 'DELIVERY_FAILED'
    || (data.status === 'REFUNDED' && /fail|missed delivery/i.test(logText));
  if (data.status === 'REFUNDED') {
    set('sellerLadderSellerStatus', sellerFailed ? 'Seller failed' : 'No completed sale');
    set('sellerLadderStatus', sellerFailed ? 'SELLER FAILED · MONEY RETURNED' : 'MONEY RETURNED');
    set('sellerLadderLead', sellerFailed
      ? 'Seller C failed after the price lock. The guarantee was forfeited; buyers got their money back and seller payout stayed at $0.'
      : 'No funded seller offer completed the order, so every buyer got their money back.');
    set('sellerLadderPriceRule', sellerFailed
      ? 'Seller C failed after price lock; no seller payout or 1% fee was released.'
      : 'No seller offer is active. The published prices did not create a completed sale.');
  } else if (data.status === 'AWAITING_FULFILLMENT') {
    set('sellerLadderSellerStatus', 'Delivery pending');
    set('sellerLadderStatus', `DELIVERY PENDING · ${data.best || 'PRICE LOCKED'}`);
    set('sellerLadderLead', `Seller C won at ${data.best || 'the locked price'}. Delivery must be confirmed before payout; buyer surplus is already returned.`);
    set('sellerLadderPriceRule', 'No later buyer tier can change this locked price.');
  } else if (dealClosed) {
    set('sellerLadderSellerStatus', 'Order complete');
    set('sellerLadderStatus', `ORDER COMPLETE · ${data.best || 'PRICE LOCKED'}`);
    set('sellerLadderLead', `The order closed at ${data.best || 'the locked price'}. No later buyer tier can change this example.`);
    set('sellerLadderPriceRule', 'No next price is active after the order closes.');
  } else {
    set('sellerLadderStatus', activeTier >= 0 ? `CURRENT PRICE · ${tiers[activeTier].price}` : `WAITING FOR ${nextTier?.buyers || '—'} BUYERS`);
    set('sellerLadderLead', `${ladder.seller || 'The seller'} publishes the price options above. ${nextTier ? `${Math.max(0, nextTier.buyers - buyers)} more buyers unlock ${nextTier.price}.` : 'The lowest published price is active.'} The lowest offer that fits wins when the order closes.`);
    set('sellerLadderPriceRule', nextTier ? `Next price: ${nextTier.price} at ${Number(nextTier.buyers || 0).toLocaleString('en-US')} buyers.` : 'Lowest published price is active.');
  }
  const guaranteeText = ladder.guarantee || 'seller promise';
  set('sellerLadderTrust', sellerFailed
    ? `Seller payout: $0 · guarantee forfeited after failed delivery.`
    : data.status === 'REFUNDED'
      ? 'No seller payout was released because this example did not complete.'
      : data.status === 'AWAITING_FULFILLMENT'
        ? `Payout is held until delivery is confirmed. Guarantee: ${guaranteeText}.`
        : `Seller is paid after delivery. Guarantee: ${guaranteeText}.`);
}

function syncSellerPhone(buyers, retail, best, timer = '05:00:00', committedCents = 0, offers = []) {
  const retailPrice = Number(String(retail).replace(/[^\d.]/g, '')) || 0;
  const knownCommittedCents = Number(committedCents || canonicalServerState?.deal?.accounting?.committedCents || 0);
  const demand = knownCommittedCents ? formatMetricCents(knownCommittedCents) : '$' + Math.round((buyers * retailPrice) / 1000) + 'k';
  const sellerCount = Array.isArray(offers) ? offers.filter((offer) => /^\$/.test(String(offer))).length : 0;
  const timeText = ['CLOSED', 'RECOVERY'].includes(timer) ? timer.toLowerCase() : `${timer} left`;
  const item = $('.demand-item[data-title="Phone group order"]');
  if (item) {
    item.dataset.price = best;
    const meta = $('#phoneDemandMeta');
    const pbest = $('#phoneDemandBest');
    if (meta) meta.textContent = `${buyers} buyers · ${demand} group demand · ${sellerCount || 3} sellers · ${timeText}`;
    if (pbest) pbest.textContent = best;
  }
}

function renderSimulatedPaymentActivity(data = {}) {
  const panel = $('#simulatedPaymentActivity');
  if (!panel) return;
  panel.hidden = false;
  const finalPriceCents = Market.winningPrice(data.offers, data.winnerIndex) || 0;
  const ledger = data.paymentLedger || Market.simulatedPaymentLedger(data.dealId || activeIds.dealId, data.cohorts || [], data.status || 'OPEN', finalPriceCents);
  const summary = ledger.summary || {};
  const payments = Array.isArray(ledger.payments) ? ledger.payments : [];
  const set = (id, value) => { const node = $('#' + id); if (node) node.textContent = String(value); };
  const buyerCount = Number(summary.buyerCount ?? summary.paymentCount ?? payments.length);
  set('simPaymentBuyerLabel', buyerCount.toLocaleString('en-US'));
  set('simPaymentCount', buyerCount.toLocaleString('en-US'));
  set('simPaymentLocked', Market.dollars(summary.lockedCents || 0));
  set('simLedgerCount', buyerCount.toLocaleString('en-US'));
  set('simPaymentStatus', 'EXAMPLE MARKET');
  const unitPriceCents = summary.finalOrderCents && buyerCount ? Math.round(summary.finalOrderCents / buyerCount) : finalPriceCents;
  const retailValue = numericValue(data.retail);
  const retailCents = retailValue > 0 ? Market.cents(data.retail) : 0;
  const buyerSavingsCents = Math.max(0, (retailCents - unitPriceCents) * buyerCount);
  const modeledOrderCents = summary.finalOrderCents || (unitPriceCents * buyerCount);
  const modeledFeeCents = summary.feeCents || Math.floor(modeledOrderCents / 100);
  const modeledPayoutCents = summary.payoutCents || Math.max(0, modeledOrderCents - modeledFeeCents);
  set('simPaymentUnitPrice', unitPriceCents ? Market.dollars(unitPriceCents) : '—');
  set('simPaymentFinalOrder', modeledOrderCents ? Market.dollars(modeledOrderCents) : '—');
  set('simPaymentRefund', Market.dollars(buyerSavingsCents));
  const dealClosed = Market.terminal(data.status);
  set('simPaymentPayout', modeledPayoutCents ? Market.dollars(modeledPayoutCents) : '—');
  set('simPaymentFee', modeledFeeCents ? Market.dollars(modeledFeeCents) : '—');
  const payoutLabel = $('#simPaymentPayout')?.parentElement;
  const feeLabel = $('#simPaymentFee')?.parentElement;
  if (payoutLabel?.firstChild) payoutLabel.firstChild.textContent = dealClosed ? 'Example seller payout ' : 'Possible seller payout ';
  if (feeLabel?.firstChild) feeLabel.firstChild.textContent = dealClosed ? 'DealArena fee ' : 'Possible fee ';
  const nextTier = dealClosed ? null : (data.priceTiers || []).find((tier) => Number(tier.buyers || 0) > Number(data.buyers || 0));
  set('simPaymentLead', 'This is a scale model. It shows the price, savings and payout. The separate LIVE proof shows the same payment path on Tempo.');
  set('simPaymentWalletNote', `Scale model · no buyer payments are claimed.`);
  set('simPaymentNextTier', data.status === 'REFUNDED'
    ? 'No sale in this example'
    : dealClosed
      ? `Order complete at ${data.best || 'the locked price'}`
      : nextTier
        ? `${Number(nextTier.buyers) - Number(data.buyers || 0)} more buyers to unlock ${nextTier.price}`
        : 'Lowest example price reached');
  const list = $('#simulatedPaymentLedger');
  if (!list) return;
  list.replaceChildren();
  const accountingRows = [
    ['Buyer commitments in example', Market.dollars(summary.lockedCents || 0)],
    [summary.status === 'REFUNDED' ? 'Buyer money returned' : 'Amount returned after price lock', Market.dollars(summary.refundCents || 0)],
    [dealClosed ? 'Seller payout · DealArena fee' : 'Possible seller payout · fee', `${Market.dollars(modeledPayoutCents)} · ${Market.dollars(modeledFeeCents)}`],
  ];
  const fragment = document.createDocumentFragment();
  accountingRows.forEach(([label, value]) => {
    const row = document.createElement('li');
    const identity = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = label;
    const meta = document.createElement('small');
    meta.textContent = 'Market model · not a payment or Tempo receipt';
    identity.append(title, meta);
    const amount = document.createElement('strong');
    amount.textContent = value;
    const status = document.createElement('em');
    status.textContent = 'MODEL';
    row.append(identity, amount, status);
    fragment.appendChild(row);
  });
  list.appendChild(fragment);
}

function renderSecondaryPaymentLedger(listId, ledger, ids = {}) {
  const list = $('#' + listId);
  if (!list || !ledger) return;
  const payments = Array.isArray(ledger.payments) ? ledger.payments : [];
  const summary = ledger.summary || {};
  const set = (id, value) => { const node = id && $('#' + id); if (node) node.textContent = String(value); };
  const paymentCount = Number(summary.buyerCount ?? summary.paymentCount ?? payments.length);
  set(ids.countId, paymentCount.toLocaleString('en-US'));
  set(ids.amountId, Market.dollars(summary.lockedCents || 0));
  set(ids.statusId, 'EXAMPLE MARKET');
  set(ids.noteId, ids.noteId === 'requestPaymentNote'
    ? 'These numbers show demand and pricing. They are not payments.'
    : 'These numbers show group demand and savings. They are not payments.');
  list.replaceChildren();
  list.parentElement?.querySelector('[data-ledger-more]')?.remove();
  const accountingRows = [
    ['Committed demand', Market.dollars(summary.lockedCents || 0)],
    [summary.status === 'WON' ? 'Final order' : 'Buyer money returned', summary.status === 'WON' ? Market.dollars(summary.finalOrderCents || 0) : Market.dollars(summary.refundCents || 0)],
    ['Seller payout · platform fee', `${Market.dollars(summary.payoutCents || 0)} · ${Market.dollars(summary.feeCents || 0)}`],
  ];
  const fragment = document.createDocumentFragment();
  accountingRows.forEach(([label, value]) => {
    const row = document.createElement('li');
    row.innerHTML = `<b>${label}</b><span>${value} · example</span><em>EXAMPLE</em>`;
    fragment.appendChild(row);
  });
  list.appendChild(fragment);
}

function renderSellerGuarantee(amountCents = 1000, receiptId = '', status = 'READY') {
  const amount = $('#sellerGuaranteeAmount');
  const receipt = $('#sellerGuaranteeReceipt');
  const readOnly = !BROWSER_WALLET_ACTIONS_ENABLED;
  if (amount) amount.textContent = readOnly ? `Guarantee: ${Market.dollars(amountCents)}` : `${Market.dollars(amountCents)} ${status.toLowerCase()}`;
  if (receipt) receipt.textContent = receiptId
    ? `${receiptId} · confirmed on Tempo · released after delivery or handled on failure`
    : readOnly ? 'Preview only. No guarantee has been locked.' : 'Receipt appears after the offer is published on Tempo.';
}

function updateHomeDealSurface(data = {}) {
  const accounting = data.accounting || {};
  const offers = Array.isArray(data.offers) ? data.offers : [];
  const validOffers = offers.filter((offer) => /^\$/.test(String(offer))).length;
  const ids = [
    ['cardBuyerCountMeta', Number(data.buyers || 0).toLocaleString('en-US')],
    ['cardFundedDemand', formatMetricCents(accounting.committedCents)],
    ['cardSellerCount', validOffers],
    ['cardTimeLeft', dealTimerLabel(data) === 'CLOSED' ? 'closed' : `${dealTimerLabel(data)} left`],
    ['cardBuyerCount', Number(data.buyers || 0).toLocaleString('en-US')],
  ];
  ids.forEach(([id, value]) => {
    const element = $('#' + id);
    if (element) element.textContent = String(value);
  });
  const cta = $('#cardJoinCta');
  if (cta) cta.textContent = 'View deal';

  ['A', 'B', 'C'].forEach((seller, index) => {
    const row = $('#homeSellerRow' + seller);
    const value = $('#homeOffer' + seller);
    const delta = $('#homeDelta' + seller);
    const nextValue = numericValue(offers[index]);
    const previousValue = lastHomeOfferValues[index] || 0;
    if (value) value.textContent = offers[index] || '—';
    if (delta) delta.textContent = nextValue && previousValue > nextValue ? `Price down ${Market.dollars((previousValue - nextValue) * 100)}` : '';
    if (!row) return;
    const isLeader = index === Number(data.winnerIndex);
    row.classList.toggle('is-leader', isLeader);
    if (isLeader && lastHomeWinnerIndex >= 0 && lastHomeWinnerIndex !== index) {
      row.classList.remove('battle-pulse');
      void row.offsetWidth;
      row.classList.add('battle-pulse');
    }
  });
  lastHomeOfferValues = offers.map((offer) => numericValue(offer));
  lastHomeWinnerIndex = Number.isInteger(data.winnerIndex) ? data.winnerIndex : -1;

  const rawActivity = data.activity || (Array.isArray(data.log) ? data.log[0]?.[1] : data.log);
  const heartbeat = $('#homeHeartbeatText');
  if (heartbeat) {
    const sellerNames = ['Nova', 'Apex', 'Vertex'];
    const tiers = Array.isArray(data.priceTiers) && data.priceTiers.length
      ? data.priceTiers
      : [{ buyers: 200, price: data.ladder?.[1] }, { buyers: 500, price: data.ladder?.[2] }, { buyers: 800, price: data.ladder?.[3] }];
    const nextTier = tiers.find((tier) => Number(tier.buyers || 0) > Number(data.buyers || 0));
    const liveMarketMessage = data.status === 'OPEN' && Number(data.winnerIndex) >= 0
      ? `${sellerNames[Number(data.winnerIndex)] || 'A seller'} leads at ${data.best || 'the current price'} · ${nextTier ? `${Number(nextTier.buyers) - Number(data.buyers || 0)} more buyers unlock ${nextTier.price}` : 'lowest example price is active'}`
      : null;
    const terminalMessage = data.status === 'WON'
      ? `${Number(data.buyers || 0).toLocaleString('en-US')} buyers reached ${data.best || 'the final price'} in this example.`
      : data.status === 'REFUNDED'
        ? `${Number(data.buyers || 0).toLocaleString('en-US')} buyers were refunded in this example.`
        : null;
    heartbeat.textContent = terminalMessage || liveMarketMessage || (rawActivity ? String(rawActivity).replace(/^(Simulated|Example)\s*·\s*/, '').replace(/ · Final order.*$/, '') : 'People are joining · sellers are competing · everyone can save.');
    heartbeat.classList.remove('value-pulse');
    void heartbeat.offsetWidth;
    heartbeat.classList.add('value-pulse');
  }
}

function updateHomeTempoProof(proof = null) {
  const panel = $('#homeTempoProof');
  if (!panel) return;
  const currentExampleFinished = ['WON', 'REFUNDED'].includes(currentDeal?.status);
  if (!currentExampleFinished) {
    panel.hidden = false;
    const grid = $('#homeTempoProofGrid');
    if (grid) grid.hidden = true;
    const ledger = $('#homeTempoLedger');
    if (ledger) ledger.hidden = true;
    const explorer = $('#homeTempoExplorer');
    if (explorer) explorer.hidden = true;
    const set = (id, value) => { const element = $('#' + id); if (element) element.textContent = value; };
    set('homeTempoProofTitle', 'The real payment proof is on Tempo.');
    set('homeTempoProofLead', 'The market above is modeled scale. A separate LIVE testnet run proves the real funding, refund, delivery and payout flow.');
    set('homeTempoProofBadge', 'READ-ONLY');
    set('homeTempoStory', 'Run or view the confirmed LIVE proof on the Deal page.');
    return;
  }
  const grid = $('#homeTempoProofGrid');
  const proofCandidates = proof
    ? [proof]
    : [latestLiveProof, liveDemoState, historicalLiveProof];
  const activeProof = proofCandidates.find((candidate) => isConfirmedLiveProof(candidate)) || null;
  const summary = activeProof?.settlementSummary;
  const hash = activeProof?.status === 'REFUNDED'
    ? activeProof.refundHash || activeProof.lastHash
    : activeProof?.status === 'COMPLETED'
      ? activeProof.fulfillmentHash || activeProof.settlementHash || activeProof.lastHash
      : activeProof?.settlementHash || activeProof?.lastHash;
  if (!summary || !hash || !isConfirmedLiveProof(activeProof)) {
    panel.hidden = false;
    if (grid) grid.hidden = true;
    const set = (id, value) => { const element = $('#' + id); if (element) element.textContent = value; };
    set('homeTempoProofTitle', 'Confirmed receipts on Tempo.');
    set('homeTempoProofLead', 'Open the Deal page to see the confirmed payment receipts. Viewing proof never sends a payment.');
    set('homeTempoProofBadge', 'READ-ONLY');
    set('homeTempoStory', 'The confirmed receipt ledger is on the Deal page.');
    const ledger = $('#homeTempoLedger');
    if (ledger) ledger.hidden = true;
    const explorer = $('#homeTempoExplorer');
    if (explorer) explorer.hidden = true;
    return;
  }
  const money = (value) => formatExactCents(value);
  const modeledScale = simulatedBuyerCount().toLocaleString('en-US');
  const units = Math.max(1, Number(summary.totalUnits ?? summary.units ?? summary.buyersCount ?? 1));
  const unitPrice = summary.unitPriceCents ?? summary.finalPriceCents;
  const total = summary.grossOrderCents ?? summary.finalOrderCents ?? Number(summary.finalPriceCents || 0) * units;
  const awaitingDelivery = ['SETTLED', 'AWAITING_FULFILLMENT'].includes(activeProof?.status);
  const completed = activeProof?.status === 'COMPLETED';
  const set = (id, value) => { const element = $('#' + id); if (element) element.textContent = value; };
  panel.hidden = false;
  if (grid) grid.hidden = false;
  set('homeTempoProofTitle', activeProof.status === 'REFUNDED'
    ? 'Real testnet order refunded.'
    : awaitingDelivery
      ? 'Real testnet order is price-locked.'
      : completed
        ? 'Real testnet order completed.'
        : 'Real testnet price lock recorded.');
  set('homeTempoProofLead', activeProof.status === 'REFUNDED'
    ? `A real ${units}-buyer Tempo order did not close, so the committed money was returned. The ${modeledScale}-buyer view above is modeled scale.`
    : awaitingDelivery
      ? `A real ${units}-buyer Tempo order locked ${money(total)}; seller payout and platform fee stay held until delivery. The ${modeledScale}-buyer view above is modeled scale.`
      : completed
        ? `A real ${units}-buyer Tempo order paid ${money(total)} at ${money(unitPrice)} per item; seller payout was released and unused money returned. The ${modeledScale}-buyer view above is modeled scale.`
        : `A real Tempo order locked ${money(total)} in total, or ${money(unitPrice)} per item. The ${modeledScale}-buyer view above is modeled scale.`);
  set('homeTempoUnit', money(unitPrice));
  set('homeTempoPayout', awaitingDelivery ? 'Held' : money(summary.sellerPayoutCents));
  set('homeTempoFee', awaitingDelivery ? 'Held' : money(summary.feeCents));
  set('homeTempoRefund', money(summary.buyerRefundCents));
  set('homeTempoStory', activeProof?.historical
    ? 'These are real receipts from the last confirmed Tempo run. Viewing them never sends a new payment.'
    : formatLiveTransactionStory(activeProof) || 'Payment record available.');
  set('homeTempoProofBadge', activeProof?.historical ? 'VERIFIED ON TEMPO · READ-ONLY' : activeProof?.chainVerified ? 'VERIFIED ON TEMPO' : 'TESTNET');
  const ledger = $('#homeTempoLedger');
  const ledgerList = $('#homeTempoLedgerList');
  const confirmedReceipts = (Array.isArray(activeProof?.receipts) ? activeProof.receipts : [])
    .filter((receipt) => receipt?.status === 'CONFIRMED' && receipt?.isOnChain && receipt?.hash);
  if (ledger && ledgerList) {
    ledger.hidden = confirmedReceipts.length === 0;
    set('homeTempoLedgerCount', confirmedReceipts.length ? `${confirmedReceipts.length} confirmed` : '');
    ledgerList.replaceChildren();
    const labels = {
      DEMO_BUYER_JOIN: 'Buyer funding',
      DEMO_SELLER_LADDER: 'Seller price ladder',
      DEMO_SELLER_OFFER: 'Competing seller offer',
      DEMO_SETTLEMENT: 'Price lock + buyer surplus',
      DEMO_FULFILLMENT: 'Delivery + final payout',
    };
    confirmedReceipts.forEach((receipt) => {
      const row = document.createElement('li');
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      const status = document.createElement('small');
      const link = document.createElement('a');
      title.textContent = labels[receipt.type] || receipt.details || 'Confirmed Tempo payment';
      status.textContent = `CONFIRMED · ${receipt.hash.slice(0, 8)}…${receipt.hash.slice(-6)}`;
      link.href = `${TEMPO_EXPLORER}/receipt/${receipt.hash}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View on Tempo';
      copy.append(title, status);
      row.append(copy, link);
      ledgerList.appendChild(row);
    });
  }
  const link = $('#homeTempoLink');
  if (link) {
    link.href = '#deal';
    link.removeAttribute('target');
    link.textContent = 'View LIVE proof';
    link.setAttribute('aria-label', 'View LIVE proof');
  }
  const explorer = $('#homeTempoExplorer');
  if (explorer) {
    explorer.hidden = !hash;
    explorer.href = `${TEMPO_EXPLORER}/receipt/${hash}`;
  }
}

function cohortsAtBuyerCount(previous = [], next = [], buyerCount = 0) {
  const result = previous.map((entry) => ({ ...entry }));
  let used = result.reduce((sum, entry) => sum + Number(entry.units || 0), 0);
  for (const entry of next) {
    if (result.some((existing) => existing.id === entry.id)) continue;
    const units = Math.min(Number(entry.units || 0), Math.max(0, buyerCount - used));
    if (units > 0) result.push({ ...entry, units });
    used += units;
    if (used >= buyerCount) break;
  }
  return result;
}

function animateDealTransition(previous, next, duration = 820) {
  if (!previous || !next || Number(next.buyers || 0) <= Number(previous.buyers || 0)) return Promise.resolve();
  const start = Number(previous.buyers || 0);
  const target = Number(next.buyers || 0);
  const frames = Math.min(8, Math.max(3, Math.ceil((target - start) / 24)));
  const interval = Math.max(70, Math.floor(duration / frames));
  let frame = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    let fallbackTimer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (error) reject(error);
      else resolve();
    };
    const tick = () => {
      if (settled) return;
      frame += 1;
      const ratio = frame / frames;
      const buyers = Math.round(start + (target - start) * ratio);
      // During the visual transition, keep the previous offer/status visible.
      // The next seller and final price appear only when the buyer count reaches
      // the next server step.
      try {
        applyDeal({
          ...next,
          buyers,
          cohorts: cohortsAtBuyerCount(previous.cohorts, next.cohorts, buyers),
          best: previous.best,
          saving: previous.saving,
          offers: previous.offers,
          winnerIndex: previous.winnerIndex,
          winnerSeller: previous.winnerSeller,
          status: previous.status === 'WON' || previous.status === 'REFUNDED' ? 'OPEN' : previous.status,
          offerStatus: previous.offerStatus === 'WON' || previous.offerStatus === 'FAILED' ? 'COMPETING' : previous.offerStatus,
          timer: previous.timer,
        }, 0, 1);
      } catch (error) {
        finish(error);
        return;
      }
      if (frame >= frames) finish();
      else timers.push(setTimeout(tick, interval));
    };
    // A visual effect must never block the scenario state machine.
    fallbackTimer = setTimeout(finish, Math.max(1200, duration + 900));
    timers.push(setTimeout(tick, interval));
  });
}

function syncBusinessProgress(count) {
  const step1 = $('#bizStep1');
  const step2 = $('#bizStep2');
  const step3 = $('#bizStep3');
  if (step1) step1.classList.toggle('unlocked', count >= 10);
  if (step2) step2.classList.toggle('unlocked', count >= 30);
  if (step3) step3.classList.toggle('unlocked', count >= 50);

  const hint = $('#bizLadderHint');
  if (hint) {
    if (count < 50) {
      const remaining = 50 - count;
      hint.textContent = `${remaining} more café${remaining === 1 ? '' : 's'} unlock the next price tier`;
    } else {
      hint.textContent = '50-café large-order tier unlocked (−27%)';
    }
  }
}

function syncBusinessSuppliers(offerA, offerB, offerC, winnerId = 'C') {
  const rowA = $('#bizSupplierRowA');
  const rowB = $('#bizSupplierRowB');
  const rowC = $('#bizSupplierRowC');
  const valA = $('#bizOfferA');
  const valB = $('#bizOfferB');
  const valC = $('#bizOfferC');
  const nameA = $('#bizSupplierNameA');
  const nameB = $('#bizSupplierNameB');
  const nameC = $('#bizSupplierNameC');
  const supplierCount = [offerA, offerB, offerC].filter((offer) => offer && offer !== '—').length;
  const countEl = $('#businessSuppliersCount');
  if (countEl) countEl.textContent = String(supplierCount);

  if (valA) valA.textContent = offerA;
  if (valB) valB.textContent = offerB;
  if (valC) valC.textContent = offerC;

  if (rowA) rowA.classList.toggle('winner', winnerId === 'A');
  if (rowB) rowB.classList.toggle('winner', winnerId === 'B');
  if (rowC) rowC.classList.toggle('winner', winnerId === 'C');

  if (nameA) nameA.textContent = winnerId === 'A' ? 'Supplier A · Leading' : 'Supplier A';
  if (nameB) nameB.textContent = winnerId === 'B' ? 'Supplier B · Leading' : 'Supplier B';
  if (nameC) nameC.textContent = winnerId === 'C' ? 'Supplier C · Leading' : 'Supplier C';
}

function formatLogMessage(message) {
  const original = String(message);
  const raw = original.replace(/^(Simulated|Example|Preview)\s*·\s*/, '');
  if (/^(LIVE_TESTNET|On-chain|Real payment)/.test(raw)) return raw.replace(/^LIVE_TESTNET\s*·\s*/, 'Real payment · ');
  const value = raw
    .replace(/Demand reached/gi, 'Order reached')
    .replace(/Group order opened\s*·\s*Escrow pool initialized/gi, 'Order opened')
    .replace(/Group order opened\s*·\s*order opened/gi, 'Order opened')
    .replace(/deposited .*? into Escrow/gi, 'modeled order amount')
    .replace(/retained commitments/gi, 'modeled commitments remain in the example')
    .replace(/\bcommitted\b/gi, 'modeled')
    .replace(/\bpooled\b/gi, 'joined')
    .replace(/\bcommitments\b/gi, 'modeled commitments')
    .replace(/wholesale/gi, 'large order')
    .replace(/bulk-order/gi, 'large order')
    .replace(/undercut/gi, 'lowered the price')
    .replace(/Leading bid/gi, 'Best offer')
    .replace(/\bbid\b/gi, 'offer')
    .replace(/guarantee bond/gi, 'seller promise')
    .replace(/seller promise active/gi, 'seller promise is active')
    .replace(/seller promise slated for forfeiture/gi, 'seller promise may be claimed')
    .replace(/buyer funds protected in order funds/gi, 'buyer money stayed protected')
    .replace(/Minimum target of (\d+) buyers unmet/gi, 'The order missed its buyer target')
    .replace(/100% refund \(([^)]+)\) returned to all (\d+) buyers/gi, 'Everyone got their money back ($1)')
    .replace(/\bbuyers\b/gi, 'people')
    .replace(/\bEscrow\b/gi, 'order funds');
  return `Example · ${value.replace(/^Preview\s*·\s*/i, '')}`;
}

function normalizeDealLog(entries) {
  if (typeof entries === 'string') return [[getFormattedTime(), entries]];
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => Array.isArray(entry)
    ? [entry[0] || getFormattedTime(), String(entry[1] || '')]
    : [getFormattedTime(), String(entry || '')]
  ).filter(([, message]) => message).slice(0, 8);
}

function rememberDealLog(message, customTime) {
  const raw = String(message || '');
  if (!raw) return;
  const formatted = formatLogMessage(raw);
  const exists = dealActivityLog.some(([, entry]) => formatLogMessage(entry) === formatted);
  if (!exists) dealActivityLog.unshift([customTime || getFormattedTime(), raw]);
  dealActivityLog = dealActivityLog.slice(0, 8);
  renderLog(dealActivityLog);
}

function renderLog(entries = dealActivityLog) {
  const container = $('#dealLog');
  if (!container) return;
  container.replaceChildren(
    ...normalizeDealLog(entries).map(([time, message]) => {
      const row = document.createElement('li');
      const stamp = document.createElement('time');
      const text = document.createElement('span');
      stamp.textContent = time;
      text.textContent = formatLogMessage(message);
      row.append(stamp, text);
      return row;
    })
  );
}

function renderMiniLog(id, entries) {
  const list = $(`#${id}`);
  if (!list) return;
  list.replaceChildren(
    ...entries.map(([time, message]) => {
      const row = document.createElement('li');
      const stamp = document.createElement('time');
      const text = document.createElement('span');
      stamp.textContent = time;
      text.textContent = formatLogMessage(message);
      row.append(stamp, text);
      return row;
    })
  );
}

function addMiniLog(id, message, customTime) {
  const list = $(`#${id}`);
  if (!list) return;
  if (id === 'dealLog') {
    rememberDealLog(message, customTime);
    return;
  }
  const topText = list.firstElementChild?.querySelector('span')?.textContent;
  if (topText === message) return;
  const time = customTime || getFormattedTime();
  const row = document.createElement('li');
  const stamp = document.createElement('time');
  const text = document.createElement('span');
  stamp.textContent = time;
  text.textContent = formatLogMessage(message);
  row.append(stamp, text);
  list.prepend(row);
  while (list.children.length > 5) list.lastElementChild.remove();
}

function setTestnetLive(txHash, label = 'LIVE_TESTNET', action = 'Wallet action', options = {}) {
  // A receipt is evidence for this action, not for the simulated marketplace.
  const proof = $('#liveProof');
  if (proof) {
    proof.hidden = false;
    const displayLabel = label === 'LIVE_TESTNET' ? 'TEMPO PAYMENT' : label;
    const count = Number(options.receiptCount || options.receipts?.length || 0);
    // The old technical labels "Latest transaction", "Resume live proof", and
    // "Latest confirmed live proof", "Run fresh live proof" are kept only as
    // internal compatibility terms;
    // the visible interface uses plain-language payment labels.
    const prefix = count > 1
      ? `${displayLabel} · ${action} · ${count} confirmed transactions · Latest transaction: `
      : `${displayLabel} · ${action} · `;
    proof.textContent = options.summary ? `${prefix}${options.summary} · ` : prefix;
    proof.append(createTxLink(txHash));
  }
  lastTxHash = txHash;
  setSimulatedMode();
}

function setSimulatedMode() {
  const state = $('#demoState');
  const dot = $('#demoStateDot');
  const act = $('#activityState');
  const actDot = $('#activityStateDot');
  // The example controls always describe the current simulated run. A saved
  // LIVE proof belongs in its own proof card below and must not relabel the
  // 500-buyer simulation as an on-chain transaction.
  if (state) state.textContent = ($('#scenario')?.value || 'normal') === 'normal'
    ? 'MODELED MARKET · REAL TEMPO TESTNET PAYMENTS'
    : 'MARKET EXAMPLE · NO NEW PAYMENT';
  if (dot) dot.classList.remove('live');
  if (act) act.textContent = 'EXAMPLE MARKET';
  if (actDot) actDot.classList.remove('live');
}

function formatSettlementSummary(summary, proofStatus = '') {
  if (!summary) return null;
  const money = (cents) => formatExactCents(Number(cents || 0));
  const unitPrice = summary.unitPriceCents ?? summary.finalPriceCents;
  const units = Math.max(1, Number(summary.totalUnits ?? summary.units ?? summary.buyersCount ?? 1));
  const orderTotal = summary.grossOrderCents ?? summary.finalOrderCents ?? Number(summary.finalPriceCents || 0) * units;
  if (proofStatus === 'REFUNDED') {
    return `Buyer committed ${money(summary.committedCents)} → order refunded → people got back ${money(summary.buyerRefundCents)}`;
  }
  if (['SETTLED', 'AWAITING_FULFILLMENT'].includes(proofStatus)) {
    return `Buyer committed ${money(summary.committedCents)} → price locked at ${money(unitPrice)} → ${money(summary.buyerRefundCents)} returned → seller payout ${money(summary.sellerPayoutCents)} held → fee ${money(summary.feeCents)} held`;
  }
  if (proofStatus === 'COMPLETED') {
    return `Buyer committed ${money(summary.committedCents)} → price locked at ${money(unitPrice)} → ${money(summary.buyerRefundCents)} returned → seller paid ${money(summary.sellerPayoutCents)} → fee released ${money(summary.feeCents)}`;
  }
  return `Example commitments ${money(summary.committedCents)} → possible price ${money(unitPrice)} → order ${money(orderTotal)} → unused amount returns`;
}

function updateLiveMoneyFlow() {
  const panel = $('#liveMoneyFlow');
  if (!panel) return;
  // The open Arena is a public example. A saved LIVE proof is a separate
  // small testnet payment and must not make this example look settled.
  const proof = liveDemoState
    ? isConfirmedLiveProof(liveDemoState) || isCurrentPriceLockConfirmed(liveDemoState) ? liveDemoState : null
    : [latestLiveProof, historicalLiveProof].find(isConfirmedLiveProof) || null;
  const live = Boolean(proof);
  panel.classList.toggle('is-live-proof', live);
  panel.classList.toggle('is-example-flow', !live);
  const status = proof?.status || '';
  const isRefunded = status === 'REFUNDED';
  const isSettled = ['SETTLED', 'AWAITING_FULFILLMENT'].includes(status);
  const isCompleted = status === 'COMPLETED';
  const simulatedStatus = currentDeal?.status || '';
  const currentIndex = live
    ? isCompleted ? 4 : isRefunded ? 2 : isSettled ? 3 : 1
    : simulatedStatus === 'WON' ? 4 : simulatedStatus === 'REFUNDED' ? 2 : 1;
  const mode = $('#liveFlowMode');
  const title = $('#liveFlowTitle');
  const note = $('#liveFlowNote');
  if (mode) mode.textContent = live ? 'VERIFIED TEMPO MONEY FLOW' : 'THE MONEY PATH';
  if (title) title.textContent = live ? 'The same payment lifecycle, proven on Tempo' : 'Why the price falls — and why both sides join';
  if (note) note.textContent = live
    ? isRefunded
      ? 'Confirmed testnet order: buyer money was returned; no seller payout or fee was released.'
      : isCompleted
        ? 'The demo operator confirmed delivery on Tempo; the seller payout and fee were released.'
        : isSettled
          ? 'Confirmed testnet order: price is locked, unused buyer money came back, and seller payout stays held until delivery.'
          : 'Confirmed testnet order: buyer and seller actions are recorded; price lock is next.'
      : `The ${simulatedBuyerCount().toLocaleString('en-US')}-buyer view is a scale example. Buyers join one order, sellers compete, the lower price locks, unused money comes back, and delivery releases the payout. ${isConfirmedLiveProof(liveDemoState) ? 'The confirmed Tempo proof below shows the same money path.' : 'The real Tempo proof appears below after payment is confirmed.'}`;
  const flowCopy = live
    ? [
        ['Money committed', 'Buyer funds held'],
        ['Price locked', 'Best offer selected'],
        ['Refund returned', 'Unused buyer money'],
        [isCompleted ? 'Delivery confirmed' : 'Confirm demo delivery', isCompleted ? 'Seller promise resolved' : 'Waiting for delivery confirmation'],
        [isCompleted ? 'Seller paid' : 'Seller payout held', isCompleted ? 'Fee released' : 'Released after delivery'],
      ]
    : [
        ['Buyers join one order', 'The order gets bigger'],
        ['Sellers compete', 'Offers push the price down'],
        ['Price locks', 'The best funded offer wins'],
        ['Surplus returns', 'Unused buyer money comes back'],
        ['Delivery → payout', 'Seller is paid after delivery · 1% fee'],
      ];
  const flowIds = ['Committed', 'Locked', 'Refunded', 'Delivered', 'Paid'];
  flowIds.forEach((suffix, index) => {
    const titleNode = $(`#flowStep${suffix}Title`);
    const noteNode = $(`#flowStep${suffix}Note`);
    if (titleNode) titleNode.textContent = flowCopy[index][0];
    if (noteNode) noteNode.textContent = flowCopy[index][1];
  });
  $$('#liveMoneyFlow [data-flow-step]').forEach((item, index) => {
    item.classList.toggle('is-done', index < currentIndex);
    item.classList.toggle('is-current', index === currentIndex);
  });
}

function formatLiveTransactionStory(proof) {
  if (!proof) return null;
  if (proof.status === 'REFUNDED') return 'Buyer money was returned.';
  if (proof.status === 'COMPLETED') return 'The demo operator confirmed delivery; Tempo released the seller payment.';
  if (['SETTLED', 'AWAITING_FULFILLMENT'].includes(proof.status)) return 'The price was locked and buyer surplus was returned.';
  const receiptCount = Array.isArray(proof.receipts) ? proof.receipts.length : 0;
  return receiptCount ? 'Buyers funded the order and sellers competed on price.' : null;
}

function displayBusinessStatus(status) {
  return ({
    COMPETING: 'PRICES CHANGING',
    WON: 'ORDER COMPLETE',
    FAILED: 'ORDER CLOSED',
    REFUNDED: 'MONEY RETURNED',
  })[status] || status || '—';
}

const scenarioGuideCopy = {
  normal: {
    title: 'A regular group order',
    steps: ['People join', 'Sellers lower prices', 'Lowest price wins'],
    details: [
      'People join one order, so sellers can see real buying power.',
      'More people make the order larger, so a seller offers a lower price.',
      'The group gets the lowest price reached; unused money comes back.',
    ],
  },
  war: {
    title: 'Sellers compete for one order',
    steps: ['Offers appear', 'Prices fall', 'Best price wins'],
    details: [
      'Several sellers see the same ready group of buyers.',
      'Sellers respond to one another by lowering their prices.',
      'The lowest safe offer becomes the group price.',
    ],
  },
  failed: {
    title: 'Seller fails after price lock',
    steps: ['People join', 'Winner fails delivery', 'Money comes back'],
    details: [
      'People fund the example order and their payments enter escrow.',
      'The winning seller cannot complete delivery after the price is locked.',
      'Buyers are refunded; seller payout is $0 and DealArena fee is $0.',
    ],
  },
  refund: {
    title: 'No valid offer before the deadline',
    steps: ['People join', 'Deadline arrives', 'Money comes back'],
    details: [
      'People show demand by joining the example order.',
      'The deadline arrives without a valid funded seller offer.',
      'No sale is made; buyer money is refunded.',
    ],
  },
  business: {
    title: 'Businesses buy together',
    steps: ['Businesses join', 'Suppliers compare prices', 'Group saves'],
    details: [
      'Several cafés combine a regular order into one larger order.',
      'Suppliers compete for the larger, clearer order.',
      'The group sees the saving before deciding whether to join.',
    ],
  },
  request: {
    title: 'People ask for one product',
    steps: ['People ask', 'Sellers make offers', 'Group chooses'],
    details: [
      'One person asks for a product and sets the highest acceptable price.',
      'More people can join the same request, attracting seller offers.',
      'The group can compare the offers instead of searching one by one.',
    ],
  },
};

const scenarioPurposeCopy = {
  normal: 'Normal deal · more buyers create a larger order, so sellers compete on price.',
  war: 'Price war · several sellers react to the same buyers and the price falls.',
  failed: 'Seller fails after price lock · buyers are refunded, seller payout is $0 and the fee is $0.',
  refund: 'Refund · the deadline arrives without a valid funded offer, so no sale is made and buyer money comes back.',
  business: 'Business order · cafés combine a recurring purchase so suppliers can quote for the whole group.',
  request: 'Product request · buyers describe one need and compare offers instead of searching alone.',
};

function updateScenarioPurpose(name = $('#scenario')?.value || 'normal') {
  const purpose = $('#scenarioPurpose');
  if (purpose) purpose.textContent = scenarioPurposeCopy[name] || scenarioPurposeCopy.normal;
}

function updateScenarioGuide(name, index = 0, total = 3, starting = false) {
  const guide = $('#scenarioGuide');
  if (!guide) return;
  // Deal stage is now the single story surface. The old guide repeated the
  // same instructions above the page and made the demo feel robotic.
  guide.hidden = true;
  return;
  const copy = scenarioGuideCopy[name] || scenarioGuideCopy.normal;
  const stepCount = Math.max(1, Number(total) || copy.steps.length);
  const title = $('#scenarioGuideTitle');
  const detail = $('#scenarioGuideDetail');
  const progressIndex = Math.min(Math.max(0, Number(index) || 0), stepCount - 1);
  const phaseIndex = starting || stepCount <= 1
    ? 0
    : Math.min(2, Math.floor((progressIndex / Math.max(1, stepCount - 1)) * 3));
  if (title) title.textContent = copy.title;
  if (detail) detail.textContent = starting
    ? 'Starting the example. It pauses between each step so you can follow the payment and price change.'
    : `Step ${progressIndex + 1} of ${stepCount} · ${copy.details[phaseIndex]}`;
  copy.steps.forEach((label, stepIndex) => {
    const item = $(`#scenarioGuide [data-guide-step="${stepIndex}"]`);
    const labelEl = $(`#scenarioGuideStep${stepIndex + 1}`);
    if (labelEl) labelEl.textContent = label;
    if (item) {
      item.classList.toggle('is-current', !starting && stepIndex === phaseIndex);
      item.classList.toggle('is-done', !starting && stepIndex < phaseIndex);
    }
  });
  guide.hidden = false;
}

function resetScenarioGuide() {
  const guide = $('#scenarioGuide');
  if (guide) guide.hidden = true;
  $$('#scenarioGuide [data-guide-step]').forEach((item) => item.classList.remove('is-current', 'is-done'));
}

function dealStoryEventFor(data = {}, stepIndex = 0) {
  const accounting = data.accounting || {};
  const buyers = Number(data.buyers || 0).toLocaleString('en-US');
  const committedCents = Number(accounting.committedCents || 0) || Math.max(0, Number(data.buyers || 0)) * Math.max(0, Number(data.depositUnitPrice || numericValue(data.best) || 0)) * 100;
  const committed = Market.dollars(committedCents);
  if (data.status === 'REFUNDED') {
    return data.failureType === 'DELIVERY_FAILED'
      ? `Seller failed after price lock → ${Market.dollars(accounting.refundedCents || 0)} returned → seller payout $0 · fee $0`
      : `No valid seller offer by deadline → ${Market.dollars(accounting.refundedCents || 0)} returned`;
  }
  if (data.status === 'WON') return `${buyers} buyers → ${data.winnerSeller || 'Winning seller'} won at ${data.best} → ${Market.dollars(accounting.grossCents || 0)} order`;
  if (Number(data.buyers || 0) <= 50) return `+${buyers} buyers joined → ${committed} ready to buy`;
  if (data.winnerIndex >= 0) return `${buyers} buyers modeled at ${committed} demand → ${data.winnerSeller || 'Seller'} cut price to ${data.best} → ${data.saving || 'buyers save more'}`;
  return `${buyers} buyers joined → the order became more valuable to sellers`;
}

function dealLiveProgressEvent(data = {}, previous = null) {
  if (!isScenarioActive) return '';
  const buyers = Number(data.buyers || 0);
  const previousBuyers = Number(previous?.buyers || 0);
  if (buyers <= previousBuyers) return '';

  if (buyers >= 500 && previousBuyers < 500) {
    return `${buyers.toLocaleString('en-US')} buyers reached → ${data.best || '$590'} tier unlocked`;
  }

  const currentBucket = Math.floor(buyers / 50);
  const previousBucket = Math.floor(previousBuyers / 50);
  if (currentBucket > previousBucket) {
    const accounting = data.accounting || {};
    const committedCents = Number(accounting.committedCents || 0)
      || buyers * Math.max(0, Number(data.depositUnitPrice || numericValue(data.best) || 0)) * 100;
    return `${buyers.toLocaleString('en-US')} buyers joined → ${Market.dollars(committedCents)} modeled demand`;
  }

  return '';
}

function addDealStoryEvent(message) {
  const text = String(message || '').trim();
  if (!text || dealStoryEvents.includes(text)) return;
  dealStoryEvents.push(text);
  dealStoryEvents = dealStoryEvents.slice(-8);
  renderDealStoryEvents();
}

function renderDealStoryEvents() {
  const list = $('#dealStoryEvents');
  if (!list) return;
  list.replaceChildren(...dealStoryEvents.slice(-8).map((message) => {
    const item = document.createElement('span');
    item.className = 'deal-story-event';
    item.textContent = message;
    return item;
  }));
}

function updateDealStage(data = {}, stepIndex = 0, totalSteps = 3) {
  const buyers = Number(data.buyers || 0);
  const terminal = ['WON', 'REFUNDED'].includes(data.status);
  const awaitingDelivery = data.status === 'AWAITING_FULFILLMENT';
  const current = terminal ? 3 : awaitingDelivery ? 2 : buyers >= 200 ? 1 : 0;
  const stage = $('#dealStage');
  if (stage) {
    stage.dataset.stage = ['buyers', 'sellers', 'close', 'money'][current];
    stage.classList.toggle('is-running', isScenarioActive);
  }
  const page = $('#deal');
  if (page) {
    page.dataset.marketStage = ['buyers', 'sellers', 'close', 'money'][current];
    page.classList.toggle('is-playing', isScenarioActive);
  }
  const labels = [
    ['Buyers are joining', 'More buyers make this order worth competing for.', 'BUYERS JOINING'],
    ['Sellers are competing', 'A larger order gives sellers room to lower the price.', 'SELLERS COMPETING'],
    [awaitingDelivery ? 'Delivery is still required' : data.status === 'REFUNDED' ? data.failureType === 'DELIVERY_FAILED' ? 'Seller failed after price lock' : 'No valid seller offer' : 'The lowest offer wins', awaitingDelivery ? 'The winning seller is paid only after delivery is confirmed.' : data.status === 'REFUNDED' ? data.failureType === 'DELIVERY_FAILED' ? 'The guarantee is forfeited; buyers are refunded and seller payout stays at $0.' : 'The deadline passed without a valid seller offer, so buyer money comes back.' : 'The group gets the lowest offer that fits the order.', awaitingDelivery ? 'DELIVERY CHECK' : 'DEAL CLOSED'],
    [data.status === 'REFUNDED' ? 'Money comes back' : 'The result is clear', data.status === 'REFUNDED' ? data.failureType === 'DELIVERY_FAILED' ? 'Buyer refund complete; no seller payout or 1% fee.' : 'Buyer refund complete; no sale was forced.' : 'Buyers, seller and DealArena each have a clear outcome.', 'RESULT READY'],
  ];
  const title = $('#dealStageTitle');
  const message = $('#dealStageMessage');
  const badge = $('#dealStageBadge');
  if (title) title.textContent = labels[current][0];
  if (message) message.textContent = labels[current][1];
  // Show the human-readable business stage, not an internal step counter.
  // "RUNNING · 2/4" made a normal open market look broken to jurors.
  if (badge) badge.textContent = labels[current][2];
  const copy = [
    `Growing toward ${buyers.toLocaleString('en-US')} people`,
    `${Math.max(0, Number(data.offers?.filter((offer) => /^\$/.test(String(offer))).length || 0))} seller offers are visible`,
    awaitingDelivery ? 'Price locked · waiting for delivery' : data.status === 'REFUNDED' ? data.failureType === 'DELIVERY_FAILED' ? 'Seller failed · buyer refund' : 'No valid offer · buyer refund' : `${data.best || '—'} is the current best price`,
    data.status === 'WON' ? 'Seller, fee and buyer refund are shown separately' : 'Visible result, no hidden payment',
  ];
  const keys = ['buyers', 'sellers', 'close', 'money'];
  keys.forEach((key, index) => {
    const item = $(`#dealStage [data-deal-stage="${key}"]`);
    if (!item) return;
    item.classList.toggle('is-current', index === current);
    item.classList.toggle('is-done', index < current);
    const small = item.querySelector('small');
    if (small) small.textContent = copy[index];
  });
}

function renderDealResult(data = {}) {
  const panel = $('#dealResult');
  const terminal = ['WON', 'REFUNDED'].includes(data.status);
  if (!panel) return;
  panel.hidden = !terminal;
  if (!terminal) return;
  const accounting = data.accounting || {};
  const buyers = Number(data.buyers || 0);
  const retailCents = numericValue(data.retail) * 100;
  const finalCents = data.status === 'WON' ? (Market.winningPrice(data.offers, data.winnerIndex) || 0) : 0;
  const savedCents = data.status === 'WON' ? Math.max(0, retailCents - finalCents) * buyers : 0;
  const set = (id, value) => { const element = $('#' + id); if (element) element.textContent = value; };
  set('dealResultBuyers', `${buyers.toLocaleString('en-US')} buyers`);
  set('dealResultRetail', `Retail: ${data.retail || '—'}`);
  set('dealResultFinal', data.status === 'WON' ? `Final: ${data.best}` : 'Final: no sale');
  set('dealResultSaved', Market.dollars(savedCents));
  set('dealResultReturned', Market.dollars(accounting.refundedCents || 0));
  set('dealResultOrder', data.status === 'WON' ? `${Market.dollars(accounting.grossCents || 0)} order` : 'No sale forced');
  set('dealResultFee', data.status === 'WON' ? Market.dollars(accounting.feeCents || 0) : '$0');
  set('dealResultLead', data.status === 'WON'
    ? 'Market scale is simulated. Prices, buyer savings, amount returned and seller payout are modeled. The separate LIVE_TESTNET transaction is the real payment proof.'
    : data.failureType === 'DELIVERY_FAILED'
      ? 'Seller delivery failed after price lock. Buyers are refunded; seller payout and DealArena fee are $0 in this example.'
      : 'The deadline passed without a valid seller offer. Buyer money comes back; no seller payout or DealArena fee is created.');
  const badge = $('#dealResultBadge');
  if (badge) badge.textContent = 'EXAMPLE MARKET';
}

function resetDealStory() {
  dealStoryEvents = [];
  lastOfferValues = { A: null, B: null, C: null };
  lastDealWinner = -1;
  renderDealStoryEvents();
  const result = $('#dealResult');
  if (result) result.hidden = true;
  const title = $('#dealStageTitle');
  const message = $('#dealStageMessage');
  const badge = $('#dealStageBadge');
  if (title) title.textContent = 'Buyers are joining';
  if (message) message.textContent = 'More buyers give sellers a reason to cut the price.';
  if (badge) badge.textContent = 'READY';
  $$('#dealStage [data-deal-stage]').forEach((item) => item.classList.remove('is-current', 'is-done'));
}

function formatExactCents(cents) {
  const amount = Number(cents || 0) / 100;
  return Number.isInteger(amount)
    ? `$${amount.toLocaleString('en-US')}`
    : `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderSettlementReceipt(summary, mode = 'SIMULATED', dealId = activeIds.dealId, hash = null, status = 'WON', proof = null) {
  const panel = $('#settlementReceipt');
  if (!panel || !summary) {
    if (panel) panel.hidden = true;
    return;
  }
  const money = (value) => value === undefined || value === null ? '—' : formatExactCents(value);
  const live = mode === 'LIVE_TESTNET';
  const funding = live && status === 'FUNDING';
  const historical = live && proof?.historical === true;
  panel.hidden = false;
  panel.classList.toggle('is-live-proof', live);
  const proofHighlight = $('#receiptTempoProof');
  const units = Math.max(1, Number(summary.totalUnits ?? summary.units ?? summary.buyersCount ?? 1));
  const unitPrice = summary.unitPriceCents ?? summary.finalPriceCents;
  const orderTotal = summary.grossOrderCents ?? summary.finalOrderCents ?? Number(summary.finalPriceCents || 0) * units;
  if (proofHighlight) proofHighlight.hidden = !live;
  if (live) {
    if ($('#receiptProofTitle')) $('#receiptProofTitle').textContent = historical
      ? 'Confirmed Tempo proof · read-only'
      : status === 'REFUNDED'
      ? 'Real Tempo proof · money returned'
      : status === 'SETTLED'
        ? 'Real Tempo proof · price locked'
        : 'Real Tempo proof · payment completed';
    if ($('#receiptProofStory')) $('#receiptProofStory').textContent = historical
      ? 'These receipts are from the last confirmed Tempo testnet run. Viewing this proof is read-only and does not send a transaction.'
      : status === 'REFUNDED'
      ? 'Buyer money was returned on Tempo because the order did not complete.'
      : status === 'SETTLED'
        ? `The price locked at ${money(orderTotal)} on Tempo and unused buyer money came back. Seller payment stays held until delivery.`
      : '3 demo buyer wallets funded this testnet order. Sellers competed, surplus returned, and the demo operator confirmed delivery to release the seller payment.';
  }
  if ($('#receiptEyebrow')) $('#receiptEyebrow').textContent = live
    ? historical ? 'CONFIRMED TEMPO RECEIPTS · READ-ONLY' :
    status === 'SETTLED' ? 'VERIFIED TEMPO MONEY FLOW · PRICE LOCKED' : status === 'COMPLETED' ? 'VERIFIED TEMPO MONEY FLOW · COMPLETED' : 'VERIFIED TEMPO MONEY FLOW · REFUNDED'
    : 'EXAMPLE SCALE · NO TEMPO RECEIPT';
  if ($('#receiptTitle')) $('#receiptTitle').textContent = status === 'REFUNDED'
    ? live ? 'Money returned to buyers' : 'Buyer payments returned'
    : status === 'COMPLETED'
      ? live ? 'Order completed' : 'Example order completed'
      : status === 'SETTLED'
        ? live ? 'Price locked — delivery still open' : 'Example price locked'
      : live ? 'Buyer refund confirmed on Tempo' : 'Example order result';
  if ($('#receiptEyebrow') && !live) $('#receiptEyebrow').textContent = 'EXAMPLE SCALE · NO TEMPO RECEIPT';
  if ($('#receiptBadge') && !live) $('#receiptBadge').textContent = 'EXAMPLE';
  if ($('#receiptBadge')) $('#receiptBadge').textContent = live
    ? historical ? 'VERIFIED ON TEMPO · READ-ONLY' : proof?.chainVerified ? 'VERIFIED ON TEMPO' : status === 'SETTLED' ? 'AWAITING DELIVERY' : status === 'REFUNDED' ? 'REFUNDED' : 'DELIVERY CONFIRMED'
    : 'EXAMPLE';
  if ($('#receiptCommitted')) $('#receiptCommitted').textContent = money(summary.committedCents);
  if ($('#receiptUnitPrice')) $('#receiptUnitPrice').textContent = money(summary.unitPriceCents ?? summary.finalPriceCents);
  if ($('#receiptFinal')) $('#receiptFinal').textContent = money(orderTotal);
  if ($('#receiptPayout')) $('#receiptPayout').textContent = live && status === 'SETTLED' ? `${money(summary.sellerPayoutCents)} held` : money(summary.sellerPayoutCents);
  if ($('#receiptFee')) $('#receiptFee').textContent = live && status === 'SETTLED' ? `${money(summary.feeCents)} held` : money(summary.feeCents);
  if ($('#receiptRefund')) $('#receiptRefund').textContent = money(summary.buyerRefundCents);
  const transactionList = $('#receiptTransactionList');
  const transactionLinks = $('#receiptTransactionLinks');
  const transactionCount = $('#receiptTransactionCount');
  if (transactionList && transactionLinks) {
    transactionLinks.replaceChildren();
    const transactionRows = live
      ? (Array.isArray(proof?.receipts) ? proof.receipts : Array.isArray(liveDemoState?.receipts) ? liveDemoState.receipts : [])
        .filter((receipt) => receipt?.status === 'CONFIRMED' && receipt?.isOnChain === true && /^0x[\da-f]{64}$/i.test(String(receipt.hash || '')))
      : [];
    const transactionLabel = (receipt) => {
      if (receipt.type === 'DEMO_BUYER_JOIN') return `Buyer commitment · ${receipt.actor || 'buyer'}`;
      if (receipt.type === 'DEMO_SELLER_LADDER') return 'Seller price ladder';
      if (receipt.type === 'DEMO_SELLER_OFFER') return 'Seller offer';
      if (receipt.type === 'TEMPO_NATIVE_FULFILLMENT_FAILURE') return 'Seller failed · buyer refund';
      if (receipt.type === 'TEMPO_NATIVE_REFUND' || receipt.type === 'TEMPO_REFUND') return 'Buyer refund + deal close';
      if (receipt.type === 'TEMPO_NATIVE_FULFILLMENT' || receipt.type === 'TEMPO_FULFILLMENT_CONFIRMATION') return 'Final fulfillment + seller payout';
      if (receipt.type === 'TEMPO_NATIVE_SETTLEMENT') return 'Price lock + buyer surplus';
      return receipt.eventLogMessage || 'Tempo payment';
    };
    transactionRows.forEach((receipt, index) => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${index + 1}. ${transactionLabel(receipt)}`;
      const detail = document.createElement('small');
      detail.textContent = receipt.details || 'Confirmed on Tempo';
      const status = document.createElement('b');
      status.className = 'receipt-confirmed-status';
      status.textContent = 'CONFIRMED';
      const hash = document.createElement('code');
      hash.textContent = receipt.hash ? `${receipt.hash.slice(0, 8)}…${receipt.hash.slice(-6)}` : 'confirmed';
      const link = document.createElement('a');
      link.href = receipt.hash ? `${TEMPO_EXPLORER}/receipt/${receipt.hash}` : receipt.explorerUrl || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View on Tempo';
      row.append(label, detail, status, hash, link);
      transactionLinks.append(row);
    });
    transactionList.hidden = !live || !transactionRows.length;
    if (transactionCount) transactionCount.textContent = transactionRows.length ? `${transactionRows.length} confirmed` : '';
  }
  if ($('#receiptMemo')) $('#receiptMemo').textContent = live
    ? historical
      ? `Read-only confirmed receipts · Buyer paid ${money(unitPrice)} per item · Delivery confirmed on Tempo · Seller paid ${money(summary.sellerPayoutCents)} · DealArena fee released ${money(summary.feeCents)} · Buyer got ${money(summary.buyerRefundCents)} back`
      : status === 'SETTLED'
      ? `Buyer paid ${money(unitPrice)} per item · Price locked on Tempo · Buyer got ${money(summary.buyerRefundCents)} back · Seller payout held until delivery`
      : status === 'COMPLETED'
        ? `Buyer paid ${money(unitPrice)} per item · Delivery confirmed on Tempo · Seller paid ${money(summary.sellerPayoutCents)} · DealArena fee released ${money(summary.feeCents)} · Buyer got ${money(summary.buyerRefundCents)} back`
        : `Buyer paid ${money(unitPrice)} per item · Buyer money returned on Tempo · ${money(summary.buyerRefundCents)} returned · No seller payout or fee`
    : `Example market outcome · no payment receipt · Order ${dealId}`;
  if ($('#receiptDealId')) $('#receiptDealId').textContent = dealId ? `Deal ID: ${dealId}` : '';
  if (funding) {
    $('#receiptEyebrow').textContent = 'NEW TEMPO TESTNET ORDER';
    $('#receiptTitle').textContent = 'New payments in progress';
    $('#receiptBadge').textContent = 'WAITING FOR CONFIRMATION';
    $('#receiptProofTitle').textContent = 'Buyer funding and seller offers';
    $('#receiptProofStory').textContent = 'Each transaction appears below only after Tempo confirms it. Price lock and surplus refund come next; seller payout still waits for demo delivery.';
    $('#receiptUnitPrice').textContent = 'Not locked yet';
    $('#receiptFinal').textContent = 'Not locked yet';
    $('#receiptPayout').textContent = 'Not paid';
    $('#receiptFee').textContent = 'Not released';
    $('#receiptRefund').textContent = 'Not returned yet';
    $('#receiptMemo').textContent = proof?.lastError || 'Sending this new order. Previous-order receipts are not used as its result.';
  }
}

async function checkLivePendingReceipt() {
  const pending = liveDemoState && ['PENDING', 'IN_PROGRESS'].includes(liveDemoState.status) && liveDemoState.currentStep && liveDemoState.lastHash;
  if (!pending) {
    liveReceiptAvailable = false;
    return false;
  }
  try {
    const response = await fetch(`/api/demo/mini-deal/status?simulationDealId=${encodeURIComponent(liveDemoState.simulationDealId || '')}`);
    const data = response.ok ? await response.json() : null;
    liveReceiptAvailable = Boolean(data?.receiptAvailable);
  } catch {
    liveReceiptAvailable = false;
  }
  updateLiveAvailability();
  return liveReceiptAvailable;
}

setInterval(() => {
  if (liveDemoState?.status === 'PENDING' || liveDemoState?.status === 'IN_PROGRESS') void checkLivePendingReceipt();
}, 5000);

function updateLiveAvailability() {
  $('#dealStage')?.classList.toggle('is-running', isScenarioActive);
  $('#deal')?.classList.toggle('is-playing', isScenarioActive);
  updateHomeTempoProof();
  updateLiveMoneyFlow();
  const checking = !liveReadinessKnown;
  const localLiveHost = ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname);
  const publicAccessBlocked = !localLiveHost && !livePublicDemoEnabled;
  const unavailable = liveReadinessKnown && (!livePaymentsEnabled || publicAccessBlocked);
  const simulationDealId = activeIds.dealId;
  const liveReady = liveDemoState?.status === 'READY_TO_SETTLE';
  const liveNeedsRecovery = ['IN_PROGRESS', 'PENDING'].includes(liveDemoState?.status) && Boolean(liveDemoState?.currentStep);
  const liveResumeAvailable = liveNeedsRecovery && liveReceiptAvailable;
  const liveRecoverable = ['IN_PROGRESS', 'PENDING', 'PARTIAL_FAILED'].includes(liveDemoState?.status) && Number(liveDemoState?.buyersCount || 0) > 0;
  const liveAwaitingFulfillment = ['SETTLED', 'AWAITING_FULFILLMENT'].includes(liveDemoState?.status)
    && liveDemoState?.fulfillmentConfirmed !== true && liveDemoState?.guaranteeResolved !== true;
  const liveTerminal = ['COMPLETED', 'REFUNDED'].includes(liveDemoState?.status);
  const candidateProof = liveDemoState
    ? (liveTerminal || liveAwaitingFulfillment) && liveDemoState.settlementSummary ? liveDemoState : null
    : !livePublicDemoEnabled && latestLiveProof?.settlementSummary ? latestLiveProof : null;
  // Delivery is not required to show already-confirmed funding and surplus.
  // Keep the stricter verification gate for historical/completed proof.
  const currentPriceLockConfirmed = isCurrentPriceLockConfirmed(candidateProof);
  const confirmedProof = isConfirmedLiveProof(candidateProof) || currentPriceLockConfirmed || isCurrentRefundConfirmed(candidateProof) ? candidateProof : null;
  const historicalProof = !livePublicDemoEnabled && !liveDemoState && !confirmedProof && isConfirmedLiveProof(historicalLiveProof) ? historicalLiveProof : null;
  const displayProof = confirmedProof || historicalProof;
  const historicalOnly = Boolean(historicalProof);
  const hasLatestProof = Boolean(confirmedProof);
  const completedMarketButton = $('#joinDealPage');
  if (completedMarketButton && publicAccessBlocked && Market.terminal(currentDeal?.status) && displayProof) {
    completedMarketButton.disabled = false;
    completedMarketButton.textContent = 'View verified proof';
    completedMarketButton.classList.add('proof-read-only');
    completedMarketButton.title = 'Shows confirmed payment receipts only. Sends no transaction.';
  }
  // The jury flow must reveal proof after the market story, not on the first
  // frame. A retained Tempo receipt is historical evidence, not the result of
  // the current OPEN example.
  const currentExampleFinished = ['WON', 'REFUNDED'].includes(currentDeal?.status);
  // A confirmed proof is an independent, read-only artifact. Do not force a
  // visitor to replay the simulated market before they can inspect the real
  // Tempo receipts from Business, Request, or Sell.
  const showLiveProofForExample = !publicAccessBlocked || currentDeal?.status === 'WON' || Boolean(displayProof);
  const liveFlowPanel = $('#liveMoneyFlow');
  const liveProof = $('#liveDealProof');
  if (liveFlowPanel) liveFlowPanel.hidden = !showLiveProofForExample;
  if (liveProof) liveProof.hidden = !showLiveProofForExample;
  if (displayProof && showLiveProofForExample) {
    const proofSummary = displayProof.status === 'REFUNDED'
      ? displayProof.refundReceipt?.settlementSummary || displayProof.settlementSummary : displayProof.settlementSummary;
    setTestnetLive(displayProof.status === 'REFUNDED' ? displayProof.refundHash || displayProof.lastHash
      : displayProof.fulfillmentHash || displayProof.settlementHash || displayProof.lastHash,
      'LIVE_TESTNET', displayProof.status === 'AWAITING_FULFILLMENT' ? 'Price locked · awaiting delivery' : displayProof.status,
      { receipts: displayProof.receipts });
    renderSettlementReceipt(
      proofSummary,
      'LIVE_TESTNET',
      displayProof.liveDealId,
      displayProof.status === 'REFUNDED'
        ? displayProof.refundHash || displayProof.lastHash || null
        : displayProof.fulfillmentHash || displayProof.settlementHash || displayProof.lastHash || null,
      displayProof.status === 'REFUNDED' ? 'REFUNDED' : displayProof.status === 'COMPLETED' ? 'COMPLETED' : 'SETTLED',
      displayProof,
    );
    const receiptMemo = $('#receiptMemo');
    const transactionStory = historicalOnly
      ? 'Read-only historical proof; this page will not send another payment.'
      : formatLiveTransactionStory({ ...displayProof, settlementSummary: proofSummary });
    if (receiptMemo && transactionStory && !receiptMemo.textContent.includes(transactionStory)) receiptMemo.textContent += ` · ${transactionStory}`;
  } else if (liveLaunchInProgress && liveLaunchStep === 'payment' && !liveDemoState || ['PENDING', 'IN_PROGRESS', 'READY_TO_SETTLE', 'PARTIAL_FAILED'].includes(liveDemoState?.status)) {
    const progressProof = liveDemoState || { receipts: [] };
    const committedCents = (progressProof.receipts || [])
      .filter((entry) => entry.type === 'DEMO_BUYER_JOIN' && entry.status === 'CONFIRMED' && entry.isOnChain === true)
      .reduce((sum, entry) => sum + Number(entry.unitPriceCents || 0), 0);
    renderSettlementReceipt({ committedCents }, 'LIVE_TESTNET', progressProof.liveDealId || null, null, 'FUNDING', progressProof);
  } else {
    const receiptPanel = $('#settlementReceipt');
    if (receiptPanel) receiptPanel.hidden = true;
  }
  const simulatedLead = $('#simPaymentLead');
  const confirmedPaymentCount = (Array.isArray(displayProof?.receipts) ? displayProof.receipts : [])
    .filter((receipt) => receipt?.status === 'CONFIRMED' && receipt?.isOnChain && receipt?.hash).length;
  const realBuyerCount = Number(displayProof?.buyersCount || displayProof?.settlementSummary?.totalUnits || 0);
  const modeledScale = simulatedBuyerCount().toLocaleString('en-US');
  if (simulatedLead) simulatedLead.textContent = confirmedPaymentCount
    ? `The ${modeledScale}-buyer market is modeled, not charged. Below: ${realBuyerCount} demo buyer wallets paid on Tempo testnet, with ${confirmedPaymentCount} confirmed transactions.`
    : `The ${modeledScale}-buyer market is modeled, not charged. A confirmed real Tempo payment proof will appear here when available.`;
  const liveConsumed = liveProofUsed && !liveReady && !liveRecoverable && !liveTerminal && !liveAwaitingFulfillment;
  const missingApprovals = Object.entries(liveReadiness?.checks?.wallets || {})
    .filter(([, wallet]) => !wallet?.approved)
    .map(([role]) => ({ buyer: 'buyer', sellerA: 'Seller A', sellerB: 'Seller B', sellerC: 'Seller C' }[role] || role));
  const readinessDetail = missingApprovals.length
    ? `One-time setup is still needed for: ${missingApprovals.join(', ')}.`
    : liveReadiness?.checks?.contractVersion === false
      ? 'Verified Tempo proof is hidden until the current payment rules are deployed.'
      : 'The test payment setup is not ready yet.';
  const liveOpen = Boolean(liveDemoState?.liveDealId) && !liveTerminal
    && (Number(liveDemoState?.buyersCount || 0) > 0 || Boolean(liveDemoState?.lastHash && liveDemoState?.currentStep));
  const ownerActions = $('.owner-actions');
  const ownerTools = $('#liveOwnerTools');
  const ownerButtons = $$('#settleDealLive, #confirmDealFulfillmentLive, #slashDealGuaranteeLive, #refundDealLive');
  const businessLiveControls = $('#businessLiveControls');
  const requestLiveControls = $('#requestLiveControls');
  const auxiliaryOwnerButtons = $$('#settleBusinessLive, #confirmBusinessFulfillmentLive, #slashBusinessSupplierLive, #refundBusinessLive, #settleRequestLive, #confirmRequestFulfillmentLive, #slashRequestSupplierLive, #refundRequestLive');
  const liveActionNote = $('#liveActionNote');
  if (liveActionNote) liveActionNote.textContent = checking
    ? 'Checking the payment record…'
    : liveAwaitingFulfillment
    ? 'Buyer payments and surplus refund are confirmed below. Confirm demo delivery to release the seller payout and 1% fee.'
    : displayProof
    ? 'The real order amounts and transaction links are shown below. The large market above is a separate scale example.'
    : historicalOnly
    ? 'Confirmed Tempo receipts are shown below in read-only mode. This example does not send another payment.'
    : hasLatestProof && !liveOpen
    ? 'View confirmed Tempo payments below. Run LIVE proof again starts a new testnet order.'
    : unavailable
    ? publicAccessBlocked
      ? 'This page shows the latest confirmed payment. A new real payment can be started only by the presenter.'
      : `The real proof is not ready yet. ${readinessDetail}`
    : liveReady
      ? 'You can show one real payment: buyers fund the order, sellers compete, and the money is split clearly.'
      : liveAwaitingFulfillment
        ? 'The real order is waiting for delivery confirmation. Finish it before showing another real payment.'
      : liveTerminal || hasLatestProof
        ? 'LIVE payment proof is confirmed below. The order above is still an example.'
        : 'Start the LIVE proof to move testnet money. The example above is never presented as paid.';
  if (liveActionNote && currentExampleFinished && liveResumeAvailable) liveActionNote.textContent = 'A real payment step is waiting for confirmation. Resume it here; opening the page will not send another payment.';
  if (liveActionNote && currentExampleFinished && liveNeedsRecovery && !liveResumeAvailable) liveActionNote.textContent = 'A real payment is still being confirmed. This page is only checking its status; it will not send another payment.';
  if (liveActionNote && currentExampleFinished && liveRecoverable && !liveResumeAvailable) liveActionNote.textContent = 'The buyer payment was confirmed and needs to be finished. A refund is available; the example order stays protected.';
  if (liveActionNote && currentExampleFinished && liveConsumed) liveActionNote.textContent = 'This presenter session already used its real proof. The page will not send another payment in the background.';
  if (liveActionNote && currentExampleFinished && historicalOnly) liveActionNote.textContent = 'Confirmed Tempo receipts are shown below in read-only mode. This example does not send another payment.';
  const paymentActionsReady = connectedWalletReady() && !publicAccessBlocked;
  const paymentUnavailableText = publicAccessBlocked
    ? 'Tempo payment is presenter-only'
    : browserWalletUnavailableText(checking);
  syncDealCommitAction();
  const businessPaymentButton = $('#joinBusinessPool');
  if (businessPaymentButton) {
    const businessClosed = Market.terminal(businessStatus);
    const canConnect = walletCanConnect() && !connectedWalletPresent;
    const canSwitch = walletCanConnect() && connectedWalletPresent && !connectedWalletOnTempo;
    const proofOnly = !BROWSER_WALLET_ACTIONS_ENABLED;
    businessPaymentButton.disabled = checking || (businessClosed && !proofOnly) || (!proofOnly && !paymentActionsReady && !canConnect && !canSwitch);
    businessPaymentButton.textContent = proofOnly ? readOnlyFlowLabel('payment') : businessClosed ? 'Order complete' : paymentActionsReady ? 'Pay on Tempo' : canSwitch ? 'Switch wallet to Tempo' : canConnect ? 'Connect wallet to pay' : 'Use LIVE proof';
    businessPaymentButton.title = proofOnly ? readOnlyFlowTitle('payment') : paymentActionsReady || businessClosed ? '' : canConnect || canSwitch ? 'Connect the wallet first. No business payment is sent during connection.' : paymentUnavailableText;
  }
  const requestPaymentButton = $('#joinRequestButton');
  if (requestPaymentButton) {
    const requestRecord = requestRecordForSelection();
    const requestJoined = Boolean(requestJoinState[selectedRequestId]);
    const requestClosed = Market.terminal(requestRecord.status);
    const proofOnly = !BROWSER_WALLET_ACTIONS_ENABLED;
    requestPaymentButton.disabled = checking || (!proofOnly && (!paymentActionsReady || requestJoined || requestClosed));
    requestPaymentButton.textContent = proofOnly ? readOnlyFlowLabel('payment') : requestJoined ? 'Joined on Tempo' : requestClosed ? 'Request closed' : paymentActionsReady ? 'Join this request on Tempo' : 'Use LIVE proof';
    requestPaymentButton.title = proofOnly ? readOnlyFlowTitle('payment') : paymentActionsReady || requestJoined || requestClosed ? '' : paymentUnavailableText;
  }
  const requestFundButton = $('#fundRequestButton');
  if (requestFundButton && !paymentActionsReady) {
    requestFundButton.hidden = true;
    requestFundButton.disabled = true;
  }
  const createRequestButton = $('#requestForm button[type="submit"]');
  if (createRequestButton) {
    const canConnect = walletCanConnect() && !connectedWalletPresent;
    const canSwitch = walletCanConnect() && connectedWalletPresent && !connectedWalletOnTempo;
    const proofOnly = !BROWSER_WALLET_ACTIONS_ENABLED;
    const requestForm = $('#requestForm');
    if (requestForm) requestForm.noValidate = proofOnly;
    createRequestButton.disabled = checking || (!proofOnly && !paymentActionsReady && !canConnect && !canSwitch);
    createRequestButton.textContent = proofOnly ? 'Show request' : paymentActionsReady ? 'Create funded request' : canSwitch ? 'Switch wallet to Tempo' : canConnect ? 'Connect wallet to pay' : paymentUnavailableText;
    createRequestButton.title = proofOnly ? 'Shows this request as a read-only example. Sends no transaction.' : paymentActionsReady ? '' : canConnect || canSwitch ? 'Connect the wallet first. No request payment is sent during connection.' : paymentUnavailableText;
  }
  const sellerOfferButton = $('#offerForm button[type="submit"]');
  if (sellerOfferButton) {
    const canConnect = walletCanConnect() && !connectedWalletPresent;
    const canSwitch = walletCanConnect() && connectedWalletPresent && !connectedWalletOnTempo;
    const proofOnly = !BROWSER_WALLET_ACTIONS_ENABLED;
    sellerOfferButton.disabled = checking || (!proofOnly && !paymentActionsReady && !canConnect && !canSwitch);
    sellerOfferButton.textContent = proofOnly ? 'Show offer' : paymentActionsReady ? 'Publish offer · lock guarantee' : canSwitch ? 'Switch wallet to Tempo' : canConnect ? 'Connect wallet to pay' : 'Use LIVE proof';
    sellerOfferButton.title = proofOnly ? 'Shows this offer as a read-only example. Sends no guarantee.' : paymentActionsReady ? '' : canConnect || canSwitch ? 'Connect the wallet first. Your guarantee is not sent during connection.' : paymentUnavailableText;
  }
  const sellerProofLink = $('#sellerProofLink');
  if (sellerProofLink) {
    sellerProofLink.textContent = readOnlyFlowLabel('seller');
    sellerProofLink.title = readOnlyFlowTitle('seller');
  }
  const sellerStatus = $('#guaranteeStatus');
  if (sellerStatus && !paymentActionsReady) {
    sellerStatus.dataset.paymentBlocked = 'true';
    sellerStatus.textContent = checking ? 'Checking LIVE proof…' : BROWSER_WALLET_ACTIONS_ENABLED
      ? 'Publishing is unavailable. No offer or guarantee payment has been sent.'
      : 'Preview only. No guarantee sent.';
  } else if (sellerStatus?.dataset.paymentBlocked === 'true') {
    delete sellerStatus.dataset.paymentBlocked;
    sellerStatus.textContent = 'Publishing locks your guarantee on Tempo. It returns after delivery is confirmed.';
  }
  const businessActionNote = $('#businessPaymentActionNote');
  if (businessActionNote) businessActionNote.textContent = checking ? 'Checking LIVE proof…'
    : paymentActionsReady ? 'Pay on Tempo holds your contribution for this order. The 47-café figures below show the business case.'
      : 'This page shows the business case. The confirmed Tempo payment is on the Deal page.';
  const requestCreateHint = $('#requestCreateHint');
  if (requestCreateHint) requestCreateHint.textContent = checking ? 'Checking LIVE proof…'
    : paymentActionsReady ? 'Creating a request holds your maximum payment on Tempo. If the winning price is lower, the difference returns.'
      : 'Create a read-only example here. In a real order, the maximum price is funded first and the difference returns after a lower offer wins.';
  const runButton = $('#runScenario');
  const resetButton = $('#resetScenario');
  const selectedFlow = $('#scenario')?.value || 'normal';
  const demoBlockedNote = $('#demoBlockedNote');
  if (demoBlockedNote) {
    // Keep a real scenario error visible until the user starts or resets the
    // example again. Previously this refresh path erased the diagnostic in the
    // same finally block that tried to show it, leaving the jury with a silent
    // RUNNING state.
    demoBlockedNote.hidden = !demoBlockedNote.textContent;
  }
  if (runButton) {
    runButton.disabled = isScenarioActive || liveLaunchInProgress || (selectedFlow === 'normal' && checking);
    runButton.textContent = selectedFlow === 'normal' && checking ? 'Checking Tempo payments…'
      : liveLaunchInProgress ? primaryActionProgressLabel() : isScenarioActive
      ? 'Working…'
      : selectedFlow === 'normal' && !publicAccessBlocked
        ? liveAwaitingFulfillment ? 'Confirm demo delivery · pay seller' : 'Run new order · Tempo testnet'
      : selectedFlow === 'business'
        ? 'Open business order'
        : selectedFlow === 'request'
          ? 'Open product request'
          : 'Run market example · no payment';
    if (isScenarioActive) runButton.title = 'This story pauses after each step';
    else runButton.removeAttribute('title');
  }
  if (resetButton) {
    resetButton.disabled = liveOpen || liveLaunchInProgress;
    if (liveOpen) resetButton.title = 'A real payment is open; finish it before resetting the example';
    else resetButton.removeAttribute('title');
  }
  if (liveProof) {
    liveProof.classList.toggle('proof-read-only', historicalOnly);
    const freshProofAvailable = !publicAccessBlocked && (liveTerminal || (!liveDemoState && hasLatestProof));
    liveProof.disabled = historicalOnly
      ? false
      : checking || unavailable || liveReady || liveConsumed || (liveNeedsRecovery && !liveResumeAvailable) || (liveRecoverable && !liveResumeAvailable);
    const liveStepTotal = liveDemoState?.stepStates?.length || 5;
    liveProof.textContent = historicalOnly
      ? 'View LIVE proof'
      : checking ? 'Checking LIVE proof…' : unavailable ? 'LIVE proof unavailable' : liveReady ? 'Run LIVE proof' : liveResumeAvailable ? `Resume LIVE proof · ${liveDemoState.transactionCount}/${liveStepTotal}` : liveRecoverable ? 'Finish LIVE proof' : liveNeedsRecovery ? 'Waiting for confirmation…' : liveAwaitingFulfillment ? 'Waiting for delivery confirmation' : freshProofAvailable ? 'Run LIVE proof again' : liveConsumed ? 'LIVE proof already shown' : 'Run LIVE proof';
    liveProof.title = historicalOnly ? `${realBuyerCount} demo buyer wallets paid on Tempo testnet; ${confirmedPaymentCount} confirmed receipts. Opens read-only proof and sends no transaction.` : unavailable && !publicAccessBlocked ? readinessDetail : '';
    // Once a proof exists, the receipt below is the source of truth. Do not
    // leave a second "new payment" action beside the simulated Join button.
    // A saved proof should stay visible below, but it must not remove the
    // explicit action for a fresh LIVE testnet run after the previous run is
    // closed. Only an open/active proof hides this control.
    const proofIsVisible = liveTerminal || liveAwaitingFulfillment || hasLatestProof;
    const proofActionAllowed = !publicAccessBlocked || currentExampleFinished || liveResumeAvailable || liveRecoverable;
    liveProof.hidden = !showLiveProofForExample && !liveResumeAvailable && !liveRecoverable
      ? true
      : publicAccessBlocked || !proofActionAllowed || (!historicalOnly && ((proofIsVisible && !freshProofAvailable) || (!livePaymentsEnabled && !liveResumeAvailable && !liveRecoverable && !freshProofAvailable)));
    liveProof.hidden = true; // Internal execution handle; the single product CTA owns this action.
  }
  const canConfirmFulfillment = liveAwaitingFulfillment;
  const canSlashGuarantee = liveAwaitingFulfillment;
  const showOwnerTools = !publicAccessBlocked && (liveReady || liveRecoverable || canConfirmFulfillment || canSlashGuarantee);
  if (ownerTools) {
    ownerTools.hidden = !showOwnerTools;
    ownerTools.open = showOwnerTools;
  }
  if (ownerActions) ownerActions.hidden = !showOwnerTools;
  $$('.live-owner-status').forEach((status) => {
    status.hidden = publicAccessBlocked;
    status.textContent = checking
      ? 'Checking real payment readiness…'
      : unavailable
      ? 'Order controls unlock after the real payment setup is ready.'
      : liveRecoverable
        ? `The real order ${liveDemoState.liveDealId} needs a refund.`
      : liveAwaitingFulfillment
         ? `The real order ${liveDemoState.liveDealId} is waiting for delivery confirmation. The seller's promise is still protected.`
      : liveReady
         ? `Presenter controls · close, confirm delivery, or refund ${liveDemoState.liveDealId}.`
        : liveTerminal
          ? 'The latest real payment is shown below. A new payment is presenter-only.'
        : 'Show the real payment first; order controls unlock after the buyer and seller payments are confirmed.';
  });
  ownerButtons.forEach((button) => {
    const canRefund = liveReady || liveRecoverable;
    button.hidden = button.id === 'refundDealLive' ? !canRefund
      : button.id === 'confirmDealFulfillmentLive' ? !canConfirmFulfillment
      : button.id === 'slashDealGuaranteeLive' ? !canSlashGuarantee : !liveReady;
    button.disabled = unavailable || (button.id === 'refundDealLive' ? !canRefund
      : button.id === 'confirmDealFulfillmentLive' ? !canConfirmFulfillment
      : button.id === 'slashDealGuaranteeLive' ? !canSlashGuarantee
      : !liveReady);
    if (unavailable) button.title = publicAccessBlocked
      ? 'Available only for the presenter'
      : readinessDetail;
    else if (button.id === 'refundDealLive' && liveRecoverable) button.title = 'Return the buyer money for the open real order';
    else if (button.id === 'settleDealLive' && !liveReady) button.title = 'Show the real payment first';
    else if (button.id === 'confirmDealFulfillmentLive' && !canConfirmFulfillment) button.title = 'Finish the order first; delivery confirmation releases the seller guarantee';
    else if (button.id === 'slashDealGuaranteeLive' && !canSlashGuarantee) button.title = 'The seller guarantee can be used only after payment is confirmed';
    else button.removeAttribute('title');
    if (['settleDealLive', 'confirmDealFulfillmentLive'].includes(button.id)) button.hidden = true;
  });
  const showAuxiliaryControls = BROWSER_WALLET_ACTIONS_ENABLED && liveReadinessKnown && livePaymentsEnabled && !publicAccessBlocked;
  [businessLiveControls, requestLiveControls].forEach((controls) => {
    if (controls) controls.hidden = !showAuxiliaryControls;
  });
  auxiliaryOwnerButtons.forEach((button) => {
    button.disabled = !showAuxiliaryControls || checking;
    if (!showAuxiliaryControls && !publicAccessBlocked) button.title = readinessDetail;
    else button.removeAttribute('title');
  });
  syncDealCommitAction();
}

const walletExecutor = window.WalletActions.createExecutor({
  storage: window.localStorage,
  isCurrent: (epoch) => epoch === viewEpoch,
  connect: async () => {
    if (!BROWSER_WALLET_ACTIONS_ENABLED) throw new Error('Browser wallet payments are disabled in this jury view. Use LIVE proof with the preset demo wallet.');
    if (!window.ethereum || !window.ethers) throw new Error('Connect your own Tempo-compatible wallet to sign this action. No server wallet will act as the buyer.');
    const provider = new ethers.BrowserProvider(window.ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== TEMPO_CHAIN_ID) throw new Error('Switch your wallet to Tempo Moderato (42431)');
    const signer = await provider.getSigner();
    return { signer, address: await signer.getAddress(), chainId: Number(network.chainId), contract: CONTRACT_ADDRESS };
  },
  prepare: async (action, payload) => {
    const res = await fetch('/api/transaction/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Unable to prepare transaction. No funds sent.');
    return data;
  },
  tokenFor: (signer, address) => new ethers.Contract(address, TIP20_ABI, signer),
  proof: async (receipt, prepared, payload) => {
    const logs = receipt.logs.filter((log) => log.address.toLowerCase() === CONTRACT_ADDRESS.toLowerCase());
    if (!logs.length) throw new Error('No escrow event in the receipt');
    // Register verified evidence separately. Failure here never triggers a second chain dispatch.
    fetch('/api/proof', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: receipt.hash, action: prepared.method, payload }) }).catch(() => {});
    return { receipt: { hash: receipt.hash, blockNumber: receipt.blockNumber, from: receipt.from, contract: CONTRACT_ADDRESS },
      requestId: prepared.method === 'createRequest' ? payload.requestId : null };
  },
});

function executeBackgroundTempoAction(actionName, payload = {}) {
  const epoch = viewEpoch;
  return walletExecutor(actionName, payload, epoch).then((result) => {
    if (epoch === viewEpoch && result.success && result.hash) setTestnetLive(result.hash, 'LIVE_TESTNET', actionName);
    return { ...result, stale: epoch !== viewEpoch };
  });
}

async function recoverOwnerAction(actionId, initialResult, status) {
  let result = initialResult;
  if (!['PENDING', 'BROADCASTING', 'RETRYING'].includes(result?.status)) return result;
  if (status) status.textContent = 'Receipt pending · checking read-only status…';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch('/api/actions/' + encodeURIComponent(actionId), { cache: 'no-store' });
    const next = await response.json();
    if (next?.status === 'CONFIRMED' || next?.status === 'FAILED' || next?.success === true) return next;
    result = next;
  }
  return result;
}

async function executeOwnerAction(buttonId, statusId, action, payload, label) {
  const button = $('#' + buttonId);
  const status = $('#' + statusId);
  if (!button || !livePaymentsEnabled) return;
  const isDealOwnerAction = ['settleDeal', 'refundDeal', 'confirmDealFulfillment', 'slashSettledDealGuarantee'].includes(action);
  const previous = button.textContent;
  const marketId = payload.dealId || payload.poolId || payload.requestId;
  const actionId = `owner:${action}:${marketId}`;
  button.disabled = true;
  button.textContent = 'Sending to Tempo...';
  try {
    const response = await fetch('/api/wallet/execute', {
      method: 'POST',
      headers: presenterAccess.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ actionId, action, payload }),
    });
    let result = await response.json();
    if (result?.status === 'PENDING' || response.status === 202) {
      result = await recoverOwnerAction(actionId, result, status);
    }
    if (!response.ok || !result.success) {
      if (status) status.textContent = result.error || 'Owner action was not confirmed.';
      button.disabled = result.status === 'PENDING';
      button.textContent = result.status === 'PENDING' ? 'Receipt pending · do not resend' : previous;
      return result;
    }
    const proofStatus = ['settleDeal', 'settleBusinessPool', 'settleRequest'].includes(action)
      ? 'SETTLED'
      : ['refundDeal', 'slashSettledDealGuarantee', 'refundBusinessPool', 'refundRequest', 'slashSettledBusinessSupplier', 'slashSettledRequestSupplier'].includes(action)
        ? 'REFUNDED'
        : 'COMPLETED';
    const proofForRender = isDealOwnerAction && liveDemoState ? {
      ...liveDemoState,
      status: proofStatus,
      settlementHash: action === 'settleDeal' ? result.hash : liveDemoState.settlementHash,
      fulfillmentHash: action === 'confirmDealFulfillment' ? result.hash : liveDemoState.fulfillmentHash,
      refundHash: action === 'refundDeal' || action === 'slashSettledDealGuarantee' ? result.hash : liveDemoState.refundHash,
    } : null;
    button.textContent = label + ' confirmed';
    const stageMessage = ['settleDeal', 'settleBusinessPool', 'settleRequest'].includes(action)
      ? 'Price locked · buyer refund sent · seller payout waiting for delivery.'
      : ['confirmDealFulfillment', 'confirmBusinessPoolFulfillment', 'confirmRequestFulfillment'].includes(action)
        ? 'Delivery confirmed · seller payout and DealArena fee released.'
        : ['refundDeal', 'slashSettledDealGuarantee', 'refundBusinessPool', 'refundRequest', 'slashSettledBusinessSupplier', 'slashSettledRequestSupplier'].includes(action)
          ? 'Order refunded · buyer money returned; no seller payout was released.'
          : 'Payment confirmed.';
    if (status) status.textContent = stageMessage;
    const receiptSummary = formatSettlementSummary(result.receipt?.settlementSummary || liveDemoState?.settlementSummary, proofStatus);
    if (isDealOwnerAction) {
      setTestnetLive(result.hash, 'LIVE_TESTNET', ['settleDeal', 'settleBusinessPool', 'settleRequest'].includes(action) ? 'Price locked' : ['confirmDealFulfillment', 'confirmBusinessPoolFulfillment', 'confirmRequestFulfillment'].includes(action) ? 'Delivery confirmed' : label, { summary: receiptSummary });
      renderSettlementReceipt(
        result.receipt?.settlementSummary || liveDemoState?.settlementSummary,
        'LIVE_TESTNET',
        payload.dealId,
        action === 'refundDeal' || action === 'slashSettledDealGuarantee'
          ? result.hash
          : action === 'confirmDealFulfillment'
            ? result.hash
            : liveDemoState?.settlementHash || result.hash,
        proofStatus,
        proofForRender,
      );
    }
    if (receiptSummary && status) status.textContent = stageMessage;
    if (isDealOwnerAction && liveDemoState?.liveDealId === payload.dealId) {
      const finalFulfillment = action === 'confirmDealFulfillment';
      const finalFailure = action === 'slashSettledDealGuarantee';
      liveDemoState = { ...liveDemoState,
         status: action === 'settleDeal' ? 'AWAITING_FULFILLMENT' : action === 'refundDeal' || finalFailure ? 'REFUNDED' : finalFulfillment ? 'COMPLETED' : liveDemoState.status,
        fulfillmentConfirmed: finalFulfillment ? true : liveDemoState.fulfillmentConfirmed,
        guaranteeResolved: finalFulfillment || finalFailure ? true : liveDemoState.guaranteeResolved,
        sellerFailed: finalFailure ? true : liveDemoState.sellerFailed,
        lastHash: result.hash,
        settlementHash: action === 'settleDeal' ? result.hash : liveDemoState.settlementHash,
        fulfillmentHash: action === 'confirmDealFulfillment' ? result.hash : liveDemoState.fulfillmentHash,
        refundHash: action === 'refundDeal' ? result.hash : liveDemoState.refundHash,
        settlementSummary: result.receipt?.settlementSummary || liveDemoState.settlementSummary,
      };
      latestLiveProof = liveDemoState;
      userJoinedState.joined = false;
      updateLiveAvailability();
    }
    toast(label + ' confirmed on the test network.');
    return result;
  } catch (error) {
    if (status) status.textContent = error.message;
    button.disabled = false;
    button.textContent = previous;
    toast(error.message);
    return { success: false, status: 'FAILED', error: error.message };
  }
}

function syncLiveRequestIds() {
  const laptop = $('#laptopRequest');
  const crm = $('#crmRequest');
  if (laptop) laptop.dataset.reqId = activeIds.laptopReqId;
  if (crm) crm.dataset.reqId = activeIds.crmReqId;
}

function primaryActionProgressLabel() {
  return liveLaunchStep === 'market' ? 'Playing the market example…'
    : liveLaunchStep === 'delivery' ? 'Confirming delivery · paying seller…'
    : liveLaunchStep === 'settling' ? 'Locking price · returning surplus…'
    : liveLaunchStep === 'payment' ? 'Sending new Tempo payments…'
    : 'Checking the current order…';
}

function syncRealOrderHeading() {
  const status = liveDemoState?.status;
  const busy = liveLaunchInProgress;
  const sending = busy && liveLaunchStep === 'payment' || ['PENDING', 'IN_PROGRESS'].includes(status);
  const waiting = ['SETTLED', 'AWAITING_FULFILLMENT'].includes(status);
  const completed = status === 'COMPLETED';
  const refunded = status === 'REFUNDED';
  const recovery = status === 'PARTIAL_FAILED';
  const panel = $('.primary-order-action');
  if (panel?.dataset) panel.dataset.phase = busy ? liveLaunchStep : 'idle';
  panel?.setAttribute?.('aria-busy', String(busy));
  const state = busy && liveLaunchStep !== 'payment' ? liveLaunchStep === 'market' ? 'MARKET EXAMPLE RUNNING' : 'ACTION IN PROGRESS'
    : sending ? 'PAYMENTS IN PROGRESS' : waiting ? 'AWAITING DEMO DELIVERY'
    : completed ? 'ORDER COMPLETED' : refunded ? 'BUYERS REFUNDED'
    : recovery ? 'ORDER NEEDS RECOVERY' : status === 'READY_TO_SETTLE' ? 'READY TO LOCK PRICE'
    : liveReadinessKnown && livePaymentsEnabled ? 'READY TO START' : 'PAYMENTS NOT READY';
  const title = busy ? primaryActionProgressLabel() : sending ? 'Sending new testnet payments'
    : waiting ? 'Payments confirmed. Delivery is next.'
    : completed ? 'This real testnet order is complete'
    : refunded ? 'Buyer money returned on testnet'
    : recovery ? 'Finish or refund the current order'
    : status === 'READY_TO_SETTLE' ? 'Lock the winning price and return surplus'
    : 'Try the real payment flow';
  const summary = busy && liveLaunchStep === 'market' ? 'The modeled market is playing first. New testnet payments start after this example finishes.'
    : busy && liveLaunchStep === 'checking' ? 'Reading the current order. No new payment is sent during this check.'
    : busy && liveLaunchStep === 'delivery' ? 'Waiting for Tempo confirmation. The payout is not complete until its transaction is confirmed below.'
    : busy && liveLaunchStep === 'settling' ? 'Waiting for the price lock and surplus refund transaction to be confirmed.'
    : sending ? 'Only confirmed transactions appear in the list below. Seller payment has not been released.'
    : waiting ? 'Buyer funds and surplus refund are confirmed below. Confirm demo delivery to release the seller payout and 1% fee.'
    : completed ? 'The confirmed amounts and transactions are below. Start another order to send new payments.'
    : refunded ? 'See the refund transaction below. A new order sends new payments.'
    : recovery ? 'Some steps did not finish. Check the confirmed transactions below before proceeding.'
    : status === 'READY_TO_SETTLE' ? 'Buyer funds are held. Locking the price returns unused money; seller payout waits for delivery.'
    : 'Start a new order with 3 demo wallets: buyer funding, seller competition, price lock and surplus refund. Then confirm demo delivery to pay the seller. Testnet money only.';
  for (const [selector, value] of [['#liveOrderState', state], ['#liveOrderHeading', title], ['#liveOrderSummary', summary]]) {
    const node = $(selector);
    if (node) node.textContent = value;
  }
}

function syncDealCommitAction() {
  syncRealOrderHeading();
  const button = $('#joinDealPage');
  if (!button) return;
  try {
  const selectedScenario = $('#scenario')?.value || 'normal';
  if (selectedScenario !== 'normal') {
    const name = { war: 'Price War', failed: 'Failed Seller', refund: 'Refund' }[selectedScenario] || selectedScenario;
    button.hidden = false;
    button.disabled = liveLaunchInProgress || isScenarioActive;
    button.textContent = isScenarioActive ? 'Playing the market example…' : `Run ${name} example · no payment`;
    button.title = 'Runs only the modeled market. Sends no testnet payment or refund.';
    const heading = $('#liveOrderHeading');
    const summary = $('#liveOrderSummary');
    if (heading) heading.textContent = isScenarioActive ? `${name} example is running` : `${name} market example`;
    if (summary) summary.textContent = 'This scenario changes the modeled market only. It does not send payments; existing real transactions stay separate below.';
    return;
  }
  if (!liveReadinessKnown) {
    button.hidden = false;
    button.disabled = true;
    button.textContent = 'Checking Tempo payments…';
    button.title = 'Reading payment readiness. No payment is sent while this check runs.';
    return;
  }
  const localLiveHost = ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname);
  const canRunLive = liveReadinessKnown && livePaymentsEnabled && (localLiveHost || livePublicDemoEnabled);
  if (canRunLive) {
    const open = liveDemoState && !['COMPLETED', 'REFUNDED'].includes(liveDemoState.status);
    button.hidden = false;
    button.disabled = liveLaunchInProgress || isScenarioActive;
    button.classList.remove('proof-read-only');
    button.textContent = liveLaunchInProgress ? primaryActionProgressLabel()
      : ['SETTLED', 'AWAITING_FULFILLMENT'].includes(liveDemoState?.status) ? 'Confirm demo delivery · pay seller'
      : liveDemoState?.status === 'READY_TO_SETTLE' ? 'Lock price · return surplus'
      : open ? 'Continue the current order' : 'Run demo · Tempo testnet';
    button.title = 'Sends new payments from 3 demo wallets. The 500-buyer market stays simulated.';
    return;
  }
  const data = currentDeal;
  const hasPrice = numericValue(data?.best) > 0;
  const proof = [liveDemoState, latestLiveProof, historicalLiveProof].find((entry) => isConfirmedLiveProof(entry));
  button.hidden = !hasPrice || !proof;

  if (!hasPrice || !proof) {
    button.disabled = true;
    button.textContent = !hasPrice ? 'No open order' : 'View LIVE proof';
    button.title = !hasPrice
      ? 'There is no funded order to view yet.'
      : 'No confirmed LIVE proof is available yet.';
    return;
  }
  // The large market example is read-only. Its CTA must never enter the
  // browser-wallet payment path; real money moves only from the separate,
  // explicit LIVE proof control below.
  button.disabled = false;
  button.textContent = 'View LIVE proof';
  button.title = 'Shows confirmed Tempo receipts only. Sends no transaction.';
  } finally {
    // Both entry points own the same action and share readiness/busy state.
    const toolbarButton = $('#runScenario');
    if (toolbarButton) {
      toolbarButton.hidden = button.hidden;
      toolbarButton.disabled = button.disabled;
      toolbarButton.textContent = button.textContent;
      toolbarButton.title = button.title;
    }
  }
}

function applyDeal(step, stepIndex, totalSteps) {
  // Scenario rendering still uses the Market model (including Market.addCohort);
  // the visible buyer action below is intentionally Tempo-only.
  const previous = currentDeal;
  const previousWinner = Number.isInteger(previous?.winnerIndex) ? previous.winnerIndex : lastDealWinner;
  const data = { ...getDealDefaults(), ...step, isSimulated: true };
  data.cohorts = step.cohorts || getDealDefaults().cohorts || (Number(data.buyers) > 0
    ? [{ id: `${data.dealId || activeIds.dealId}:buyers`, units: Number(data.buyers), priceCents: Market.cents(data.best !== '—' ? data.best : `$${data.depositUnitPrice || 0}`) }]
    : []);
  data.priceTiers = Array.isArray(step.priceTiers) && step.priceTiers.length
    ? step.priceTiers
    : Array.isArray(data.sellerLadder?.tiers) ? data.sellerLadder.tiers : [];
  data.accounting = Market.totals(data.cohorts, Market.winningPrice(data.offers, data.winnerIndex) || 0, data.status);
  currentDeal = data;
  syncSimulatedScaleCopy(data);
  const dbc = $('#dealBuyerCount');
  const cbc = $('#cardBuyerCount');
  const dr = $('#dealRetail');
  const cr = $('#cardRetail');
  const dbo = $('#dealWinningOffer');
  const dbl = $('#dealBestLabel');
  const cbp = $('#cardBestPrice');
  const ds = $('#dealSaving');
  const cs = $('#cardSaving');
  const csl = $('#cardSavingLabel');
  const dst = $('#dealStatus');
  const dt = $('#dealTimer');
  const hds = $('#homeDealStatus');
  const hdt = $('#homeDealTime');

  if (dbc) {
    if (dbc.textContent !== String(data.buyers)) pulseValue(dbc);
    dbc.textContent = data.buyers;
  }
  if (cbc) {
    if (cbc.textContent !== String(data.buyers)) pulseValue(cbc);
    cbc.textContent = data.buyers;
  }
  if (dr) dr.textContent = data.retail;
  if (cr) cr.textContent = data.retail;
  const headlineValue = data.status === 'REFUNDED'
    ? Market.dollars(data.accounting?.refundedCents || 0)
    : data.best;
  if (dbo) {
    if (dbo.textContent !== headlineValue) pulseValue(dbo);
    dbo.textContent = headlineValue;
  }
  if (dbl) dbl.textContent = data.status === 'REFUNDED'
    ? 'Money back'
    : numericValue(data.best) > 0
      ? 'Best price now'
      : 'Price not unlocked';
  if (cbp) {
    if (cbp.textContent !== headlineValue) pulseValue(cbp);
    cbp.textContent = headlineValue;
  }
  if (ds) {
    if (ds.textContent !== data.saving) pulseValue(ds);
    ds.textContent = data.saving;
  }
  if (cs) cs.textContent = data.status === 'REFUNDED' ? 'Money returned' : data.saving.startsWith('You save') ? data.saving.replace('You save ', '') : data.saving;
  if (csl) csl.textContent = data.status === 'REFUNDED' ? 'Buyer funds' : 'You save';
  const joinHint = $('#dealJoinHint');
  if (joinHint) joinHint.textContent = data.status === 'WON'
    ? 'The scale example is complete. Its amounts are modeled, not charged.'
    : data.status === 'REFUNDED'
      ? 'No payment or refund was sent for this scale example.'
      : 'This scale example does not send payments. The real order is separate above.';
  const displayDealStatus = data.status === 'WON' ? 'EXAMPLE COMPLETE' : data.status === 'REFUNDED' ? 'EXAMPLE · NO SALE' : data.status === 'FAILED' ? 'EXAMPLE CLOSED' : 'EXAMPLE MARKET OPEN';
  if (dst) dst.textContent = displayDealStatus;

  const timerText = totalSteps > 1 && stepIndex === totalSteps - 1 ? 'CLOSED' : dealTimerLabel(data);
  if (dt) dt.textContent = timerText;
  if (hds) hds.textContent = displayDealStatus;
  if (hdt) hdt.textContent = timerText === 'CLOSED' ? 'closed' : `${timerText} left`;
  updateHomeDealSurface(data);
  if ($('#dealRuleEnds')) $('#dealRuleEnds').textContent = ['WON', 'REFUNDED'].includes(data.status) ? 'Closed' : timerText;

  const t1 = $('#tier1Price');
  const t2 = $('#tier2Price');
  const t3 = $('#tier3Price');
  const t4 = $('#tier4Price');
  const priceTiers = Array.isArray(data.priceTiers) && data.priceTiers.length ? data.priceTiers : [];
  const displayTiers = priceTiers.length
    ? priceTiers.slice(0, 3)
    : [
        { buyers: 200, price: data.ladder[1] },
        { buyers: 500, price: data.ladder[2] },
        { buyers: 800, price: data.ladder[3] },
      ];
  [['tier2BuyerCount', 'tier2Price'], ['tier3BuyerCount', 'tier3Price'], ['tier4BuyerCount', 'tier4Price']].forEach(([buyerId, priceId], index) => {
    const tier = displayTiers[index] || {};
    const buyerNode = $('#' + buyerId);
    const priceNode = $('#' + priceId);
    if (buyerNode) buyerNode.textContent = tier.buyers || '—';
    if (priceNode) priceNode.textContent = tier.price || '—';
  });
  if (t1) t1.textContent = data.ladder[0];

  const oa = $('#offerA');
  const ob = $('#offerB');
  if (oa) oa.textContent = data.offers[0];
  if (ob) ob.textContent = data.offers[1];

  ['A', 'B', 'C'].forEach((seller, index) => {
    const row = $(`#offerRow${seller}`);
    if (!row) return;
    const isWinner = index === data.winnerIndex;
    const isFailed = data.offers[index] === 'FAILED';
    row.classList.toggle('winner', isWinner);
    row.classList.toggle('failed', isFailed);
    const brandName = { A: 'Seller A (Nova)', B: 'Seller B (Apex)', C: 'Seller C (Vertex)' }[seller];
    const nameEl = $(`#offerName${seller}`);
    if (nameEl) {
      if (isFailed) {
        nameEl.textContent = `${brandName} · Dropped out`;
      } else {
        nameEl.textContent = `${brandName}${isWinner ? (data.status === 'WON' ? ' · Best price' : previousWinner !== data.winnerIndex ? ' · New best price' : ' · Best price') : ''}`;
      }
    }
    const metaEl = $(`#offerMeta${seller}`);
    if (metaEl) metaEl.textContent = isFailed
      ? 'Seller dropped out · money goes back'
    : 'Current offer';
    const nextOffer = data.offers[index];
    const oldOffer = lastOfferValues[seller];
    const oldEl = $(`#offerOld${seller}`);
    const changed = oldOffer && oldOffer !== '—' && nextOffer && oldOffer !== nextOffer && nextOffer !== '—' && nextOffer !== 'FAILED';
    if (oldEl) oldEl.textContent = changed ? oldOffer : '';
    if (changed) {
      row.classList.remove('offer-changed');
      void row.offsetWidth;
      row.classList.add('offer-changed');
    }
    lastOfferValues[seller] = nextOffer;
  });

  const offersPanel = $('.offers-panel');
  if (offersPanel) {
    const rows = ['A', 'B', 'C'].map((seller, index) => ({ row: $(`#offerRow${seller}`), index, value: numericValue(data.offers[index]), winner: index === data.winnerIndex })).filter((entry) => entry.row);
    rows.sort((left, right) => Number(right.winner) - Number(left.winner) || (right.value > 0 ? 0 : 1) - (left.value > 0 ? 0 : 1) || left.value - right.value);
    rows.forEach((entry) => offersPanel.append(entry.row));
  }

  const dwo = $('#dealWinningOffer');
  if ($('#offerC')) $('#offerC').textContent = data.offers[2];
  if (dwo) dwo.textContent = data.status === 'REFUNDED'
    ? headlineValue
    : data.winnerIndex < 0 ? '—' : data.offers[data.winnerIndex];
  const ost = $('#offerStatus');
  const rawOfferStatus = data.offerStatus || '';
  const displayOfferStatus = rawOfferStatus === 'WON' ? 'EXAMPLE RESULT' : rawOfferStatus === 'FAILED' ? 'EXAMPLE · SELLER LEFT' : rawOfferStatus === 'CLOSED' ? 'EXAMPLE CLOSED' : rawOfferStatus === 'COMPETING' ? 'COMPARING' : rawOfferStatus === 'LOCKED' ? 'PRICE LOCKED · DELIVERY PENDING' : rawOfferStatus;
  if (ost) ost.textContent = displayOfferStatus || (data.status === 'WON' ? 'EXAMPLE RESULT' : data.status === 'FAILED' ? 'EXAMPLE · SELLER LEFT' : data.status === 'REFUNDED' ? 'EXAMPLE REFUND' : 'COMPARING');

  syncDealCommitAction();
  if (joinHint) {
    joinHint.hidden = !(numericValue(data.best) > 0);
    joinHint.textContent = data.status === 'WON'
      ? 'This example is complete. The confirmed Tempo proof is shown below.'
      : data.status === 'REFUNDED'
        ? 'This example has no Tempo transaction. The separate LIVE proof belongs to the completed Normal deal.'
        : 'This is the example market. The separate Tempo proof below shows the real payment flow.';
  }

  // All values come from retained commitments, never buyers × the newest offer.
  const accounting = data.accounting;
  const flow = $('#dealMoneyFlow');
  if (flow) {
    flow.hidden = !['WON', 'REFUNDED'].includes(data.status);
    const steps = flow.querySelectorAll('.flow-step');
    if (steps[1]) {
      steps[1].querySelector('span').textContent = 'After price lock';
      steps[1].querySelector('strong').textContent = data.status === 'REFUNDED' ? 'Buyer refund' : 'Seller payout';
    }
    if ($('#flowSourceLabel')) $('#flowSourceLabel').textContent = 'Example commitments';
    if ($('#flowBuyers')) $('#flowBuyers').textContent = Market.dollars(accounting.committedCents);
    if ($('#flowSellerLabel')) $('#flowSellerLabel').textContent = data.status === 'REFUNDED' ? 'Example refund' : 'Example seller payout';
    if ($('#flowSeller')) $('#flowSeller').textContent = Market.dollars(data.status === 'REFUNDED' ? accounting.refundedCents : accounting.payoutCents);
    if ($('#flowFee')) $('#flowFee').textContent = Market.dollars(accounting.feeCents);
    if ($('#flowFeeLabel')) $('#flowFeeLabel').textContent = data.status === 'REFUNDED' ? 'No example fee' : 'Example fee · 1%';
    if ($('#flowRefund')) {
      $('#flowRefund').textContent = Market.dollars(accounting.refundedCents);
      $('#flowRefund').title = accounting.refunds.map((c) => c.units + ' × ' + Market.dollars(c.refundCents / c.units)).join(' + ');
      $('#flowRefund').style.display = data.status === 'REFUNDED' ? 'none' : 'inline-block';
    }
    if ($('#flowRefundLabel')) {
      $('#flowRefundLabel').textContent = 'Buyer refund';
      $('#flowRefundLabel').style.display = data.status === 'REFUNDED' ? 'none' : 'inline-block';
    }
  }
  const crowdGrew = Number(data.buyers || 0) > Number(previous?.buyers || 0);
  updateAvatarCrowd(data.buyers, crowdGrew ? `Buyer ${data.buyers}` : null);
  const progressEvent = dealLiveProgressEvent(data, previous);
  renderSimulatedPaymentActivity(data);
  renderSellerLadder(data);
  updateDealStage(data, stepIndex, totalSteps);
  if (!dealStoryEvents.length && Number(data.buyers || 0) > 0 && (data.activity || data.log)) {
    dealStoryEvents.push(dealStoryEventFor(data, stepIndex));
    renderDealStoryEvents();
  }
  renderDealResult(data);
  updateFundedDemand(data);
  const volume = data.status === 'REFUNDED' ? 0 : accounting.grossCents;
  if ($('#dealBatchVolume')) $('#dealBatchVolume').textContent = Market.dollars(volume);
  if ($('#dealCollectiveSavings')) $('#dealCollectiveSavings').textContent = Market.dollars(data.status === 'REFUNDED' ? 0 : Math.max(0, numericValue(data.retail) * 100 - (Market.winningPrice(data.offers, data.winnerIndex) || 0)) * data.buyers);
  if ($('#vaultPoolAmount')) $('#vaultPoolAmount').textContent = Market.dollars(accounting.escrowCents);

  updateProgress(data.buyers);
  syncSellerPhone(data.buyers, data.retail, data.best, timerText, data.accounting?.committedCents, data.offers);
  updateMarketSummary();

  if (Array.isArray(data.log)) {
    const serverLog = normalizeDealLog(data.log);
    const mergedLog = [...serverLog, ...dealActivityLog];
    const seen = new Set();
    dealActivityLog = mergedLog.filter(([, message]) => {
      const key = formatLogMessage(message);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
  } else if (data.log) {
    rememberDealLog(data.log, `12:${String(1 + stepIndex).padStart(2, '0')}`);
  }
  if (progressEvent) {
    addDealStoryEvent(progressEvent);
    rememberDealLog(progressEvent);
  }
  renderLog(dealActivityLog);
  if (['WON', 'REFUNDED'].includes(data.status)) {
    renderSettlementReceipt({
      committedCents: accounting.committedCents,
      unitPriceCents: accounting.grossCents ? Math.round(accounting.grossCents / Math.max(1, accounting.buyers || data.buyers || 1)) : null,
      grossOrderCents: accounting.grossCents || 0,
      finalPriceCents: accounting.grossCents ? Math.round(accounting.grossCents / Math.max(1, accounting.buyers || data.buyers || 1)) : null,
      sellerPayoutCents: data.status === 'WON' ? accounting.payoutCents : 0,
      feeCents: accounting.feeCents,
      buyerRefundCents: accounting.refundedCents,
    }, 'SIMULATED', data.dealId || activeIds.dealId, null, data.status);
  } else {
    renderSettlementReceipt(null);
  }
  updateLiveMoneyFlow();
  lastDealWinner = Number.isInteger(data.winnerIndex) ? data.winnerIndex : -1;
}

function showView(view, { scroll = true } = {}) {
  // Result messages belong to the action that created them; clear them when
  // the user navigates so another page never inherits stale status text.
  clearTimeout(toastTimer);
  const toastElement = $('#toast');
  if (toastElement) {
    toastElement.classList.remove('show');
    toastElement.textContent = '';
  }
  document.body.classList.toggle('viewing-other', view !== 'home');
  document.body.classList.toggle('viewing-secondary', ['business', 'request', 'sell'].includes(view));
  $$('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === view || (view === 'deal' && link.dataset.view === 'home')));
  $$('.view-section').forEach((section) => section.classList.toggle('active-view', section.dataset.section === view));
  // A target navigation owns its scroll. Never schedule later top resets
  // that pull the user away from the result they just asked to see.
  if (scroll) window.scrollTo({ top: 0, behavior: 'auto' });
}

function revealActionResult(selector) {
  const target = $(selector);
  if (!target || target.hidden) return;
  target.scrollIntoView({ behavior: 'auto', block: 'start' });
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  target.classList.add('action-result-focus');
  setTimeout(() => target.classList.remove('action-result-focus'), 1400);
}

function openTempoEvidence() {
  showView('deal', { scroll: false });
  window.location.hash = 'deal';
  // Let native hash navigation finish, then position once at the promised
  // evidence. If none exists, show the explicit action instead of a no-op.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const receipt = $('#settlementReceipt');
    revealActionResult(receipt && !receipt.hidden && receipt.classList.contains('is-live-proof')
      ? '#receiptTransactionList' : '.primary-order-action');
  }));
}

function clearScenarioTimers() {
  timers.forEach(clearTimeout);
  timers = [];
}

// Market scale remains modeled. The primary normal-order control explicitly
// starts the bounded testnet payment after these market milestones.
async function runScenarioFromServer(name) {
  if (resetInProgress) await resetInProgress;
  const epoch = ++viewEpoch;
  // The jury preview is also served over plain HTTP. randomUUID() is only
  // guaranteed in a secure context, so keep the scenario control functional
  // on the public VPS as well as on localhost.
  const runId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const stopScenario = (reason) => {
    const note = $('#demoBlockedNote');
    if (note) {
      note.hidden = false;
      note.textContent = `Example stopped: ${reason}`;
    }
    isScenarioActive = false;
    updateLiveAvailability();
  };
  const previousBlockedNote = $('#demoBlockedNote');
  if (previousBlockedNote) {
    previousBlockedNote.hidden = true;
    previousBlockedNote.textContent = '';
  }
  userHasRunScenario = true;
  clearUserJoinedState();
  simulatedBusinessJoin = null;
  lastTxHash = null;
  clearScenarioTimers();
  dealStoryEvents = [];
  dealActivityLog = [];
  lastOfferValues = { A: null, B: null, C: null };
  lastDealWinner = -1;
  renderDealStoryEvents();
  isScenarioActive = true;
  setSimulatedMode();
  if (name === 'normal' || name === 'war') {
    const activityDetails = $('.activity-details');
    if (activityDetails) {
      activityDetails.open = true;
      activityDetails.classList.add('is-live');
    }
  }
  try {
    if (!canonicalServerState || !serverScenarios) await syncServerState();
    else {
      // A local server restart rotates the generation. Refresh the cheap
      // preview snapshot before the first step so an open jury tab never
      // fails with a stale-generation error.
      const freshResponse = await fetch('/api/state', { cache: 'no-store' });
      if (freshResponse.ok) {
        const fresh = await freshResponse.json();
        if (fresh.state) {
          canonicalServerState = fresh.state;
          liveDemoState = fresh.state.liveDemo || null;
          latestLiveProof = fresh.state.latestLiveProof || latestLiveProof;
          historicalLiveProof = fresh.state.historicalLiveProof || historicalLiveProof;
          liveProofUsed = fresh.state.liveProofUsed === true;
          if (fresh.activeIds) activeIds = { ...activeIds, ...fresh.activeIds };
          syncLiveRequestIds();
          serverScenarios = fresh.scenarios || serverScenarios;
        }
      }
    }
    if (epoch !== viewEpoch) { stopScenario('another reset or action cancelled this run'); return; }
    if (!canonicalServerState?.generation) throw new Error('Connect to the local server before running a scenario');
    const steps = serverScenarios?.[name] || [];
    if (!steps.length) throw new Error('Scenario unavailable');
    const activity = [];
    updateScenarioGuide(name, 0, steps.length, true);
    for (let index = 0; index < steps.length; index++) {
      if (index) await new Promise((resolve) => setTimeout(resolve, name === 'war' ? 1600 : 1200));
      if (epoch !== viewEpoch) { stopScenario('another reset or action cancelled this run'); return; }
      const res = await fetch('/api/scenario/step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: name, stepIndex: index, runId, generation: canonicalServerState.generation }),
      });
      const data = await res.json();
      if (epoch !== viewEpoch) { stopScenario('another reset or action cancelled this run'); return; }
      if (!res.ok || !data.success || data.runId !== runId) throw new Error(data.error || 'Scenario response rejected');
      activeIds = { ...activeIds, ...data.activeIds };
      canonicalServerState = { ...canonicalServerState, deal: data.deal, business: data.business, requests: data.requests };
      const step = data.stepData;
      if (name === 'business') {
        businessStatus = step.status;
        const count = step.count ?? step.buyers;
        for (const id of ['businessBuyerCount', 'homeBusinessCount']) if ($('#' + id)) $('#' + id).textContent = count;
        for (const id of ['businessDemand', 'businessDemandSummary', 'homeBusinessDemand']) if ($('#' + id)) $('#' + id).textContent = step.demand;
        for (const id of ['businessOffer', 'homeBusinessOffer', 'coffeeDemandBest']) if ($('#' + id)) $('#' + id).textContent = step.bestOffer;
        if ($('#businessStage')) $('#businessStage').textContent = step.stage;
        if ($('#bizOfferStatus')) $('#bizOfferStatus').textContent = displayBusinessStatus(step.status);
        if ($('#joinBusinessPool')) {
          $('#joinBusinessPool').disabled = BROWSER_WALLET_ACTIONS_ENABLED && Market.terminal(step.status);
          $('#joinBusinessPool').textContent = BROWSER_WALLET_ACTIONS_ENABLED && Market.terminal(step.status) ? 'Order complete' : readOnlyFlowLabel('payment');
        }
        if ($('#homeBusinessTime')) $('#homeBusinessTime').textContent = data.isFinished ? 'closed' : 'time left';
        if ($('#coffeeDemandMeta')) $('#coffeeDemandMeta').textContent = count + ' cafés · ' + step.demand + ' / month · ' + (data.isFinished ? 'Order complete' : 'Prices changing');
        syncBusinessSuppliers(step.offerA, step.offerB, step.offerC, step.winnerId);
        syncBusinessProgress(count);
        updateBusinessEconomics({ ...step, buyers: count, offer: step.bestOffer });
        renderSecondaryPaymentLedger('businessPaymentLedger', step.paymentLedger, {
          countId: 'businessPaymentCount', amountId: 'businessMoneyLocked', statusId: 'businessPaymentStatus', noteId: 'businessPaymentNote'
        });
        addMiniLog('businessLog', 'Example demand · ' + (step.activity || step.log));
      } else if (name === 'request') {
        requestStatus = step.status;
        const price = step.bestPrice || step.price;
        for (const id of ['openRequestBestPrice', 'homeRequestBestPrice', 'laptopDemandBest']) if ($('#' + id)) $('#' + id).textContent = price;
        for (const id of ['openRequestBuyers', 'homeRequestBuyers']) if ($('#' + id)) $('#' + id).textContent = step.buyers;
        if ($('#openRequestOfferCount')) $('#openRequestOfferCount').textContent = step.offers;
        if ($('#laptopDemandMeta')) $('#laptopDemandMeta').textContent = step.meta;
        if ($('#homeRequestTime')) $('#homeRequestTime').textContent = data.isFinished ? 'closed' : 'time left';
        renderSecondaryPaymentLedger('requestPaymentLedger', step.paymentLedger, {
          countId: 'requestPaymentCount', amountId: 'requestMoneyLocked', statusId: 'requestPaymentStatus', noteId: 'requestPaymentNote'
        });
        addMiniLog('requestLog', 'Example demand · ' + (step.activity || step.log));
      } else {
        const eventText = step.activity || step.log;
        activity.unshift([getFormattedTime(), eventText]);
        const previousDeal = currentDeal;
        if (index > 0 && previousDeal) {
          // The server step is the source of truth. Keep a short readable
          // pause between milestones, but never block the scenario on a
          // decorative timer animation; a stalled animation used to leave
          // the jury view at RUNNING · 2/4 forever.
          await new Promise((resolve) => setTimeout(resolve, name === 'war' ? 900 : 650));
        }
        applyDeal({ ...step, log: activity.slice(0, 8) }, index, steps.length);
        const storyEvent = dealStoryEventFor(step, index);
        addDealStoryEvent(storyEvent);
        if (step.status === 'WON' && Number(step.accounting?.refundedCents || 0) > 0) {
          const returned = `Lower price unlocked → ${Market.dollars(step.accounting.refundedCents)} returned to buyers`;
          addDealStoryEvent(returned);
        }
      }
      updateScenarioGuide(name, index, steps.length);
      updateMarketSummary();
    }
    return true;
  } catch (err) {
    if (epoch === viewEpoch) {
      const message = String(err?.message || 'The example could not finish');
      const blockedNote = $('#demoBlockedNote');
      if (blockedNote) {
        blockedNote.hidden = false;
        blockedNote.textContent = `Example stopped: ${message}`;
      }
      toast(message);
    }
    return false;
  } finally {
    if (epoch === viewEpoch) {
      isScenarioActive = false;
      updateLiveAvailability();
    }
  }
}

async function resetDemo({ retryOnStale = true } = {}) {
  const epoch = ++viewEpoch;
  const blockedNote = $('#demoBlockedNote');
  if (blockedNote) {
    blockedNote.hidden = true;
    blockedNote.textContent = '';
  }
  userHasRunScenario = false;
  clearTimeout(toastTimer);
  const toastElement = $('#toast');
  if (toastElement) {
    toastElement.classList.remove('show');
    toastElement.textContent = '';
  }
  clearScenarioTimers();
  resetDealStory();
  dealActivityLog = [];
  isScenarioActive = false;
  const activityDetails = $('.activity-details');
  if (activityDetails) {
    activityDetails.open = false;
    activityDetails.classList.remove('is-live');
  }
  const scenarioSelect = $('#scenario');
  if (scenarioSelect) scenarioSelect.value = 'normal';
  addedRequestBuyers = 0;
  addedRequestDemand = 0;
  lastTxHash = null;
  clearUserJoinedState();
  resetScenarioGuide();
  simulatedBusinessJoin = null;
  $$('.custom-request').forEach((row) => row.remove());
  $$('.custom-demand-item').forEach((item) => item.remove());

  // Rotate unique IDs on server first so subsequent runs never collide with old on-chain state
  try {
    if (!canonicalServerState?.generation) await syncServerState();
    if (epoch !== viewEpoch) return;
    const res = await fetch('/api/scenario/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: canonicalServerState?.generation }) });
    if (epoch !== viewEpoch) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Reset was rejected; reconnect and retry');
    if (res.ok) {
      if (epoch !== viewEpoch) return;
      if (data.state) canonicalServerState = data.state;
      liveDemoState = data.state?.liveDemo || null;
      latestLiveProof = data.state?.latestLiveProof || null;
      historicalLiveProof = data.state?.historicalLiveProof || historicalLiveProof;
      liveProofUsed = data.state?.liveProofUsed === true;
      liveReceiptAvailable = false;
      if (data.activeIds) activeIds = { ...activeIds, ...data.activeIds };
      syncLiveRequestIds();
      if (data.scenarios) serverScenarios = data.scenarios;
    }
  } catch (err) {
    if (retryOnStale && epoch === viewEpoch && /stale .*generation/i.test(String(err.message || ''))) {
      const refreshed = await syncServerState();
      if (refreshed && epoch === viewEpoch) return resetDemo({ retryOnStale: false });
    }
    if (epoch === viewEpoch) toast(err.message || 'Reset requires the local server');
    return false;
  }
  const requestDefaults = (id) => canonicalServerState?.requests?.find((entry) => entry.id === id) || {};
  const laptopDefaults = requestDefaults(activeIds.laptopReqId);
  const crmDefaults = requestDefaults(activeIds.crmReqId);
  const dealDefaults = canonicalServerState?.deal || {};
  const resetBusiness = canonicalServerState?.business || {};
  businessStatus = resetBusiness.status || 'COMPETING';
  requestStatus = laptopDefaults.status || 'OPEN';
  if ($('#liveProof')) $('#liveProof').hidden = true;
  resetAvatarCrowd();

  const sc = $('#scenario');
  if (sc) sc.value = 'normal';

  const bizDefault = (canonicalServerState && canonicalServerState.business) || { buyers: 0, demand: '—', offer: '—', stage: '—', log: [] };

  const bbc = $('#businessBuyerCount');
  const bd = $('#businessDemand');
  const bds = $('#businessDemandSummary');
  const bsc = $('#businessSuppliersCount');
  const bo = $('#businessOffer');
  const hbc = $('#homeBusinessCount');
  const hbd = $('#homeBusinessDemand');
  const hbo = $('#homeBusinessOffer');
  const bs = $('#businessStage');
  if (bbc) bbc.textContent = String(bizDefault.buyers ?? 0);
  if (bd) bd.textContent = bizDefault.demand || '—';
  if (bds) bds.textContent = bizDefault.demand || '—';
  if (bsc) bsc.textContent = String(Object.keys(canonicalServerState?.suppliers || {}).length || 0);
  if (bo) bo.textContent = bizDefault.offer || '—';
  if (hbc) hbc.textContent = String(bizDefault.buyers ?? 0);
  if (hbd) hbd.textContent = bizDefault.demand || '—';
  if (hbo) hbo.textContent = bizDefault.offer || '—';
  if (bs) bs.textContent = bizDefault.stage || '—';
  syncBusinessProgress(Number(bizDefault.buyers) || 0);
  syncBusinessSuppliers(bizDefault.offerA || '—', bizDefault.offerB || '—', bizDefault.offerC || bizDefault.offer || '—', bizDefault.winnerId || 'C');
  updateBusinessEconomics(bizDefault);
  renderMiniLog('businessLog', bizDefault.log || []);

  const robp = $('#openRequestBestPrice');
  const rooc = $('#openRequestOfferCount');
  const orb = $('#openRequestBuyers');
  const hrb = $('#homeRequestBuyers');
  const hrbp = $('#homeRequestBestPrice');
  const crmBuyers = $('#crmRequestBuyers');
  const crmOffers = $('#crmRequestOfferCount');
  const crmBest = $('#crmRequestBestPrice');
  if (robp) robp.textContent = laptopDefaults.bestPrice || '—';
  if (rooc) rooc.textContent = String(laptopDefaults.offers ?? 0);
  if (orb) orb.textContent = String(laptopDefaults.buyers ?? 0);
  if (hrb) hrb.textContent = String(laptopDefaults.buyers ?? 0);
  if (hrbp) hrbp.textContent = laptopDefaults.bestPrice || '—';
  if (crmBuyers) crmBuyers.textContent = String(crmDefaults.buyers ?? 0);
  if (crmOffers) crmOffers.textContent = String(crmDefaults.offers ?? 0);
  if (crmBest) crmBest.textContent = crmDefaults.bestPrice || '—';

  // A completed example is useful as proof, but it is not a live seller
  // destination. Keep it visible in the list and move the action form to the
  // first open group so the seller never starts from a dead action.
  const phoneDemand = $('.demand-item[data-title="Phone group order"]');
  const phoneIsClosed = Market.terminal(dealDefaults.status);
  if (phoneDemand) {
    phoneDemand.dataset.closed = String(phoneIsClosed);
    phoneDemand.disabled = phoneIsClosed;
    phoneDemand.setAttribute('aria-disabled', String(phoneIsClosed));
    phoneDemand.title = phoneIsClosed
      ? 'This example is complete. Choose an open group to publish an offer.'
      : 'Choose this group to publish a seller offer.';
  }
  const selectableDemand = $$('.demand-item').find((item) => item.dataset.closed !== 'true' && !item.disabled)
    || $$('.demand-item').find((item) => item.dataset.closed !== 'true');
  $$('.demand-item').forEach((item) => {
    const selected = item === selectableDemand;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  });

  const op = $('#offerProduct');
  const ovl = $('#offerValueLabel');
  const off = $('#offerForm');
  const gs = $('#guaranteeStatus');
  const selectedTitle = selectableDemand?.dataset.title || 'No open group available';
  if (op) op.textContent = selectedTitle;
  if (ovl) ovl.textContent = selectedTitle === 'Coffee supplies' ? 'Your discount' : 'Your price per item';
  if (off) {
    const isDeal = selectedTitle === 'Phone group order';
    off.elements.offerPrice.value = isDeal ? '$680' : selectedTitle === 'Coffee supplies' ? '−24%' : laptopDefaults.bestPrice || '$520';
    off.elements.minimumBuyerCount.value = 200;
    off.elements.maxBuyerUnits.value = isDeal ? 800 : 300;
    off.elements.delivery.value = '7 days';
    off.elements.expiry.value = '24 hours';
    off.elements.ladderPrice1.value = '$680';
    off.elements.ladderThreshold1.value = 200;
    off.elements.ladderPrice2.value = '$590';
    off.elements.ladderThreshold2.value = 500;
    off.elements.ladderPrice3.value = '$550';
    off.elements.ladderThreshold3.value = 800;
    off.elements.guarantee.value = isDeal ? '$55' : '$10';
  }
  if (gs) gs.textContent = selectableDemand
    ? 'Your guarantee is sent to Tempo and held until delivery.'
    : 'There are no open groups ready for a new offer.';
  if (selectableDemand) syncSellerOfferForm(selectedTitle, suggestNextBetterOffer(selectedTitle, selectableDemand.dataset.price));
  renderSellerGuarantee(selectableDemand?.dataset.title === 'Phone group order' ? 5500 : 1000);

  const coffeeDemand = $('.demand-item[data-title="Coffee supplies"]');
  if (coffeeDemand) {
    coffeeDemand.dataset.price = '−24%';
    const cdb = $('#coffeeDemandBest');
    if (cdb) cdb.textContent = '−24%';
  }
  const laptopDemand = $('.demand-item[data-title="Laptop under $700"]');
  if (laptopDemand) {
    laptopDemand.dataset.price = laptopDefaults.bestPrice || '—';
    const ldb = $('#laptopDemandBest');
    if (ldb) ldb.textContent = laptopDefaults.bestPrice || '—';
  }
  renderMiniLog('requestLog', canonicalServerState?.requestLog || []);
  syncRequestActionCopy();

  const jbp = $('#joinBusinessPool');
  if (jbp) {
    jbp.disabled = false;
    jbp.textContent = readOnlyFlowLabel('payment');
  }
  const jdp = $('#joinDealPage');
  if (jdp) {
    jdp.disabled = true;
    jdp.classList.remove('joined');
    jdp.textContent = 'Checking Tempo payment…';
  }
  syncDealCommitAction();

  const dgc = $('#demandGroupCount');
  if (dgc) dgc.textContent = `${$$('.demand-item').length} groups`;
  const pdb = $('#phoneDemandBest');
  if (pdb) pdb.textContent = dealDefaults.best || '—';
  const pdm = $('#phoneDemandMeta');
  if (pdm && dealDefaults.buyers !== undefined) pdm.textContent = `${dealDefaults.buyers} people · $${Math.round((numericValue(dealDefaults.retail) * Number(dealDefaults.buyers || 0)) / 1000)}k · ${dealTimerLabel(dealDefaults)} left`;
  const cdm = $('#coffeeDemandMeta');
  if (cdm && resetBusiness.buyers !== undefined) cdm.textContent = `${resetBusiness.buyers} cafés · ${resetBusiness.demand || '—'} / month · ${resetBusiness.timer || '—'} left`;
  const ldm = $('#laptopDemandMeta');
  if (ldm) ldm.textContent = laptopDefaults.meta || `${laptopDefaults.buyers ?? 0} people · ${laptopDefaults.bestPrice || '—'}`;

  dealTimeSeconds = DEAL_DEADLINE_SECONDS;
  coffeeTimeSeconds = 166;
  laptopTimeSeconds = 499;
  lastUnlockedTierIndex = 0;
  lastHomeWinnerIndex = -1;
  lastHomeOfferValues = [];
  if ($('#homeDealStatus')) $('#homeDealStatus').textContent = dealDefaults.status || 'OPEN';
  if ($('#homeDealTime')) $('#homeDealTime').textContent = `${dealTimerLabel(dealDefaults)} left`;
  if ($('#homeBusinessTime')) $('#homeBusinessTime').textContent = `${resetBusiness.timer || '—'} left`;
  if ($('#homeRequestTime')) $('#homeRequestTime').textContent = `${laptopDefaults.time || '—'} left`;

  applyDeal(getDealDefaults(), 0, 1);
  const dst = $('#dealStatus');
  const dt = $('#dealTimer');
  if (dst) dst.textContent = dealDefaults.status || 'OPEN';
  if (dt) dt.textContent = dealTimerLabel(dealDefaults);

  const bos = $('#bizOfferStatus');
  if (bos) bos.textContent = displayBusinessStatus(businessStatus);

  updateMarketPulse();
  updateLiveAvailability();
  setSimulatedMode();
  document.body.dataset.scenario = '';
  const currentView = 'home';
  window.location.hash = 'home';
  if (['home', 'deal', 'business', 'request', 'sell'].includes(currentView)) {
    showView(currentView, { scroll: false });
  } else {
    showView('home', { scroll: false });
  }
  return true;
}

$('#scenario')?.addEventListener('change', (event) => {
  updateScenarioPurpose(event.target.value);
  updateLiveAvailability();
});
const initialScenarioSelect = $('#scenario');
if (initialScenarioSelect) initialScenarioSelect.value = 'normal';
updateScenarioPurpose('normal');

async function runSelectedDealAction() {
  if (liveLaunchInProgress || isScenarioActive) return;
  const key = $('#scenario')?.value || 'normal';
  if (key === 'normal') {
    return await performPrimaryDealAction({ showMarket: true });
  }
  const destination = key === 'business' ? 'business' : key === 'request' ? 'request' : 'deal';
  showView(destination);
  window.location.hash = destination;
  return await runScenarioFromServer(key);
}

$('#resetScenario')?.addEventListener('click', () => {
  resetInProgress = resetDemo().finally(() => { resetInProgress = null; });
});

$$('[data-view]').forEach((link) =>
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const view = link.dataset.view;
    const scrollTarget = link.dataset.scrollTarget;
    showView(view, { scroll: !scrollTarget });
    window.location.hash = scrollTarget || view;
    if (scrollTarget) window.setTimeout(() => $('#' + scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    $('.site-header')?.classList.remove('mobile-open');
    $('.menu-button')?.setAttribute('aria-expanded', 'false');
  })
);

$('.wordmark')?.addEventListener('click', (event) => {
  event.preventDefault();
  showView('home');
  window.location.hash = 'home';
});

$('#homeTempoLink')?.addEventListener('click', (event) => {
  event.preventDefault();
  openTempoEvidence();
});

window.addEventListener('hashchange', () => {
  const rawHash = window.location.hash.slice(1) || 'home';
  const view = rawHash.split('?')[0] || 'home';
  $('.site-header')?.classList.remove('mobile-open');
  $('.menu-button')?.setAttribute('aria-expanded', 'false');
  if (view === 'deals') {
    showView('home', { scroll: false });
    window.setTimeout(() => $('#deals')?.scrollIntoView({ behavior: 'auto', block: 'start' }), 0);
  } else if (['home', 'deal', 'business', 'request', 'sell'].includes(view)) {
    showView(view, { scroll: false });
  }
  if (rawHash.includes('join=live') || rawHash.includes('join=1')) showView('deal', { scroll: false });
});

$('.menu-button')?.addEventListener('click', () => {
  const header = $('.site-header');
  if (!header) return;
  const open = header.classList.toggle('mobile-open');
  $('.menu-button')?.setAttribute('aria-expanded', String(open));
});

$$('[data-view-deal]').forEach((button) =>
  button.addEventListener('click', () => {
    const title = button.dataset.viewDeal;
    const view = title === 'Office coffee supply' ? 'business' : title === 'Laptop under $700' ? 'request' : 'deal';
    showView(view);
    window.location.hash = view;
  })
);

// Confirmed live actions remain separate from simulated market quantities.
async function joinWithWallet(buttonId, action, payload) {
  const button = $('#' + buttonId);
  const epoch = viewEpoch;
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending from your wallet…';
  const result = await executeBackgroundTempoAction(action, payload);
  if (epoch !== viewEpoch || result.stale) return;
  if (!result.success) {
    button.disabled = result.status === 'PENDING';
    button.textContent = result.status === 'PENDING' ? 'Receipt pending · Check wallet' : previous;
    toast(result.error || 'The payment was not confirmed.');
    return;
  }
  button.textContent = action === 'joinBusinessPool' ? 'Business payment confirmed' : 'Buyer payment confirmed';
  if (action === 'joinDeal') userJoinedState = { dealId: payload.dealId, joined: true, committedPrice: payload.unitPriceCents / 100, txHash: result.hash, isOnChain: true };
  toast(action === 'joinBusinessPool'
    ? 'Business payment confirmed on Tempo. Supplier payout stays held until completion.'
    : 'Buyer payment confirmed on Tempo. Seller payout stays held until delivery.');
}
async function runLiveMiniDeal({ silent = false } = {}) {
  const button = $('#liveDealProof');
  let epoch = viewEpoch;
  const needsFreshRun = ['SETTLED', 'AWAITING_FULFILLMENT', 'COMPLETED', 'REFUNDED'].includes(liveDemoState?.status)
    || (!liveDemoState && latestLiveProof?.settlementSummary);
  if (needsFreshRun) {
    if (!button) return { success: false, error: 'The real payment button is unavailable.' };
    button.disabled = true;
    button.textContent = 'Preparing a new payment…';
    const reset = await resetDemo();
    if (reset !== true) {
      button.disabled = false;
      button.textContent = 'Show a new real payment';
      return { success: false, error: 'A new real proof could not be prepared.' };
    }
    // resetDemo returns the preview to Home. A fresh LIVE proof was started
    // from the Deal page, so keep the presenter on the proof surface while
    // the explicit testnet action continues.
    showView('deal', { scroll: false });
    window.location.hash = 'deal';
    epoch = viewEpoch;
  }
  const simulationDealId = activeIds.dealId;
  const resumable = liveDemoState?.simulationDealId === simulationDealId && ['PENDING', 'IN_PROGRESS'].includes(liveDemoState.status);
  if (!button || !livePaymentsEnabled || (!resumable && (liveProofUsed || liveDemoState?.simulationDealId === simulationDealId))) return { success: false, error: 'The real proof was already used or is not available.' };
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = 'Running LIVE proof…';
  try {
    const response = await fetch('/api/demo/mini-deal', {
      method: 'POST',
      headers: presenterAccess.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ simulationDealId, autoSettle: true }),
    });
    const result = await response.json();
    if (epoch !== viewEpoch) return { ...result, stale: true };
    if (!response.ok || !result.success) {
      if (result.liveDemo) {
      liveDemoState = result.liveDemo;
        latestLiveProof = result.latestLiveProof || latestLiveProof;
        liveProofUsed = true;
        liveReceiptAvailable = false;
        updateLiveAvailability();
      }
      button.disabled = Boolean(result.liveDemo?.buyersCount);
      button.textContent = result.liveDemo?.buyersCount ? 'Needs to finish' : previous;
    if (!silent) toast(result.error || 'The real proof could not be completed.');
      return result;
    }
    liveDemoState = result.demo;
    latestLiveProof = result.latestLiveProof || latestLiveProof;
    liveProofUsed = true;
    liveReceiptAvailable = false;
    button.textContent = 'LIVE proof complete';
    setTestnetLive(result.hash, 'LIVE_TESTNET', 'Preset buyer + sellers', { receipts: result.receipts });
    const liveEvents = (result.receipts || []).map((receipt) => receipt.eventLogMessage).filter(Boolean);
    liveEvents.forEach((message) => addMiniLog('dealLog', 'Real payment · ' + message));
    updateLiveAvailability();
    if (!silent) toast(`Price locked on Tempo: buyer surplus was returned; seller payout is held until delivery on ${result.demo?.liveDealId}.`);
    return result;
  } catch (error) {
    button.disabled = false;
    button.textContent = previous;
    if (!silent) toast(error.message);
    return { success: false, status: 'FAILED', error: error.message };
  }
}
async function performPrimaryDealAction({ showMarket = false } = {}) {
  if (liveLaunchInProgress || isScenarioActive) return;
  liveLaunchInProgress = true;
  liveLaunchStep = 'checking';
  updateLiveAvailability();
  try {
    await syncServerState();
    const local = ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname);
    if (!livePaymentsEnabled || (!local && !livePublicDemoEnabled)) throw new Error('Tempo testnet payment is unavailable. No new payment was sent.');
    if (['SETTLED', 'AWAITING_FULFILLMENT'].includes(liveDemoState?.status)) {
      liveLaunchStep = 'delivery';
      updateLiveAvailability();
      return await executeOwnerAction('confirmDealFulfillmentLive', 'dealLiveActionStatus', 'confirmDealFulfillment', { dealId: liveDemoState.liveDealId }, 'Demo delivery and seller payment');
    }
    if (liveDemoState?.status === 'READY_TO_SETTLE') {
      liveLaunchStep = 'settling';
      updateLiveAvailability();
      return await executeOwnerAction('settleDealLive', 'dealLiveActionStatus', 'settleDeal', { dealId: liveDemoState.liveDealId }, 'Price lock and surplus refund');
    }
    const resumable = ['PENDING', 'IN_PROGRESS'].includes(liveDemoState?.status);
    if (!resumable && liveDemoState && !['COMPLETED', 'REFUNDED'].includes(liveDemoState.status)) {
      $('#liveOwnerTools')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      throw new Error('Finish or refund the current real order before starting another.');
    }
    if (!resumable && (liveDemoState || liveProofUsed)) {
      if (await resetDemo() !== true) throw new Error('Could not prepare a new order. No new payment was sent.');
    }
    showView('deal', { scroll: false });
    window.location.hash = 'deal';
    updateLiveAvailability();
    if (showMarket && !resumable) {
      liveLaunchStep = 'market';
      updateLiveAvailability();
      if (await runScenarioFromServer('normal') !== true) return;
    }
    liveLaunchStep = 'payment';
    updateLiveAvailability();
    const result = await runLiveMiniDeal();
    if (!result?.success) throw new Error(result?.error || 'Payment is not confirmed. Check the current order status.');
    $('#settlementReceipt')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return result;
  } catch (error) {
    const note = $('#demoBlockedNote');
    if (note) { note.hidden = false; note.textContent = error.message; }
    toast(error.message);
    return { success: false, error: error.message };
  } finally {
    liveLaunchInProgress = false;
    liveLaunchStep = 'idle';
    updateLiveAvailability();
  }
}
$('#joinDealPage')?.addEventListener('click', () => {
  void runSelectedDealAction();
});
$('#runScenario')?.addEventListener('click', () => {
  void runSelectedDealAction();
});
$$('.share-deal-button').forEach((button) => button.addEventListener('click', shareCurrentDeal));
$('#liveDealProof')?.addEventListener('click', () => {
  if (historicalLiveProof && !latestLiveProof && !liveDemoState) {
    $('#settlementReceipt')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  void performPrimaryDealAction();
});
$('#joinBusinessPool')?.addEventListener('click', async () => {
  if (!BROWSER_WALLET_ACTIONS_ENABLED) {
    openTempoEvidence();
    return;
  }
  if (Market.terminal(businessStatus)) return;
  if (!await ensureTempoWalletForPayment()) return;
  void joinWithWallet('joinBusinessPool', 'joinBusinessPool', {
    poolId: activeIds.poolId,
    commitmentCents: CAFE_MONTHLY_COMMITMENT_CENTS,
  });
});

function requestRecordForSelection() {
  const requestId = selectedRequestId === 'crm' ? activeIds.crmReqId : activeIds.laptopReqId;
  return canonicalServerState?.requests?.find((entry) => entry.id === requestId) || {};
}
function syncRequestActionCopy() {
  const record = requestRecordForSelection();
  const join = $('#joinRequestButton');
  const fund = $('#fundRequestButton');
  const hint = $('#requestActionHint');
  if (!join) return;
  const maximum = numericValue(record.maxPrice || (selectedRequestId === 'crm' ? '$30' : '$700'));
  const bestPrice = numericValue(record.bestPrice || record.maxPrice || maximum);
  const joined = requestJoinState[selectedRequestId];
  join.dataset.requestId = record.id || (selectedRequestId === 'crm' ? activeIds.crmReqId : activeIds.laptopReqId);
  join.dataset.amountCents = String(Math.round(maximum * 100));
  const localHost = ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname);
  const paymentReady = connectedWalletReady() && (localHost || livePublicDemoEnabled);
  const canConnect = walletCanConnect() && !connectedWalletPresent;
  const canSwitch = walletCanConnect() && connectedWalletPresent && !connectedWalletOnTempo;
  const proofOnly = !BROWSER_WALLET_ACTIONS_ENABLED;
  join.disabled = proofOnly ? false : Boolean(joined) || Market.terminal(record.status) || (!paymentReady && !canConnect && !canSwitch);
  join.textContent = proofOnly ? readOnlyFlowLabel('payment') : joined ? 'Joined on Tempo' : Market.terminal(record.status) ? 'Request closed'
    : paymentReady ? 'Join this request on Tempo' : canSwitch ? 'Switch wallet to Tempo' : canConnect ? 'Connect wallet to pay' : 'Use LIVE proof';
  join.title = proofOnly ? readOnlyFlowTitle('payment') : paymentReady || joined || Market.terminal(record.status) ? '' : canConnect || canSwitch ? 'Connect the wallet first. No request payment is sent during connection.' : 'Tempo payment is not ready. No buyer payment has been sent.';
  const currentDepositCents = Number(joined?.depositCents || 0);
  const remainingCents = joined && bestPrice > 0 ? Math.max(0, Math.round(bestPrice * 100) - currentDepositCents) : 0;
  if (fund) {
    fund.hidden = (!paymentReady && !canConnect && !canSwitch) || remainingCents <= 0 || Market.terminal(record.status);
    fund.disabled = !paymentReady && !canConnect && !canSwitch;
    fund.dataset.requestId = join.dataset.requestId;
    fund.dataset.amountCents = String(remainingCents);
    fund.textContent = remainingCents > 0 ? `Pay remaining ${formatExactCents(remainingCents)}` : 'Request fully funded';
  }
  if (hint) hint.textContent = proofOnly
    ? 'This page shows demand. The confirmed Tempo payment is on the Deal page.'
    : joined
    ? remainingCents > 0
      ? `The seller price is ${formatExactCents(Math.round(bestPrice * 100))}. Pay the remaining amount to keep this request funded.`
      : `You have funded up to ${formatExactCents(currentDepositCents)}. If the seller offers less, the difference comes back.`
      : paymentReady ? `Pay up to ${formatExactCents(Math.round(maximum * 100))} on Tempo. Your money stays held for this request; any unused amount returns.`
      : !connectedWalletPresent ? 'Connect a wallet on Tempo before paying. No buyer payment has been sent.'
        : !connectedWalletOnTempo ? 'Switch the connected wallet to Tempo Moderato before paying.'
          : 'Tempo payment is unavailable. No buyer payment has been sent.';
}
['laptopRequest', 'crmRequest'].forEach((id) => {
  $('#' + id)?.addEventListener('click', () => {
    selectedRequestId = id === 'crmRequest' ? 'crm' : 'laptop';
    $$('.request-row').forEach((row) => {
      row.classList.toggle('selected', row.id === id);
      row.setAttribute('aria-pressed', String(row.id === id));
    });
    syncRequestActionCopy();
  });
});
$('#joinRequestButton')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!BROWSER_WALLET_ACTIONS_ENABLED) {
    openTempoEvidence();
    return;
  }
  if (!await ensureTempoWalletForPayment()) return;
  const requestId = button.dataset.requestId;
  const authAmountCents = Number(button.dataset.amountCents || 0);
  if (!requestId || !authAmountCents) return;
  await joinWithWallet('joinRequestButton', 'joinRequest', { requestId, authAmountCents });
  if (button.textContent === 'Buyer payment confirmed') {
    requestJoinState[selectedRequestId] = { depositCents: authAmountCents, requestId };
    const row = selectedRequestId === 'crm' ? $('#crmRequest') : $('#laptopRequest');
    const count = row?.querySelector('i');
    if (count) count.textContent = String(Number(count.textContent || 0) + 1);
    syncRequestActionCopy();
  }
});
$('#fundRequestButton')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!await ensureTempoWalletForPayment()) return;
  const requestId = button.dataset.requestId;
  const amountCents = Number(button.dataset.amountCents || 0);
  if (!requestId || amountCents <= 0) return;
  await joinWithWallet('fundRequestButton', 'fundRequest', { requestId, amountCents });
  if (button.textContent === 'Buyer payment confirmed') {
    const joined = requestJoinState[selectedRequestId] || { requestId, depositCents: 0 };
    requestJoinState[selectedRequestId] = { ...joined, depositCents: joined.depositCents + amountCents };
    syncRequestActionCopy();
  }
});

$('#settleDealLive')?.addEventListener('click', () => executeOwnerAction(
  'settleDealLive', 'dealLiveActionStatus', 'settleDeal', { dealId: liveDemoState?.liveDealId }, 'Deal settlement'
));
$('#confirmDealFulfillmentLive')?.addEventListener('click', () => executeOwnerAction(
  'confirmDealFulfillmentLive', 'dealLiveActionStatus', 'confirmDealFulfillment', { dealId: liveDemoState?.liveDealId }, 'Delivery confirmation'
));
$('#slashDealGuaranteeLive')?.addEventListener('click', () => executeOwnerAction(
  'slashDealGuaranteeLive', 'dealLiveActionStatus', 'slashSettledDealGuarantee', { dealId: liveDemoState?.liveDealId, reason: 'Seller failed to fulfill the order' }, 'Seller guarantee slash'
));
$('#refundDealLive')?.addEventListener('click', () => executeOwnerAction(
  'refundDealLive', 'dealLiveActionStatus', 'refundDeal', { dealId: liveDemoState?.liveDealId, reason: 'Buyer requested a refund' }, 'Deal refund'
));
$('#settleBusinessLive')?.addEventListener('click', () => executeOwnerAction(
  'settleBusinessLive', 'businessLiveActionStatus', 'settleBusinessPool', { poolId: activeIds.poolId }, 'Business settlement'
));
$('#confirmBusinessFulfillmentLive')?.addEventListener('click', () => executeOwnerAction(
  'confirmBusinessFulfillmentLive', 'businessLiveActionStatus', 'confirmBusinessPoolFulfillment', { poolId: activeIds.poolId }, 'Business completion'
));
$('#slashBusinessSupplierLive')?.addEventListener('click', () => executeOwnerAction(
  'slashBusinessSupplierLive', 'businessLiveActionStatus', 'slashSettledBusinessSupplier', { poolId: activeIds.poolId, reason: 'Supplier failed to complete the order' }, 'Supplier failure report'
));
$('#refundBusinessLive')?.addEventListener('click', () => executeOwnerAction(
  'refundBusinessLive', 'businessLiveActionStatus', 'refundBusinessPool', { poolId: activeIds.poolId, reason: 'Business order did not complete' }, 'Business refund'
));
$('#settleRequestLive')?.addEventListener('click', () => executeOwnerAction(
  'settleRequestLive', 'requestLiveActionStatus', 'settleRequest', { requestId: requestRecordForSelection().id || activeIds.laptopReqId }, 'Request settlement'
));
$('#confirmRequestFulfillmentLive')?.addEventListener('click', () => executeOwnerAction(
  'confirmRequestFulfillmentLive', 'requestLiveActionStatus', 'confirmRequestFulfillment', { requestId: requestRecordForSelection().id || activeIds.laptopReqId }, 'Request completion'
));
$('#slashRequestSupplierLive')?.addEventListener('click', () => executeOwnerAction(
  'slashRequestSupplierLive', 'requestLiveActionStatus', 'slashSettledRequestSupplier', { requestId: requestRecordForSelection().id || activeIds.laptopReqId, reason: 'Supplier failed to complete the request' }, 'Supplier failure report'
));
$('#refundRequestLive')?.addEventListener('click', () => executeOwnerAction(
  'refundRequestLive', 'requestLiveActionStatus', 'refundRequest', { requestId: requestRecordForSelection().id || activeIds.laptopReqId, reason: 'Request did not complete' }, 'Request refund'
));

// Create Request Form (Pending -> Success or Rollback)
[['#requestForm', '#requestPreviewCard'], ['#offerForm', '#offerPreviewCard']].forEach(([formSelector, previewSelector]) => {
  $(formSelector)?.addEventListener('input', () => {
    const preview = $(previewSelector);
    if (preview) preview.hidden = true;
  });
});
$('#requestForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!BROWSER_WALLET_ACTIONS_ENABLED) {
    const form = event.currentTarget;
    const title = String(form.elements.need?.value || '').trim();
    const rawPrice = String(form.elements.price?.value || '').trim();
    const price = rawPrice.startsWith('$') ? rawPrice : `$${rawPrice}`;
    const numericPrice = numericValue(price);
    if (!title || !numericPrice || numericPrice <= 0) {
      toast('Enter a product and the most you would pay.');
      return;
    }
    const card = $('#requestPreviewCard');
    if (card) {
      $('#requestPreviewTitle').textContent = title;
      $('#requestPreviewPrice').textContent = price;
      $('#requestPreviewNote').textContent = `Read-only example: up to ${price} would be held for this request, and any unused amount would return. Nothing was sent.`;
      card.hidden = false;
      revealActionResult('#requestPreviewCard');
    }
    toast('Request preview is ready. No payment was sent.');
    return;
  }
  const form = event.currentTarget;
  const epoch = viewEpoch;
  const submitBtn = form.querySelector('button[type="submit"]');
    const prevBtnText = submitBtn ? submitBtn.textContent : 'Create request';
  try {
    const title = form.elements.need.value.trim();
    const rawPrice = form.elements.price.value.trim();
    const price = rawPrice.startsWith('$') ? rawPrice : `$${rawPrice}`;
    const numericBuyers = 1;
    const numericPrice = numericValue(price);

    if (!title || !numericPrice || numericPrice <= 0) {
      toast('Enter a product and the most you would pay.');
      return;
    }
    if (!await ensureTempoWalletForPayment()) return;

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating request…';
    }

    const requestId = 'REQ-' + Date.now().toString(36).toUpperCase();
    // A funded request must actually reserve the stated maximum price. A
    // small authorization here would make the UI say "$700" while only $10
    // was locked on Tempo.
    const authCents = Math.round(numericPrice * 100);
    const result = await executeBackgroundTempoAction('createRequest', {
      requestId,
      title,
      targetPriceCents: Math.round(numericPrice * 100),
      authAmount: authCents,
      buyers: 1,
    });
    const liveLedger = result.success ? {
      payments: [{ buyerId: 'connected wallet', time: getFormattedTime(), receiptId: result.hash || requestId, amountCents: authCents, status: 'CONFIRMED' }],
      summary: { paymentCount: 1, lockedCents: authCents, status: 'CONFIRMED' },
    } : null;

    if (epoch !== viewEpoch || result.stale) return;
    if (submitBtn) {
      submitBtn.disabled = result.status === 'PENDING';
      submitBtn.textContent = prevBtnText;
    }

    if (!result || !result.success) {
      toast((result && result.error) || 'Could not create request. State unchanged.');
      return;
    }

    // Keep the confirmed request in the request board with its Tempo receipt.
    const row = document.createElement('div');
    row.className = 'request-row custom-request';
    row.dataset.title = title;
    if (result.requestId) row.dataset.reqId = result.requestId;
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    const details = document.createElement('span');
    const status = document.createElement('b');
    name.textContent = title;
    details.textContent = `1 person · max ${price} · 0 offers`;
    status.textContent = 'FUNDED ON TEMPO';
    copy.append(name, details);
    row.append(copy, status);
    const reqLog = $('#requestLog');
    if (reqLog) {
      reqLog.before(row);
    } else {
      $('.request-list')?.append(row);
    }

    // Also add the confirmed demand to the Sell page.
    const demandContainer = $('#demandItemsContainer');
    if (demandContainer) {
      const demandBtn = document.createElement('button');
      demandBtn.className = 'demand-item custom-demand-item';
      demandBtn.type = 'button';
      demandBtn.setAttribute('aria-pressed', 'false');
      demandBtn.dataset.title = title;
      demandBtn.dataset.price = price;
      if (result.requestId) demandBtn.dataset.reqId = result.requestId;
      const demandVolumeStr = numericPrice >= 1000 ? `$${Math.round(numericPrice / 1000)}k` : `$${numericPrice}`;
      const span = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = title;
      const small = document.createElement('small');
      small.textContent = `1 wallet · ${demandVolumeStr} · Tempo confirmed`;
      span.append(strong, small);
      const b = document.createElement('b');
      b.textContent = price;
      demandBtn.append(span, b);
      demandBtn.addEventListener('click', () => {
        $$('.demand-item').forEach((r) => {
          r.classList.remove('selected');
          r.setAttribute('aria-pressed', 'false');
        });
        demandBtn.classList.add('selected');
        demandBtn.setAttribute('aria-pressed', 'true');
        const op = $('#offerProduct');
        const ovl = $('#offerValueLabel');
        if (op) op.textContent = title;
        if (ovl) ovl.textContent = title === 'Coffee supplies' ? 'Your discount' : 'Your price per item';
        const off = $('#offerForm');
        if (off) syncSellerOfferForm(title, suggestNextBetterOffer(title, demandBtn.dataset.price || price));
      });
      demandContainer.append(demandBtn);
      const dgc = $('#demandGroupCount');
      if (dgc) dgc.textContent = `${$$('.demand-item').length} groups`;
    }

    addMiniLog('requestLog', `Request authorization confirmed on Tempo · ${price} maximum · ${result.hash || requestId}`);
    renderSecondaryPaymentLedger('requestPaymentLedger', liveLedger, {
      countId: 'requestPaymentCount', amountId: 'requestMoneyLocked', statusId: 'requestPaymentStatus', noteId: 'requestPaymentNote'
    });
    toast('Request authorization confirmed on Tempo.');

    updateMarketSummary();
    form.reset();
  } catch (err) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevBtnText;
    }
    console.error('Action failed:', err);
    toast('Something went wrong. Please try again.');
  }
});

function suggestNextBetterOffer(title, priceStr) {
  const num = numericValue(priceStr);
  if (!num) return priceStr;
  if (title === 'Coffee supplies') {
    return `−${Math.min(99, num + 1)}%`;
  }
  const step = num > 100 ? 10 : 1;
  return `$${Math.max(1, num - step)}`;
}

function syncSellerOfferForm(title, suggestedPrice = '') {
  const isDeal = title === 'Phone group order';
  const dealTerms = $('#dealOfferTerms');
  const ladder = $('#sellerLadderFields');
  const singlePrice = $('#offerSinglePriceField');
  const support = $('#offerSupportNote');
  // Capacity and expiry are real supplier terms for every market. Only the
  // consumer deal has a buyer-threshold ladder; hiding the whole terms block
  // made Business and Request offers look like unbounded, timeless promises.
  if (dealTerms) dealTerms.hidden = false;
  if (ladder) ladder.hidden = !isDeal;
  if (singlePrice) singlePrice.hidden = isDeal;
  const offerPriceField = $('#offerForm')?.elements?.offerPrice;
  if (offerPriceField) {
    offerPriceField.disabled = isDeal;
    offerPriceField.required = !isDeal;
  }
  const standaloneThreshold = $('#offerForm')?.elements?.minimumBuyerCount;
  if (standaloneThreshold) {
    standaloneThreshold.disabled = true;
    standaloneThreshold.required = false;
    const label = standaloneThreshold.closest('label');
    if (label) label.hidden = true;
  }
  const dealOnlyFields = ['ladderPrice1', 'ladderThreshold1', 'ladderPrice2', 'ladderThreshold2', 'ladderPrice3', 'ladderThreshold3'];
  dealOnlyFields.forEach((name) => {
    const field = $('#offerForm')?.elements?.[name];
    if (field) {
      field.disabled = !isDeal;
      const label = field.closest('label');
      if (label) label.hidden = !isDeal;
    }
  });
  ['maxBuyerUnits', 'expiry'].forEach((name) => {
    const field = $('#offerForm')?.elements?.[name];
    if (field) field.disabled = false;
  });
  const deliveryField = $('#offerForm')?.elements?.delivery;
  if (deliveryField) {
    deliveryField.disabled = false;
    const deliveryLabel = deliveryField.closest('label');
    if (deliveryLabel) deliveryLabel.hidden = false;
  }
  const offerLabel = $('#offerValueLabel');
  if (offerLabel) offerLabel.textContent = title === 'Coffee supplies' ? 'Your discount' : 'Your price per item';
  const offer = offerPriceField;
  if (offer && suggestedPrice) offer.value = suggestedPrice;
  if (support) support.textContent = !BROWSER_WALLET_ACTIONS_ENABLED
    ? isDeal
      ? 'PREVIEW ONLY. This form does not change the market or send a guarantee. A live offer would record this ladder and lock the guarantee on Tempo.'
      : 'PREVIEW ONLY. This form does not change the market or send a guarantee. A live offer would lock the guarantee on Tempo.'
    : isDeal
      ? 'Publishing records your price ladder on Tempo and holds your guarantee until delivery is confirmed.'
      : 'Publishing records your offer, capacity, 7-day delivery window and expiry on Tempo. Your guarantee stays locked until delivery is confirmed.';
  const form = $('#offerForm');
  if (form) {
    form.elements.guarantee.value = isDeal ? '$55' : '$10';
    form.elements.maxBuyerUnits.value = isDeal ? 800 : 300;
  }
  const guaranteeHelp = $('#sellerGuaranteeHelp');
  if (guaranteeHelp) guaranteeHelp.textContent = !BROWSER_WALLET_ACTIONS_ENABLED
    ? isDeal
      ? 'A real offer locks this amount until delivery. It is not locked in this example.'
      : 'A real offer locks this amount until delivery. It is not locked in this example.'
    : isDeal
      ? 'Returned if you deliver; forfeited if you fail. The minimum depends on your price and capacity.'
      : 'At least $10. Returned if you deliver; forfeited if you fail.';
  renderSellerGuarantee(isDeal ? 5500 : 1000);
}

// Seller offers are explicit Tempo wallet actions. No local guarantee is
// recorded as paid when the live contract is not ready.
$('#offerForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (!BROWSER_WALLET_ACTIONS_ENABLED) {
    const item = $('.demand-item.selected');
    const title = item?.dataset.title || $('#offerProduct')?.textContent || 'Selected group';
    const rawOffer = String(form.elements.offerPrice?.value || '').trim();
    const rawGuarantee = String(form.elements.guarantee?.value || '').trim();
    const guaranteeValue = numericValue(rawGuarantee);
    const capacity = Number(form.elements.maxBuyerUnits?.value || 0);
    const isDiscount = title === 'Coffee supplies';
    const marketType = isDiscount ? 'business' : title === 'Phone group order' ? 'deal' : 'request';
    const ladderPrices = ['ladderPrice1', 'ladderPrice2', 'ladderPrice3'].map((name) => numericValue(form.elements[name]?.value || ''));
    const ladderThresholds = ['ladderThreshold1', 'ladderThreshold2', 'ladderThreshold3'].map((name) => Number(form.elements[name]?.value || 0));
    const offerValue = marketType === 'deal' ? ladderPrices[0] : numericValue(rawOffer);
    if (!offerValue || offerValue <= 0 || !Number.isInteger(capacity) || capacity < 1 || !guaranteeValue || guaranteeValue < 0) {
      toast('Enter a price, capacity and seller guarantee.');
      return;
    }
    if (marketType === 'deal' && (ladderPrices.some((value) => !value || value <= 0)
      || ladderThresholds.some((value) => !Number.isInteger(value) || value < 1)
      || ladderPrices.some((value, index) => index > 0 && value >= ladderPrices[index - 1])
      || ladderThresholds.some((value, index) => index > 0 && value <= ladderThresholds[index - 1]))) {
      toast('Each lower price needs a higher funded-buyer threshold.');
      return;
    }
    const minimumBondCents = Math.max(1000, marketType === 'deal' ? Math.floor(offerValue * capacity * 100 / 10000) : 0);
    if (Math.round(guaranteeValue * 100) < minimumBondCents) {
      toast(`This offer needs a seller guarantee of at least ${Market.dollars(minimumBondCents)}.`);
      return;
    }
    const displayOffer = isDiscount ? `−${Math.min(99, offerValue)}%` : marketType === 'deal' ? 'See price ladder' : (rawOffer.startsWith('$') ? rawOffer : `$${offerValue}`);
    const displayTiers = marketType === 'deal'
      ? ladderPrices.map((value, index) => `${Market.dollars(Math.round(value * 100))} at ${ladderThresholds[index]}`).join(' · ')
      : 'One group price';
    const card = $('#offerPreviewCard');
    if (card) {
      $('#offerPreviewTitle').textContent = `Offer for ${title}`;
      $('#offerPreviewPriceLabel').textContent = marketType === 'deal' ? 'Price source' : 'Your price';
      $('#offerPreviewPrice').textContent = displayOffer;
      $('#offerPreviewCapacity').textContent = `${capacity.toLocaleString('en-US')} items`;
      $('#offerPreviewTiers').textContent = displayTiers;
      $('#offerPreviewGuarantee').textContent = BROWSER_WALLET_ACTIONS_ENABLED
        ? `$${guaranteeValue.toLocaleString('en-US')} held until delivery`
        : `Guarantee: $${guaranteeValue.toLocaleString('en-US')}`;
      $('#offerPreviewNote').textContent = `Read-only example: this price would compete for the selected group. No guarantee was sent.`;
      card.hidden = false;
      revealActionResult('#offerPreviewCard');
    }
    toast('Offer preview is ready. No guarantee was sent.');
    return;
  }
  const item = $('.demand-item.selected');
  if (!item) return;
  const title = item.dataset.title;
  const rawOffer = String(form.elements.offerPrice?.value || '').trim();
  const rawGuarantee = String(form.elements.guarantee?.value || '').trim();
  const capacity = Number(form.elements.maxBuyerUnits?.value || 0);
  const delivery = String(form.elements.delivery?.value || '7 days');
  const expiry = String(form.elements.expiry?.value || '24 hours');
  const guaranteeValue = numericValue(rawGuarantee);
  const isDiscount = title === 'Coffee supplies';
  const marketType = isDiscount ? 'business' : title === 'Phone group order' ? 'deal' : 'request';
  const tierPrices = ['ladderPrice1', 'ladderPrice2', 'ladderPrice3'].map((name) => numericValue(form.elements[name]?.value || ''));
  const tierThresholds = ['ladderThreshold1', 'ladderThreshold2', 'ladderThreshold3'].map((name) => Number(form.elements[name]?.value || 0));
  const offerValue = marketType === 'deal' ? tierPrices[0] : numericValue(rawOffer);
  if (!offerValue || offerValue <= 0 || !guaranteeValue || guaranteeValue < 0) {
    toast('Enter a valid offer and seller guarantee.');
    return;
  }
  if (marketType === 'deal' && (!Number.isInteger(capacity) || capacity < 1)) {
    toast('Enter a valid maximum capacity.');
    return;
  }
  if (marketType !== 'deal' && (!Number.isInteger(capacity) || capacity < 1)) {
    toast('Enter how many items you can supply.');
    return;
  }
  const minimumBondCents = Math.max(1000, marketType === 'deal' ? Math.floor(offerValue * capacity * 100 / 10000) : 0);
  if (Math.round(guaranteeValue * 100) < minimumBondCents) {
    toast(`This offer needs a seller guarantee of at least ${Market.dollars(minimumBondCents)}.`);
    return;
  }
  if (!await ensureTempoWalletForPayment()) return;
  const normalizedOffer = isDiscount ? `−${Math.min(99, offerValue)}%` : `$${offerValue}`;
  const targetId = item.dataset.reqId || (marketType === 'business' ? activeIds.poolId : marketType === 'deal' ? activeIds.dealId : title === 'CRM under $30 / user' ? activeIds.crmReqId : activeIds.laptopReqId);
  const expirySeconds = String(expiry).startsWith('7') ? 7 * 86400 : String(expiry).startsWith('48') ? 48 * 3600 : 24 * 3600;
  let actionName = 'submitOffer';
  let offerPayload = {
    targetId, marketType, sellerName: 'Connected seller',
    guaranteeBond: Math.round(guaranteeValue * 100),
    priceCents: isDiscount ? undefined : Math.round(offerValue * 100),
    discountPercent: isDiscount ? Math.min(99, offerValue) : undefined,
    maxBuyerCount: capacity,
    offerExpiry: Math.floor(Date.now() / 1000) + expirySeconds,
  };
  let ladderPrices = null;
  let ladderThresholds = null;
  if (marketType === 'deal') {
    if (tierPrices.some((value) => !value || value <= 0) || tierThresholds.some((value) => !Number.isInteger(value) || value < 1)
      || tierPrices.some((value, index) => index > 0 && value >= tierPrices[index - 1])
      || tierThresholds.some((value, index) => index > 0 && value <= tierThresholds[index - 1])) {
      toast('Each lower ladder price needs a higher funded-buyer threshold.');
      return;
    }
    actionName = 'submitPriceLadder';
    ladderPrices = tierPrices.map((value) => Math.round(value * 100));
    ladderThresholds = tierThresholds;
    offerPayload = {
      targetId, marketType, sellerName: 'Connected seller',
      guaranteeBond: Math.round(guaranteeValue * 100),
      pricesCents: ladderPrices,
      minimumBuyerCounts: ladderThresholds,
      maxBuyerUnits: capacity,
      offerExpiry: Math.floor(Date.now() / 1000) + expirySeconds,
    };
  }
  button.disabled = true;
  const previousButtonText = button.textContent;
  button.textContent = 'Sending to Tempo…';
  const liveResult = await executeBackgroundTempoAction(actionName, offerPayload);
  if (!liveResult.success) {
    button.disabled = false;
    button.textContent = previousButtonText;
    toast(liveResult.error || 'Seller offer was not confirmed on Tempo.');
    return;
  }
  // A confirmed seller transaction proves that the offer was recorded. It
  // does not prove that the offer is already the winner: threshold, capacity
  // and expiry still have to be checked by the contract. Never rewrite the
  // simulated offer book locally and call the new offer “best price”.
  addMiniLog(
    title === 'Coffee supplies' ? 'businessLog' : title === 'Phone group order' ? 'dealLog' : 'requestLog',
    marketType === 'deal'
      ? `Seller ladder recorded on Tempo · ${ladderPrices.map((value, index) => `${Market.dollars(value)} at ${ladderThresholds[index]} funded buyers`).join(' · ')} · winner updates only when the offer is valid`
      : `Seller offer recorded on Tempo · ${normalizedOffer} · the market updates after the offer is valid`
  );
  button.textContent = 'Offer confirmed on Tempo';
  if ($('#guaranteeStatus')) $('#guaranteeStatus').textContent = marketType === 'deal'
    ? `Tempo confirmed · ${ladderPrices.map((value, index) => `${Market.dollars(value)} at ${ladderThresholds[index]} buyers`).join(' · ')} · ${capacity} item capacity.`
    : `Tempo confirmed · ${normalizedOffer} · ${capacity} item capacity · offer expires ${expiry}. Seller guarantee locked.`;
  renderSellerGuarantee(Math.round(guaranteeValue * 100), liveResult.hash || `TEMPO-${Date.now()}`, 'LOCKED');
  toast(marketType === 'deal'
    ? 'Price ladder recorded. The current price changes only when its funded-buyer rule is met.'
    : `Offer recorded at ${normalizedOffer}. The market will show it after the chain confirms it is valid.`);
  setTimeout(() => { button.disabled = false; button.textContent = BROWSER_WALLET_ACTIONS_ENABLED ? 'Publish offer · lock guarantee' : 'Preview offer'; }, 900);
});

$('#sellerProofLink')?.addEventListener('click', () => {
  openTempoEvidence();
});

// Demand Items Selection
$$('.demand-item').forEach((item) =>
  item.addEventListener('click', () => {
    if (item.dataset.closed === 'true' || item.disabled) {
      toast('ეს მაგალითი დასრულებულია. აირჩიე ღია ჯგუფი ახალი შეთავაზებისთვის.');
      return;
    }
    $$('.demand-item').forEach((row) => {
      row.classList.remove('selected');
      row.setAttribute('aria-pressed', 'false');
    });
    item.classList.add('selected');
    item.setAttribute('aria-pressed', 'true');
    const previousPreview = $('#offerPreviewCard');
    if (previousPreview) previousPreview.hidden = true;
    const op = $('#offerProduct');
    const ovl = $('#offerValueLabel');
    const off = $('#offerForm');
    if (op) op.textContent = item.dataset.title;
    if (ovl) ovl.textContent = item.dataset.title === 'Coffee supplies' ? 'Your discount' : 'Your price per item';
    if (off) syncSellerOfferForm(item.dataset.title, suggestNextBetterOffer(item.dataset.title, item.dataset.price));
  })
);

// Initial View Setup
const rawInitialHash = window.location.hash.slice(1) || 'home';
const initialView = rawInitialHash.split('?')[0] || 'home';
if (initialView === 'deals') {
  showView('home', { scroll: false });
  window.setTimeout(() => $('#deals')?.scrollIntoView({ behavior: 'auto', block: 'start' }), 0);
} else if (['home', 'deal', 'business', 'request', 'sell'].includes(initialView)) {
  showView(initialView, { scroll: false });
} else {
  showView('home', { scroll: false });
}

// Initial Marketplace Sync
applyDeal(getDealDefaults(), 0, 1);
syncBusinessProgress(Number(canonicalServerState?.business?.buyers) || 0);
syncBusinessSuppliers(
  canonicalServerState?.business?.offerA || '—',
  canonicalServerState?.business?.offerB || '—',
  canonicalServerState?.business?.offerC || '—',
  canonicalServerState?.business?.winnerId || 'C'
);
updateMarketSummary();
setSimulatedMode();

if (rawInitialHash.includes('join=live') || rawInitialHash.includes('join=1')) showView('deal', { scroll: false });
