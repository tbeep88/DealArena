# DealArena

DealArena turns scattered buyer demand into one clear order. Buyers join together, sellers see the size of the order and compete for it, and a larger group can unlock a lower price. Buyers pay the final price, unused money comes back after the price is locked, the seller is paid after delivery, and DealArena earns 1% after completion.

The core flow is:

`buyer payment → money held → seller price ladder → best funded offer → surplus/refund → delivery → seller payout + 1% fee → receipt`

The jury demo has two clearly separated parts:

- **Example market:** the 500-buyer view is a modeled scale example. It shows why the price falls and how the money would be split, but it does not claim 500 blockchain payments.
- **LIVE Tempo proof:** a separate bounded testnet run proves the real payment path: buyer funding → seller competition → price lock → buyer surplus refund → delivery confirmation → seller payout + 1% fee → receipts.

Tempo Moderato testnet is the payment and proof rail (chain ID `42431`, PathUSD). Viewing the example or the saved proof never opens a wallet or sends a new transaction.

## Startup wedge

DealArena starts with standardised, high-ticket electronics and office equipment. The insight is not simply “group buying”: buyers fund the order first, then sellers compete for already-proven purchasing power. That is why the price can fall without asking a seller to guess whether demand is real.

The first distribution plan is narrow: start with one standardized consumer-electronics or office-equipment category and one strong deal at a time. Bring buyers through product communities, deal communities and direct demand aggregation; recruit sellers directly. This is a launch hypothesis, not claimed traction. Business pools and product requests are expansion use cases, not the starting market. The business model is a 1% success fee after delivery; example economics: a `$295,000` order would produce a `$2,950` DealArena fee. This is a model, not claimed traction.

No traction is fabricated in the demo. Before claiming demand, collect five seller conversations and a buyer waitlist or written buyer interest; keep those records separate from the simulated market and LIVE Tempo proof.

## Run locally

Requirements: Node.js 18+ and npm 9+.

```bash
npm ci
npm start
```

Open `http://127.0.0.1:4184`.

The jury-facing page does not open a browser wallet or request token approval. Browser-wallet writes are intentionally disabled so a visitor can move through every screen without Phantom/MetaMask interruptions. `Run new order · Tempo testnet` plays the modeled market and then starts new payments from three preset testnet-only wallets. The main Deal button also starts a new order. After price lock it becomes `Confirm demo delivery · pay seller`. `View on Tempo` only opens an explorer receipt. The other market scenarios remain clearly labeled simulations and do not send payments.

For the jury demonstration, configure dedicated testnet-only keys in `.env` (never commit them), then prepare the actors explicitly:

```powershell
$env:TEMPO_PREPARE_DEMO='true'; node .\server.js
```

Preparation sends only the required bounded funding and approvals for the dedicated demo wallets. Page load, polling, reset, and receipt viewing send no payments. Explicitly starting an order creates new testnet transactions; delivery confirmation releases the payout separately. Action IDs and an in-flight UI guard prevent rapid repeated clicks from sending the same order twice. No page load or background poll can open a wallet chooser or send a transaction.

## Product structure

### Public LIVE presenter access

Public LIVE actions require `TEMPO_PUBLIC_DEMO=true` and `TEMPO_PRESENTER_MODE=true`.
With `TEMPO_JURY_DEMO_PUBLIC=true` on Tempo testnet (chain 42431), visitors can
start the bounded three-wallet Deal flow and finish its permitted owner actions.
The server limits this public demo to 20 starts per day and scopes owner actions
to the active demo order. Other write actions still require presenter access.
Without jury-public mode, use a private `TEMPO_PRESENTER_TOKEN` and the HTTPS
link `#deal?presenter=<token>`. The token is stripped from the address bar and
retained only for the current tab. No wallet key is delivered to the browser.
Page loads, polling and viewing saved receipts never send a payment.

The primary Deal action starts a **new three-wallet testnet order**, not a
500-buyer payment. Settlement returns surplus and holds seller payout until
the presenter explicitly confirms demo delivery. A fresh open order hides
previous receipts so historical proof cannot appear as its result.

- **Home** answers the first question: why would buyers join and why would a seller lower the price?
- **Deal** is the center of gravity: it shows the order growing, seller offers, the lower price, the modeled money split, and the separate confirmed Tempo proof.
- **Business** shows how recurring café demand becomes one predictable supplier order and where the 1% fee comes from.
- **Request** shows how a buyer sets a maximum price, lets others join, and gets the difference back if a seller beats the limit.
- **Sell** shows why a seller would compete: one known order, a visible price limit, delivery, and payout after completion.

Business, Request and Sell are read-only product examples in the jury build. Their purpose is to explain the product and business model without pretending that a new payment or guarantee was sent. The confirmed on-chain payment flow is shown once, clearly, on Deal.

The large 500-buyer view is an aggregate example of scale and is never presented as an on-chain receipt. A saved LIVE proof is shown only after its receipts are re-checked against the current hardened contract and their expected market, actor, amount, and lifecycle event. A confirmed proof lists each real step: buyer funding, seller ladder, competing offer, additional buyer funding, price lock and surplus, delivery, payout, or refund. Every row has a short hash and a `View on Tempo` link.

Payment identity is explicit: one real buyer payment is one buyer's own Tempo authorization and one `joinDeal` action. `joinDealUnits` only lets that same buyer buy multiple units; it does not represent multiple buyers. Native Tempo batches are reserved for atomically grouped actions from one sender, such as settlement, surplus, refund, or payout operations. The 500-buyer number is never sent as one buyer payment.

## Contract rules

The checked-in v17 escrow contract implements the product rules:

- a seller may publish descending volume prices with thresholds, capacity, expiry, and a guarantee;
- the deepest valid funded tier becomes the current price;
- a future tier does not block a smaller funded order from closing;
- after the deadline there is one deterministic decision: the best valid funded offer (including the saved backup supplier when needed) settles, otherwise the order refunds;
- seller guarantee funds are separate from buyer escrow;
- Business/Request settlement only locks the order; a separate explicit delivery confirmation releases supplier payout and the DealArena fee;
- Business/Request keep the best and next-best supplier offer bonded until the order closes, so an expired, revoked, or undersized leader can be replaced safely;
- Deal price tiers track eligible funded buyers as payments arrive, avoiding a full buyer-list rescan for every seller tier on each join;
- buyer accounting is cleared after completion and refunds are batched in groups of at most 200 recipients.

The recorded Tempo deployment is the full v17 at `0x4015c5B9e413A49977be2180D53d3214903A0804`. To fit Tempo's contract-size limit without deleting Business or Request logic, the build generates five fixed modules from the full source and one non-upgradeable router. All actions still use the same escrow address, token balances and shared state; each module rejects direct calls. Deployment checks the actual creation transaction, code hash, version, owner and token before publishing the address.

Rebuild with `node contracts/build.js`; deploy with `node contracts/deploy.js` using dedicated testnet keys. The durable deployment journal resumes already confirmed components instead of deploying duplicates. Local EVM tests exercise funding, ladder selection, deterministic close, delivery-held payout, refunds, backup suppliers and supplier timeout against this exact modular build.

The deployed address is recorded in `contracts/deployed.json`. The server verifies the chain, bytecode, contract version, payment token, owner, seller authorization, balances, and allowances before enabling LIVE actions.

## Verification

```bash
node --check app.js
node --check server.js
npm test
```

The normal suite does not send testnet money. The opt-in live integration test does:

```powershell
$env:TEMPO_RUN_LIVE_INTEGRATION='true'; node --test tests/live-integration.test.js
```

The submission ZIP must contain source, contract artifacts, assets, tests, README/license, and only the English documentation needed to run or understand the product. It must not contain `.data` runtime state, wallet keys, logs, `AGENTS.md`, `plan.txt`, `JURY_PLAN.md`, `DESIGN.md`, or other internal instruction files.

## Submission story

Show the jury this order: problem → funded buyer demand → seller competition → lower price → buyer surplus/refund → delivery-gated payout → Tempo receipt → 1% business model. The product is simple because every screen answers one question: what is being bought, what price is available, what payment is required, and what happens to the money.

The video deliverables are intentionally split:

- `VIDEO_SCRIPT.md` and `VIDEO_SCRIPT_EN.md` contain the **2–3 minute presentation**: the insight, buyer and seller incentives, narrow launch wedge, cold-start answer, Tempo's role, known risks, business model and vision.
- The same files contain a separate **product demo of up to 3 minutes**: the example market moving from 200 to 500 buyers, seller competition, the modeled money path and the confirmed Tempo receipts.

The presentation sells the opportunity; the demo proves the execution. Neither video presents the 500-buyer example as 500 real on-chain payments.
