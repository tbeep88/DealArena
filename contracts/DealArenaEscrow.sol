// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferWithMemo(address recipient, uint256 amount, bytes32 memo) external;
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

contract DealArenaEscrow {
    uint256 public constant CONTRACT_VERSION = 17;
    uint256 public constant FINAL_BIDDING_WINDOW = 5;
    uint256 public constant DEFAULT_MARKET_DURATION = 1 days;
    uint256 public constant DEFAULT_FULFILLMENT_WINDOW = 7 days;
    // PathUSD has 6 decimals on Tempo Moderato. These floors prevent dust
    // commitments/bonds from poisoning a market or bypassing economic intent.
    uint256 public constant MIN_BUYER_COMMITMENT = 1_000_000;
    uint256 public constant MIN_SELLER_BOND = 10_000_000;
    uint256 public constant MIN_SELLER_BOND_BPS = 1; // 0.01% of max order value, never below $10
    uint256 public constant MAX_UNITS_PER_BUYER = 20;
    // The public ladder ends at 800 units. The 500-buyer jury example is a
    // display scale, not the on-chain market ceiling.
    uint256 public constant MAX_MARKET_BUYERS = 800;
    // Bound per-buyer offer-cache work. The product currently models three
    // competing sellers; eight still leaves room without unbounded gas growth.
    uint256 public constant MAX_OFFER_SELLERS = 8;
    IERC20 public immutable paymentToken;
    address public immutable owner;
    address public treasury;
    uint256 public maxOfferPrice;
    mapping(address => bool) public authorizedSellers;
    // New sellers may publish a bonded offer without a private allowlist. The
    // owner can still revoke an address, and revocation also deactivates its
    // existing offers through the liveness checks below.
    mapping(address => bool) public sellerRevoked;
    mapping(string => uint256) public marketDeadlines;
    mapping(string => uint256) public businessDeadlines;
    mapping(string => uint256) public requestDeadlines;

    struct Deal {
        uint256 buyersCount;
        uint256 bestPrice;
        address bestSeller;
        uint256 totalEscrow;
        uint256 sellerGuaranteeBond;
        uint256 committedUnits;
        uint256 maxBuyerUnits;
        uint256 offerExpiry;
        uint256 minimumBuyerCount;
        uint256 sellerPayout;
        uint256 platformFee;
        uint256 settledGrossVolume;
        uint256 settlementTargetBuyerCount;
        uint256 finalBiddingEndsAt;
        uint256 fulfillmentDeadline;
        bool isSettled;
        bool isRefunded;
    }

    struct ConditionalOffer {
        uint256 price;
        uint256 guaranteeBond;
        uint256 maxBuyerUnits;
        uint256 offerExpiry;
        uint256 minimumBuyerCount;
        uint16 fundedBuyerCount;
        uint16 fundedUnits;
        bool active;
    }

    struct PriceTier {
        uint256 price;
        uint256 minimumBuyerCount;
        uint256 maxBuyerUnits;
        uint256 offerExpiry;
        uint16 fundedBuyerCount;
        uint16 fundedUnits;
        bool active;
    }

    struct BusinessPool {
        uint256 buyersCount;
        uint256 totalDemand;
        uint256 bestDiscountPercent;
        address bestSupplier;
        uint256 supplierGuaranteeBond;
        uint256 supplierPayout;
        uint256 platformFee;
        uint256 settledGrossVolume;
        bool isSettled;
        bool isRefunded;
    }

    struct DemandRequest {
        uint256 maxPrice;
        uint256 bestPrice;
        address bestSupplier;
        uint256 buyersCount;
        uint256 totalEscrow;
        uint256 supplierGuaranteeBond;
        uint256 supplierPayout;
        uint256 platformFee;
        uint256 settledGrossVolume;
        bool isSettled;
        bool isRefunded;
    }

    struct SupplierOffer {
        address supplier;
        uint256 value;
        uint256 guaranteeBond;
        uint256 maxBuyers;
        uint256 offerExpiry;
    }

    mapping(string => Deal) internal deals;
    mapping(string => mapping(address => uint256)) public buyerDeposits;
    mapping(string => mapping(address => uint256)) public buyerUnits;
    mapping(string => address[]) internal dealBuyers;
    mapping(string => mapping(address => uint256)) internal sellerGuarantees;
    mapping(string => mapping(address => ConditionalOffer)) internal dealOffers;
    mapping(string => address[]) internal dealOfferSellers;
    mapping(string => mapping(address => bool)) internal dealOfferSellerSeen;
    mapping(string => mapping(address => PriceTier[])) internal dealPriceTiers;
    mapping(string => mapping(address => bool)) internal ladderOffers;

    enum DealStatus { OPEN, PRICE_LOCKED, AWAITING_FULFILLMENT, COMPLETED, REFUNDING, REFUNDED }
    mapping(string => DealStatus) public dealStatus;

    mapping(string => BusinessPool) public businessPools;
    mapping(string => mapping(address => uint256)) public businessDeposits;
    mapping(string => address[]) internal businessBuyers;
    mapping(string => mapping(address => uint256)) internal businessSupplierGuarantees;
    mapping(string => uint256) public businessSupplierMaxBuyers;
    mapping(string => uint256) public businessSupplierOfferExpiry;
    mapping(string => uint256) public businessFulfillmentDeadlines;
    mapping(string => SupplierOffer) public businessBackupOffers;

    mapping(string => DemandRequest) public demandRequests;
    mapping(string => mapping(address => uint256)) public requestDeposits;
    mapping(string => address[]) internal requestBuyers;
    mapping(string => mapping(address => uint256)) internal requestSupplierGuarantees;
    mapping(string => uint256) public requestSupplierMaxBuyers;
    mapping(string => uint256) public requestSupplierOfferExpiry;
    mapping(string => uint256) public requestFulfillmentDeadlines;
    mapping(string => SupplierOffer) public requestBackupOffers;
    mapping(string => uint256) public refundTotals;
    mapping(string => uint256) public businessRefundTotals;
    mapping(string => uint256) public requestRefundTotals;
    mapping(string => uint256) public businessRefundRemaining;
    mapping(string => uint256) public requestRefundRemaining;

    event DealJoined(
        string indexed dealId,
        address indexed buyer,
        uint256 depositAmount,
        uint256 totalBuyerDeposit,
        uint256 buyersCount,
        uint256 timestamp
    );
    event OfferSubmitted(
        string indexed dealId,
        address indexed seller,
        string sellerName,
        uint256 price,
        uint256 guaranteeBond,
        uint256 minimumBuyerCount,
        uint256 timestamp
    );
    event OfferCapacityUpdated(string indexed dealId, address indexed seller, uint256 maxBuyerUnits, uint256 offerExpiry, uint256 timestamp);
    event OfferExpired(string indexed dealId, address indexed seller, uint256 timestamp);
    event OfferDeactivated(string indexed dealId, address indexed seller, string reason, uint256 timestamp);
    event PriceLadderSubmitted(string indexed dealId, address indexed seller, uint256 guaranteeBond, uint256 tierCount, uint256 timestamp);
    event PriceTierActivated(string indexed dealId, address indexed seller, uint256 price, uint256 minimumBuyerCount, uint256 timestamp);
    event FulfillmentPaymentReleased(string indexed dealId, address indexed seller, uint256 sellerPayout, uint256 platformFee, uint256 timestamp);
    event DealBuyerAccountingCleared(string indexed dealId, uint256 buyerCount, uint256 timestamp);
    event FinalBiddingWindowOpened(string indexed dealId, uint256 endsAt, uint256 targetBuyerCount, uint256 timestamp);
    event DealStatusChanged(string indexed dealId, DealStatus status, uint256 timestamp);
    event SurplusDustSwept(string indexed marketId, uint256 amount, uint256 timestamp);
    event BackupSupplierPromoted(string indexed marketId, uint8 indexed marketType, address indexed supplier, uint256 timestamp);
    event RefundInitiated(string indexed marketId, string reason, uint256 totalEscrow, uint256 timestamp);
    event DealFunded(string indexed dealId, address indexed buyer, uint256 amount, uint256 totalBuyerDeposit, uint256 timestamp);
    event DealPriceLocked(
        string indexed dealId,
        address indexed winningSeller,
        uint256 finalPrice,
        uint256 grossVolume,
        uint256 platformFee,
        uint256 timestamp
    );
    event DealRefunded(
        string indexed dealId,
        string reason,
        uint256 totalRefunded,
        uint256 timestamp
    );
    event BuyerRefunded(
        string indexed dealId,
        address indexed recipient,
        uint256 amount,
        uint256 timestamp
    );
    event GuaranteeSlashed(
        string indexed dealId,
        address indexed seller,
        uint256 slashedAmount,
        string reason,
        uint256 timestamp
    );
    event BusinessPoolJoined(
        string indexed poolId,
        address indexed businessUser,
        uint256 commitmentAmount,
        uint256 timestamp
    );
    event BusinessOfferSubmitted(
        string indexed poolId,
        address indexed supplier,
        string supplierName,
        uint256 discountPercent,
        uint256 guaranteeBond,
        uint256 timestamp
    );
    event BusinessPoolSettled(
        string indexed poolId,
        address indexed winningSupplier,
        uint256 netPayout,
        uint256 platformFee,
        uint256 timestamp
    );
    event BusinessPoolRefunded(
        string indexed poolId,
        string reason,
        uint256 totalRefunded,
        uint256 timestamp
    );
    event SupplierGuaranteeSlashed(
        string indexed marketId,
        uint8 marketType,
        address indexed supplier,
        uint256 slashedAmount,
        string reason,
        uint256 timestamp
    );
    event RequestCreated(
        string indexed requestId,
        address indexed creator,
        string title,
        uint256 maxPrice,
        uint256 authAmount,
        uint256 timestamp
    );
    event RequestJoined(
        string indexed requestId,
        address indexed buyer,
        uint256 authAmount,
        uint256 buyersCount,
        uint256 timestamp
    );
    event RequestFunded(
        string indexed requestId,
        address indexed buyer,
        uint256 amount,
        uint256 totalBuyerDeposit,
        uint256 timestamp
    );
    event RequestOfferSubmitted(
        string indexed requestId,
        address indexed supplier,
        string supplierName,
        uint256 price,
        uint256 guaranteeBond,
        uint256 timestamp
    );
    event RequestSettled(
        string indexed requestId,
        address indexed winningSupplier,
        uint256 finalPrice,
        uint256 timestamp
    );
    event RequestRefunded(
        string indexed requestId,
        string reason,
        uint256 totalRefunded,
        uint256 timestamp
    );
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event PaymentReference(
        bytes32 indexed memo,
        string marketId,
        string phase,
        address indexed recipient,
        uint256 amount
    );
    event SellerAuthorizationUpdated(address indexed seller, bool authorized);
    event MarketDeadlineUpdated(string indexed marketId, string marketType, uint256 deadline);

    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANT");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyOwnerOrExpired(uint256 deadline) {
        require(msg.sender == owner || (deadline > 0 && block.timestamp > deadline), "NOT_AUTHORIZED");
        _;
    }

    constructor(address _paymentToken, address _treasury) {
        require(_paymentToken != address(0) && _treasury != address(0), "ZERO_ADDR");
        paymentToken = IERC20(_paymentToken);
        owner = msg.sender;
        treasury = _treasury;
        maxOfferPrice = type(uint256).max;
        authorizedSellers[msg.sender] = true;
    }

    function _pull(address from, uint256 amount) internal {
        if (amount > 0) {
            require(paymentToken.transferFrom(from, address(this), amount), "TRANSFER_FROM_FAILED");
        }
    }

    function _push(address to, uint256 amount) internal {
        if (amount > 0) {
            require(paymentToken.transfer(to, amount), "TRANSFER_FAILED");
        }
    }

    function _marketMemo(string calldata marketId, string memory phase) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("DealArena:", marketId, ":", phase));
    }

    function _pushMemo(address to, uint256 amount, bytes32 memo, string calldata marketId, string memory phase) internal {
        if (amount > 0) {
            paymentToken.transferWithMemo(to, amount, memo);
            emit PaymentReference(memo, marketId, phase, to, amount);
        }
    }

    function setTreasury(address _newTreasury) external onlyOwner {
        require(_newTreasury != address(0), "ZERO_ADDR");
        emit TreasuryUpdated(treasury, _newTreasury);
        treasury = _newTreasury;
    }

    function setSellerAuthorization(address seller, bool authorized) external onlyOwner {
        require(seller != address(0), "ZERO_ADDR");
        authorizedSellers[seller] = authorized;
        sellerRevoked[seller] = !authorized;
        emit SellerAuthorizationUpdated(seller, authorized);
    }

    function setMarketDeadline(string calldata marketId, uint256 deadline) external onlyOwner {
        require(deadline > block.timestamp, "INVALID_DEADLINE");
        require(marketDeadlines[marketId] == 0, "DEADLINE_LOCKED");
        marketDeadlines[marketId] = deadline;
        emit MarketDeadlineUpdated(marketId, "deal", deadline);
    }

    function setMarketDeadlineForMarket(uint8 marketType, string calldata marketId, uint256 deadline) external onlyOwner {
        require(marketType == 1 || marketType == 2, "INVALID_MARKET_TYPE");
        require(deadline > block.timestamp, "INVALID_DEADLINE");
        if (marketType == 1) {
            require(businessDeadlines[marketId] == 0, "DEADLINE_LOCKED");
            businessDeadlines[marketId] = deadline;
        } else {
            require(requestDeadlines[marketId] == 0, "DEADLINE_LOCKED");
            requestDeadlines[marketId] = deadline;
        }
        emit MarketDeadlineUpdated(marketId, marketType == 1 ? "business" : "request", deadline);
    }

    function _requireBefore(uint256 deadline) internal view {
        require(deadline == 0 || block.timestamp <= deadline, "DEADLINE_PASSED");
    }

    function _ensureMarketDeadline(string calldata marketId, string memory marketType) internal {
        if (keccak256(bytes(marketType)) == keccak256(bytes("business"))) {
            if (businessDeadlines[marketId] == 0) {
                businessDeadlines[marketId] = block.timestamp + DEFAULT_MARKET_DURATION;
                emit MarketDeadlineUpdated(marketId, marketType, businessDeadlines[marketId]);
            }
            return;
        }
        if (keccak256(bytes(marketType)) == keccak256(bytes("request"))) {
            if (requestDeadlines[marketId] == 0) {
                requestDeadlines[marketId] = block.timestamp + DEFAULT_MARKET_DURATION;
                emit MarketDeadlineUpdated(marketId, marketType, requestDeadlines[marketId]);
            }
            return;
        }
        if (marketDeadlines[marketId] == 0) {
            marketDeadlines[marketId] = block.timestamp + DEFAULT_MARKET_DURATION;
            emit MarketDeadlineUpdated(marketId, marketType, marketDeadlines[marketId]);
        }
    }

    function _fundedBuyerCount(string calldata dealId, uint256 price) internal view returns (uint256 count, uint256 units) {
        address[] storage buyers = dealBuyers[dealId];
        for (uint256 i = 0; i < buyers.length; i++) {
            address buyer = buyers[i];
            uint256 buyerUnitsForOffer = buyerUnits[dealId][buyer];
            if (buyerUnitsForOffer > 0 && buyerDeposits[dealId][buyer] >= buyerUnitsForOffer * price) {
                count += 1;
                units += buyerUnitsForOffer;
            }
        }
    }

    // A buyer refunded for an underfunded commitment may join again. Remove
    // every stale occurrence so the active buyer list stays one-address/one
    // commitment and the market capacity check cannot be bypassed by retries.
    function _removeBuyerFromDeal(string calldata dealId, address buyer) internal {
        address[] storage buyers = dealBuyers[dealId];
        for (uint256 i = 0; i < buyers.length; ) {
            if (buyers[i] == buyer) {
                buyers[i] = buyers[buyers.length - 1];
                buyers.pop();
            } else {
                i++;
            }
        }
    }

    function _offerIsLive(string calldata dealId, address seller, ConditionalOffer storage offer, Deal storage deal) internal view returns (bool) {
        uint256 deadline = marketDeadlines[dealId];
        uint256 effectiveNow = deadline > 0 && block.timestamp > deadline ? deadline : block.timestamp;
        return offer.active
            && !sellerRevoked[seller]
            && (offer.offerExpiry == 0 || effectiveNow <= offer.offerExpiry)
            && offer.minimumBuyerCount <= offer.fundedBuyerCount
            && offer.maxBuyerUnits >= offer.fundedUnits;
    }

    function _tierIsLive(string calldata dealId, address seller, PriceTier storage tier) internal view returns (bool) {
        uint256 deadline = marketDeadlines[dealId];
        uint256 effectiveNow = deadline > 0 && block.timestamp > deadline ? deadline : block.timestamp;
        return tier.active
            && !sellerRevoked[seller]
            && (tier.offerExpiry == 0 || effectiveNow <= tier.offerExpiry)
            && tier.minimumBuyerCount <= tier.fundedBuyerCount
            && tier.maxBuyerUnits >= tier.fundedUnits;
    }

    // Cache funding eligibility on each bounded offer. Buyer joins update the
    // active offers once instead of rescanning every existing buyer for every
    // seller and every price tier.
    function _updateOfferFunding(
        string calldata dealId,
        uint256 units,
        uint256 previousDeposit,
        uint256 nextDeposit
    ) internal {
        address[] storage sellers = dealOfferSellers[dealId];
        for (uint256 i = 0; i < sellers.length; i++) {
            address seller = sellers[i];
            if (sellerRevoked[seller]) continue;
            if (ladderOffers[dealId][seller]) {
                PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
                for (uint256 j = 0; j < tiers.length; j++) {
                    PriceTier storage tier = tiers[j];
                    if (!tier.active) continue;
                    uint256 required = units * tier.price;
                    if (previousDeposit < required && nextDeposit >= required) {
                        tier.fundedBuyerCount += 1;
                        tier.fundedUnits += uint16(units);
                    } else if (previousDeposit >= required && nextDeposit < required) {
                        tier.fundedBuyerCount -= 1;
                        tier.fundedUnits -= uint16(units);
                    }
                }
            } else {
                ConditionalOffer storage offer = dealOffers[dealId][seller];
                if (!offer.active) continue;
                uint256 required = units * offer.price;
                if (previousDeposit < required && nextDeposit >= required) {
                    offer.fundedBuyerCount += 1;
                    offer.fundedUnits += uint16(units);
                } else if (previousDeposit >= required && nextDeposit < required) {
                    offer.fundedBuyerCount -= 1;
                    offer.fundedUnits -= uint16(units);
                }
            }
        }
    }

    function _bestOfferFundedUnits(string calldata dealId, Deal storage deal) internal view returns (uint256) {
        address seller = deal.bestSeller;
        if (seller == address(0)) return 0;
        if (!ladderOffers[dealId][seller]) return dealOffers[dealId][seller].fundedUnits;
        PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
        for (uint256 i = 0; i < tiers.length; i++) {
            if (tiers[i].active && tiers[i].price == deal.bestPrice) return tiers[i].fundedUnits;
        }
        return 0;
    }

    function _maybeOpenFinalBiddingWindow(string calldata dealId) internal {
        Deal storage deal = deals[dealId];
        uint256 fundedUnits = _bestOfferFundedUnits(dealId, deal);
        // A full low-price seller must not freeze the market when another
        // live or future offer can carry more units. Let the market move to
        // that backup offer instead of closing at the smaller capacity.
        address[] storage sellers = dealOfferSellers[dealId];
        for (uint256 i = 0; i < sellers.length; i++) {
            address seller = sellers[i];
            if (seller == deal.bestSeller || sellerRevoked[seller]) continue;
            if (ladderOffers[dealId][seller]) {
                PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
                for (uint256 j = 0; j < tiers.length; j++) {
                    if (tiers[j].active && (tiers[j].offerExpiry == 0 || block.timestamp <= tiers[j].offerExpiry) && tiers[j].maxBuyerUnits > fundedUnits) return;
                }
            } else {
                ConditionalOffer storage offer = dealOffers[dealId][seller];
                if (offer.active && (offer.offerExpiry == 0 || block.timestamp <= offer.offerExpiry) && offer.maxBuyerUnits > fundedUnits) return;
            }
        }
        if (deal.finalBiddingEndsAt == 0
            // A seller threshold only unlocks a price. It must never be able
            // to pull the close point forward. The only early close trigger
            // is the selected offer's actual capacity being fully funded.
            && deal.maxBuyerUnits > 0
            && fundedUnits >= deal.maxBuyerUnits
            && deal.bestPrice > 0
            && ladderOffers[dealId][deal.bestSeller]) {
            deal.finalBiddingEndsAt = block.timestamp + FINAL_BIDDING_WINDOW;
            emit FinalBiddingWindowOpened(dealId, deal.finalBiddingEndsAt, fundedUnits, block.timestamp);
        }
    }

    function _hasUnexpiredTier(string calldata dealId, PriceTier[] storage tiers) internal view returns (bool) {
        uint256 deadline = marketDeadlines[dealId];
        uint256 effectiveNow = deadline > 0 && block.timestamp > deadline ? deadline : block.timestamp;
        for (uint256 i = 0; i < tiers.length; i++) {
            if (tiers[i].active && (tiers[i].offerExpiry == 0 || effectiveNow <= tiers[i].offerExpiry)) return true;
        }
        return false;
    }

    function _wasLiveAtDealClose(string calldata dealId, uint256 offerExpiry) internal view returns (bool) {
        uint256 deadline = marketDeadlines[dealId];
        return deadline > 0 && block.timestamp > deadline && offerExpiry >= deadline;
    }

    function _releaseOffer(string calldata dealId, address seller, string memory reason) internal {
        if (ladderOffers[dealId][seller]) {
            uint256 ladderBond = sellerGuarantees[dealId][seller];
            PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
            for (uint256 i = 0; i < tiers.length; i++) tiers[i].active = false;
            ladderOffers[dealId][seller] = false;
            ConditionalOffer storage ladderSummary = dealOffers[dealId][seller];
            ladderSummary.active = false;
            ladderSummary.guaranteeBond = 0;
            sellerGuarantees[dealId][seller] = 0;
            if (ladderBond > 0) _pushMemo(seller, ladderBond, _marketMemo(dealId, "ladder-release"), dealId, "ladder-release");
            emit OfferDeactivated(dealId, seller, reason, block.timestamp);
            return;
        }
        ConditionalOffer storage offer = dealOffers[dealId][seller];
        uint256 bond = offer.guaranteeBond;
        if (!offer.active && bond == 0) return;
        offer.active = false;
        offer.guaranteeBond = 0;
        sellerGuarantees[dealId][seller] = 0;
        if (bond > 0) _pushMemo(seller, bond, _marketMemo(dealId, "offer-release"), dealId, "offer-release");
        emit OfferDeactivated(dealId, seller, reason, block.timestamp);
    }

    function _releaseOtherOffers(string calldata dealId, address winner, string memory reason) internal {
        address[] storage sellers = dealOfferSellers[dealId];
        for (uint256 i = 0; i < sellers.length; i++) {
            if (sellers[i] != winner) _releaseOffer(dealId, sellers[i], reason);
        }
    }

    function _releaseAllOffers(string calldata dealId, string memory reason) internal {
        address[] storage sellers = dealOfferSellers[dealId];
        for (uint256 i = 0; i < sellers.length; i++) {
            _releaseOffer(dealId, sellers[i], reason);
        }
    }

    // Seller slots are a limit on active offers, not a permanent lifetime
    // quota. Expired, released and revoked sellers must not be able to block
    // a new seller from entering the same market forever.
    function _activeDealSellerSlots(string calldata dealId) internal view returns (uint256 activeSlots) {
        address[] storage sellers = dealOfferSellers[dealId];
        for (uint256 i = 0; i < sellers.length; i++) {
            address seller = sellers[i];
            if (sellerRevoked[seller]) continue;
            if (ladderOffers[dealId][seller]) {
                PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
                bool activeLadder;
                for (uint256 j = 0; j < tiers.length; j++) {
                    if (tiers[j].active) {
                        activeLadder = true;
                        break;
                    }
                }
                if (activeLadder) activeSlots += 1;
            } else if (dealOffers[dealId][seller].active) {
                activeSlots += 1;
            }
        }
    }

    // The cheapest offer is only a winner when its threshold, capacity and
    // expiry are valid for today's order. A future cheap offer stays stored and
    // cannot erase a currently usable offer.
    function _refreshBestOffer(string calldata dealId) internal {
        Deal storage deal = deals[dealId];
        address candidate;
        uint256 candidatePrice = type(uint256).max;
        address[] storage sellers = dealOfferSellers[dealId];
        for (uint256 i = 0; i < sellers.length; i++) {
            address seller = sellers[i];
            if (ladderOffers[dealId][seller]) {
                PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
                uint256 sellerPrice;
                uint256 sellerMinimum;
                uint256 sellerCapacity;
                uint256 sellerExpiry;
                for (uint256 j = 0; j < tiers.length; j++) {
                    PriceTier storage tier = tiers[j];
                    if (tier.active && tier.offerExpiry > 0 && block.timestamp > tier.offerExpiry && !_wasLiveAtDealClose(dealId, tier.offerExpiry)) {
                        tier.active = false;
                        emit OfferExpired(dealId, seller, block.timestamp);
                        continue;
                    }
                    if (_tierIsLive(dealId, seller, tier) && (sellerPrice == 0 || tier.price < sellerPrice)) {
                        sellerPrice = tier.price;
                        sellerMinimum = tier.minimumBuyerCount;
                        sellerCapacity = tier.maxBuyerUnits;
                        sellerExpiry = tier.offerExpiry;
                    }
                }
                if (!_hasUnexpiredTier(dealId, tiers)) {
                    _releaseOffer(dealId, seller, "LADDER_EXPIRED");
                    continue;
                }
                ConditionalOffer storage ladderSummary = dealOffers[dealId][seller];
                uint256 previousLadderPrice = ladderSummary.price;
                ladderSummary.price = sellerPrice;
                ladderSummary.guaranteeBond = sellerGuarantees[dealId][seller];
                ladderSummary.maxBuyerUnits = sellerCapacity;
                ladderSummary.offerExpiry = sellerExpiry;
                ladderSummary.minimumBuyerCount = sellerMinimum;
                ladderSummary.active = sellerPrice > 0;
                if (sellerPrice > 0 && sellerPrice != previousLadderPrice) emit PriceTierActivated(dealId, seller, sellerPrice, sellerMinimum, block.timestamp);
                if (sellerPrice > 0 && sellerPrice < candidatePrice) {
                    candidate = seller;
                    candidatePrice = sellerPrice;
                }
                continue;
            }
            ConditionalOffer storage offer = dealOffers[dealId][seller];
            if (offer.active && offer.offerExpiry > 0 && block.timestamp > offer.offerExpiry && !_wasLiveAtDealClose(dealId, offer.offerExpiry)) {
                uint256 expiredBond = offer.guaranteeBond;
                offer.active = false;
                offer.guaranteeBond = 0;
                sellerGuarantees[dealId][seller] = 0;
                if (expiredBond > 0) _pushMemo(seller, expiredBond, _marketMemo(dealId, "offer-expiry"), dealId, "offer-expiry");
                emit OfferExpired(dealId, seller, block.timestamp);
                continue;
            }
            if (_offerIsLive(dealId, seller, offer, deal) && offer.price < candidatePrice) {
                candidate = seller;
                candidatePrice = offer.price;
            }
        }

        if (candidate == address(0)) {
            deal.bestPrice = 0;
            deal.bestSeller = address(0);
            deal.maxBuyerUnits = 0;
            deal.offerExpiry = 0;
            deal.minimumBuyerCount = 0;
            return;
        }

        ConditionalOffer storage winning = dealOffers[dealId][candidate];
        deal.bestPrice = winning.price;
        deal.bestSeller = candidate;
        deal.maxBuyerUnits = winning.maxBuyerUnits;
        deal.offerExpiry = winning.offerExpiry;
        deal.minimumBuyerCount = winning.minimumBuyerCount;
        deal.sellerGuaranteeBond = winning.guaranteeBond;
        _maybeOpenFinalBiddingWindow(dealId);
    }

    // 1. CONSUMER GROUP DEALS
    function joinDeal(string calldata dealId, uint256 depositAmount) external nonReentrant returns (bool) {
        return _joinDeal(dealId, depositAmount, 1);
    }

    function joinDealUnits(string calldata dealId, uint256 depositAmount, uint256 units) external nonReentrant returns (bool) {
        return _joinDeal(dealId, depositAmount, units);
    }

    function _joinDeal(string calldata dealId, uint256 depositAmount, uint256 units) internal returns (bool) {
        require(depositAmount >= MIN_BUYER_COMMITMENT && units > 0 && units <= MAX_UNITS_PER_BUYER, "COMMITMENT_TOO_SMALL");
        Deal storage deal = deals[dealId];
        _ensureMarketDeadline(dealId, "deal");
        _requireBefore(marketDeadlines[dealId]);
        _refreshBestOffer(dealId);
        // Once the final bidding window opens, no additional buyer funding is
        // allowed; only sellers may continue improving the offer.
        require(deal.finalBiddingEndsAt == 0, "FINAL_BIDDING_LOCKED");
        require(deal.bestPrice == 0 || depositAmount >= deal.bestPrice, "BELOW_BEST_PRICE");
        require(!deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        require(buyerDeposits[dealId][msg.sender] == 0, "BUYER_ALREADY_JOINED");
        require(dealBuyers[dealId].length < MAX_MARKET_BUYERS, "BUYER_LIMIT_REACHED");

        uint256 totalDeposit = depositAmount * units;
        _pull(msg.sender, totalDeposit);

        dealBuyers[dealId].push(msg.sender);
        buyerDeposits[dealId][msg.sender] = totalDeposit;
        buyerUnits[dealId][msg.sender] = units;
        deal.buyersCount += 1;
        deal.totalEscrow += totalDeposit;
        deal.committedUnits += units;
        _updateOfferFunding(dealId, units, 0, totalDeposit);

        // The buyer who just joined may activate a threshold offer immediately.
        // Do this after recording the deposit so the current price is never one
        // step behind the funded state.
        _refreshBestOffer(dealId);

        emit DealJoined(
            dealId,
            msg.sender,
            totalDeposit,
            totalDeposit,
            deal.buyersCount,
            block.timestamp
        );
        return true;
    }

    function submitOfferWithCapacity(
        string calldata dealId,
        string calldata sellerName,
        uint256 price,
        uint256 guaranteeBond,
        uint256 minimumBuyerCount,
        uint256 maxBuyerUnits,
        uint256 offerExpiry
    ) external nonReentrant returns (bool) {
        return _submitOffer(dealId, sellerName, price, guaranteeBond, minimumBuyerCount, maxBuyerUnits, offerExpiry);
    }

    // A seller can publish the whole commercial schedule once. Buyers fund at
    // their accepted maximum; when a tier's buyer threshold is reached,
    // _refreshBestOffer makes that lower price the active deal price and the
    // surplus becomes refundable. One guarantee bond protects the full ladder.
    function submitPriceLadder(
        string calldata dealId,
        uint256[] calldata prices,
        uint256[] calldata minimumBuyerCounts,
        uint256 maxBuyerUnits,
        uint256 offerExpiry,
        uint256 guaranteeBond
    ) external nonReentrant returns (bool) {
        require(!sellerRevoked[msg.sender], "SELLER_REVOKED");
        _validatePriceLadder(prices, minimumBuyerCounts, maxBuyerUnits, offerExpiry, guaranteeBond);
        Deal storage deal = deals[dealId];
        _ensureMarketDeadline(dealId, "deal");
        _requireBefore(marketDeadlines[dealId]);
        require(!deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        _refreshBestOffer(dealId);
        // The final window closes new buyer funding, not seller competition.
        // Sellers may still publish a better valid ladder until the window ends.
        require(deal.finalBiddingEndsAt == 0 || block.timestamp < deal.finalBiddingEndsAt, "FINAL_BIDDING_LOCKED");
        require(!ladderOffers[dealId][msg.sender], "SELLER_ALREADY_OFFERED");
        ConditionalOffer storage existing = dealOffers[dealId][msg.sender];
        require(!existing.active && existing.guaranteeBond == 0, "SELLER_ALREADY_OFFERED");
        require(dealOfferSellerSeen[dealId][msg.sender] || _activeDealSellerSlots(dealId) < MAX_OFFER_SELLERS, "SELLER_LIMIT_REACHED");
        _storePriceLadder(dealId, prices, minimumBuyerCounts, maxBuyerUnits, offerExpiry, guaranteeBond);
        _refreshBestOffer(dealId);
        emit PriceLadderSubmitted(dealId, msg.sender, guaranteeBond, prices.length, block.timestamp);
        return true;
    }

    function _storePriceLadder(
        string calldata dealId,
        uint256[] calldata prices,
        uint256[] calldata minimumBuyerCounts,
        uint256 maxBuyerUnits,
        uint256 offerExpiry,
        uint256 guaranteeBond
    ) internal {
        _pull(msg.sender, guaranteeBond);
        delete dealPriceTiers[dealId][msg.sender];
        if (!dealOfferSellerSeen[dealId][msg.sender]) {
            dealOfferSellers[dealId].push(msg.sender);
            dealOfferSellerSeen[dealId][msg.sender] = true;
        }
        ladderOffers[dealId][msg.sender] = true;
        sellerGuarantees[dealId][msg.sender] = guaranteeBond;
        for (uint256 i = 0; i < prices.length; i++) {
            (uint256 fundedCount, uint256 fundedUnits) = _fundedBuyerCount(dealId, prices[i]);
            dealPriceTiers[dealId][msg.sender].push(PriceTier({
                price: prices[i],
                minimumBuyerCount: minimumBuyerCounts[i],
                maxBuyerUnits: maxBuyerUnits,
                offerExpiry: offerExpiry,
                fundedBuyerCount: uint16(fundedCount),
                fundedUnits: uint16(fundedUnits),
                active: true
            }));
        }
    }

    function _validatePriceLadder(
        uint256[] calldata prices,
        uint256[] calldata minimumBuyerCounts,
        uint256 maxBuyerUnits,
        uint256 offerExpiry,
        uint256 guaranteeBond
    ) internal view {
        require(prices.length > 0 && prices.length <= 8 && prices.length == minimumBuyerCounts.length, "INVALID_LADDER");
        require(maxBuyerUnits > 0 && guaranteeBond >= MIN_SELLER_BOND, "INVALID_LADDER");
        require(guaranteeBond >= _requiredSellerBond(prices[0], maxBuyerUnits), "SELLER_BOND_TOO_SMALL");
        require(offerExpiry == 0 || offerExpiry > block.timestamp, "INVALID_EXPIRY");
        uint256 previousPrice;
        uint256 previousMinimum;
        for (uint256 i = 0; i < prices.length; i++) {
            require(prices[i] > 0 && prices[i] <= maxOfferPrice && minimumBuyerCounts[i] > 0 && minimumBuyerCounts[i] <= maxBuyerUnits, "INVALID_LADDER");
            if (i > 0) require(prices[i] < previousPrice && minimumBuyerCounts[i] > previousMinimum, "LADDER_NOT_DESCENDING");
            previousPrice = prices[i];
            previousMinimum = minimumBuyerCounts[i];
        }
    }

    function _requiredSellerBond(uint256 price, uint256 maxBuyerUnits) internal pure returns (uint256) {
        uint256 proportional = (price * maxBuyerUnits * MIN_SELLER_BOND_BPS) / 10_000;
        return proportional > MIN_SELLER_BOND ? proportional : MIN_SELLER_BOND;
    }

    function _submitOffer(
        string calldata dealId,
        string calldata sellerName,
        uint256 price,
        uint256 guaranteeBond,
        uint256 minimumBuyerCount,
        uint256 maxBuyerUnits,
        uint256 offerExpiry
    ) internal returns (bool) {
        require(!sellerRevoked[msg.sender], "SELLER_REVOKED");
        require(price > 0 && price <= maxOfferPrice && guaranteeBond >= MIN_SELLER_BOND && minimumBuyerCount > 0 && maxBuyerUnits > 0, "INVALID_OFFER");
        require(offerExpiry == 0 || offerExpiry > block.timestamp, "INVALID_EXPIRY");
        Deal storage deal = deals[dealId];
        _ensureMarketDeadline(dealId, "deal");
        _requireBefore(marketDeadlines[dealId]);
        require(!deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        _refreshBestOffer(dealId);
        // The final window closes new buyer funding, not seller competition.
        // Sellers may still publish a better valid offer until the window ends.
        require(deal.finalBiddingEndsAt == 0 || block.timestamp < deal.finalBiddingEndsAt, "FINAL_BIDDING_LOCKED");
        require(maxBuyerUnits >= minimumBuyerCount, "CAPACITY_BELOW_THRESHOLD");
        require(guaranteeBond >= _requiredSellerBond(price, maxBuyerUnits), "SELLER_BOND_TOO_SMALL");
        ConditionalOffer storage existing = dealOffers[dealId][msg.sender];
        require(!existing.active && existing.guaranteeBond == 0, "SELLER_ALREADY_OFFERED");
        require(dealOfferSellerSeen[dealId][msg.sender] || _activeDealSellerSlots(dealId) < MAX_OFFER_SELLERS, "SELLER_LIMIT_REACHED");
        // A future conditional offer may be above today's price. It only has
        // to beat the current winner once its buyer threshold is actually met.
        (uint256 fundedCountAtPrice, uint256 fundedUnitsAtPrice) = _fundedBuyerCount(dealId, price);
        if (deal.bestPrice > 0 && minimumBuyerCount <= fundedCountAtPrice) {
            require(price < deal.bestPrice, "MUST_UNDERCUT");
        }

        _pull(msg.sender, guaranteeBond);
        if (!dealOfferSellerSeen[dealId][msg.sender]) {
            dealOfferSellers[dealId].push(msg.sender);
            dealOfferSellerSeen[dealId][msg.sender] = true;
        }
        existing.price = price;
        existing.guaranteeBond = guaranteeBond;
        existing.maxBuyerUnits = maxBuyerUnits;
        existing.offerExpiry = offerExpiry;
        existing.minimumBuyerCount = minimumBuyerCount;
        existing.fundedBuyerCount = uint16(fundedCountAtPrice);
        existing.fundedUnits = uint16(fundedUnitsAtPrice);
        existing.active = true;
        sellerGuarantees[dealId][msg.sender] = guaranteeBond;
        _refreshBestOffer(dealId);

        emit OfferSubmitted(dealId, msg.sender, sellerName, price, guaranteeBond, minimumBuyerCount, block.timestamp);
        emit OfferCapacityUpdated(dealId, msg.sender, maxBuyerUnits, offerExpiry, block.timestamp);
        return true;
    }

    function topUpDeal(string calldata dealId, uint256 amount) external nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        _requireBefore(marketDeadlines[dealId]);
        require(deal.bestPrice > 0 && !deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        uint256 current = buyerDeposits[dealId][msg.sender];
        uint256 units = buyerUnits[dealId][msg.sender];
        require(current > 0 && units > 0, "BUYER_NOT_JOINED");
        uint256 required = units * deal.bestPrice;
        require(current < required && amount == required - current, "EXACT_TOP_UP_REQUIRED");
        _pull(msg.sender, amount);
        _updateOfferFunding(dealId, units, current, required);
        buyerDeposits[dealId][msg.sender] = required;
        deal.totalEscrow += amount;
        // A top-up can complete the selected seller capacity. Recompute the
        // active tier now so the final bidding window opens immediately,
        // instead of waiting for an unrelated buyer or seller transaction.
        _refreshBestOffer(dealId);
        emit DealFunded(dealId, msg.sender, amount, required, block.timestamp);
        return true;
    }

    function settleDeal(string calldata dealId) external onlyOwner nonReentrant returns (bool) {
        return _settleDeal(dealId, false);
    }

    // There is one deadline decision: lock the best fully funded offer when
    // one exists; otherwise start the buyer refund. The owner and the
    // permissionless compatibility entry points below all use this same
    // decision so a late refund cannot race a valid settlement.
    function finalizeDealAfterDeadline(string calldata dealId, string calldata reason) external nonReentrant returns (bool) {
        return _finalizeDealAfterDeadline(dealId, reason);
    }

    function settleDealAfterDeadline(string calldata dealId) external onlyOwner nonReentrant returns (bool) {
        return _finalizeDealAfterDeadline(dealId, "Deadline settlement");
    }

    function _finalizeDealAfterDeadline(string calldata dealId, string memory reason) internal returns (bool) {
        uint256 deadline = marketDeadlines[dealId];
        require(deadline > 0 && block.timestamp > deadline, "DEADLINE_NOT_REACHED");
        Deal storage deal = deals[dealId];
        require(!deal.isSettled && !deal.isRefunded && refundTotals[dealId] == 0, "DEAL_CLOSED");
        _refreshBestOffer(dealId);
        (uint256 fundedCount, uint256 fundedUnits) = _fundedBuyerCount(dealId, deal.bestPrice);
        bool canSettle = deal.bestSeller != address(0)
            && deal.bestPrice > 0
            && fundedCount >= deal.minimumBuyerCount
            && fundedUnits > 0
            && deal.maxBuyerUnits >= fundedUnits
            && deal.totalEscrow >= fundedUnits * deal.bestPrice;
        if (canSettle) return _settleDeal(dealId, true);
        return _startDeadlineRefund(dealId, reason);
    }

    function _settleDeal(string calldata dealId, bool afterDeadline) internal returns (bool) {
        Deal storage deal = deals[dealId];
        uint256 deadline = marketDeadlines[dealId];
        if (!afterDeadline) {
            // A published seller tier is a price condition, not a promise
            // that buyers must reach that tier before the order can close.
            // Before a deadline, only an explicitly opened final window may
            // close the order early; otherwise the deadline is the close point.
            if (deadline > 0 && block.timestamp > deadline) revert("USE_DEADLINE_SETTLEMENT");
            if (deal.finalBiddingEndsAt == 0 && deadline > 0) require(block.timestamp >= deadline, "DEADLINE_NOT_REACHED");
        }
        _refreshBestOffer(dealId);
        require(!deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        require(deal.finalBiddingEndsAt == 0 || block.timestamp >= deal.finalBiddingEndsAt, "FINAL_BIDDING_OPEN");
        // A buyer who never completed the selected price is not allowed to
        // hold the funded group hostage. Return that partial commitment first,
        // then lock the remaining funded order.
        address[] storage buyers = dealBuyers[dealId];
        for (uint256 i = 0; i < buyers.length; ) {
            if (!_removeUnfundedBuyer(dealId, deal, buyers[i], deal.bestPrice)) {
                i++;
            }
        }
        _refreshBestOffer(dealId);
        require(deal.bestSeller != address(0) && deal.buyersCount > 0, "INVALID_STATE");
        (uint256 fundedCount, uint256 fundedUnits) = _fundedBuyerCount(dealId, deal.bestPrice);
        require(fundedCount >= deal.minimumBuyerCount, "MIN_BUYERS_NOT_REACHED");
        require(deal.maxBuyerUnits >= fundedUnits, "SELLER_CAPACITY_REACHED");

        uint256 totalUnits;
        address[] storage fundedBuyers = dealBuyers[dealId];
        for (uint256 i = 0; i < fundedBuyers.length; i++) {
            totalUnits += buyerUnits[dealId][fundedBuyers[i]];
        }
        uint256 grossVolume = totalUnits * deal.bestPrice;
        require(deal.totalEscrow >= grossVolume, "INSUFFICIENT_ESCROW");

        uint256 platformFee = grossVolume / 100;
        uint256 netSellerPayout = grossVolume - platformFee;
        // The purchase amount stays in escrow until fulfillment. Only the
        // surplus is returned in disburseSurplusBatch; payout and fee are
        // released atomically by confirmDealFulfillment.
        // Non-winning offers are no longer needed once the price is locked.
        // Return their bonds, while keeping the winning bond in escrow until
        // delivery is confirmed.
        _releaseOtherOffers(dealId, deal.bestSeller, "PRICE_LOCKED");
        deal.isSettled = true;
        dealStatus[dealId] = DealStatus.AWAITING_FULFILLMENT;
        deal.sellerPayout = netSellerPayout;
        deal.platformFee = platformFee;
        deal.settledGrossVolume = grossVolume;
        deal.fulfillmentDeadline = block.timestamp + DEFAULT_FULFILLMENT_WINDOW;

        emit DealPriceLocked(dealId, deal.bestSeller, deal.bestPrice, grossVolume, platformFee, block.timestamp);
        emit DealStatusChanged(dealId, DealStatus.AWAITING_FULFILLMENT, block.timestamp);
        return true;
    }

    function _removeUnfundedBuyer(string calldata dealId, Deal storage deal, address buyer, uint256 price) internal returns (bool) {
        uint256 deposited = buyerDeposits[dealId][buyer];
        uint256 units = buyerUnits[dealId][buyer];
        if (deposited == 0 || units == 0 || deposited >= units * price) return false;
        _updateOfferFunding(dealId, units, deposited, 0);
        _removeBuyerFromDeal(dealId, buyer);
        buyerDeposits[dealId][buyer] = 0;
        buyerUnits[dealId][buyer] = 0;
        deal.buyersCount -= 1;
        deal.committedUnits -= units;
        deal.totalEscrow -= deposited;
        _pushMemo(buyer, deposited, _marketMemo(dealId, "underfunded-refund"), dealId, "underfunded-refund");
        emit BuyerRefunded(dealId, buyer, deposited, block.timestamp);
        return true;
    }

    // This explicit cleanup is available before the deadline as well. The
    // normal settlement path performs the same cleanup automatically.
    function removeUnfundedDealBuyers(string calldata dealId, address[] calldata recipients) external onlyOwner nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        require(!deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        _refreshBestOffer(dealId);
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _removeUnfundedBuyer(dealId, deal, recipients[i], deal.bestPrice);
        }
        _refreshBestOffer(dealId);
        return true;
    }

    // Legacy deadline-named entry point remains for existing clients, but the
    // cleanup itself is also available before the deadline through the method
    // above.
    function removeUnfundedDealBuyersAfterDeadline(string calldata dealId, address[] calldata recipients) external nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        uint256 deadline = marketDeadlines[dealId];
        require(deadline > 0 && block.timestamp > deadline, "DEADLINE_NOT_REACHED");
        require(!deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        _refreshBestOffer(dealId);
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _removeUnfundedBuyer(dealId, deal, recipients[i], deal.bestPrice);
        }
        _refreshBestOffer(dealId);
        return true;
    }

    function confirmDealFulfillment(string calldata dealId) external onlyOwner nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        require(deal.isSettled && !deal.isRefunded, "NOT_SETTLED");
        require(deal.fulfillmentDeadline == 0 || block.timestamp <= deal.fulfillmentDeadline, "FULFILLMENT_DEADLINE_PASSED");
        uint256 bond = deal.sellerGuaranteeBond;
        require(bond > 0 && deal.bestSeller != address(0), "NO_BOND");
        address seller = deal.bestSeller;
        uint256 sellerPayout = deal.sellerPayout;
        uint256 platformFee = deal.platformFee;
        require(sellerPayout + platformFee > 0 && deal.totalEscrow >= sellerPayout + platformFee, "NO_SETTLEMENT_FUNDS");
        // The seller and fee can only be released after every funded buyer's
        // surplus has been returned. Otherwise direct contract callers could
        // clear buyer accounting while leaving excess escrow stranded.
        address[] storage buyers = dealBuyers[dealId];
        for (uint256 i = 0; i < buyers.length; i++) {
            uint256 units = buyerUnits[dealId][buyers[i]];
            // Underfunded buyers are removed from the active accounting during
            // settlement, but their address remains in the historical buyer
            // list. They have no remaining claim and must not block fulfillment
            // for the fully funded buyers who remain in the order.
            if (units == 0) continue;
            require(units > 0 && buyerDeposits[dealId][buyers[i]] == units * deal.bestPrice, "BUYER_SURPLUS_PENDING");
        }
        require(deal.totalEscrow == sellerPayout + platformFee, "BUYER_SURPLUS_PENDING");
        deal.totalEscrow -= sellerPayout + platformFee;
        deal.sellerPayout = 0;
        deal.platformFee = 0;
        deal.sellerGuaranteeBond = 0;
        dealStatus[dealId] = DealStatus.COMPLETED;
        sellerGuarantees[dealId][seller] = 0;
        dealOffers[dealId][seller].active = false;
        dealOffers[dealId][seller].guaranteeBond = 0;
        if (ladderOffers[dealId][seller]) {
            PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
            for (uint256 i = 0; i < tiers.length; i++) tiers[i].active = false;
            ladderOffers[dealId][seller] = false;
        }
        bytes32 settlementMemo = _marketMemo(dealId, "settlement");
        _pushMemo(seller, sellerPayout, settlementMemo, dealId, "settlement");
        _pushMemo(treasury, platformFee, settlementMemo, dealId, "settlement");
        bytes32 memo = _marketMemo(dealId, "fulfillment");
        _pushMemo(seller, bond, memo, dealId, "fulfillment");
        // A completed order has no remaining buyer claim. Clear the per-buyer
        // accounting now that the seller payout and platform fee are final.
        for (uint256 i = 0; i < buyers.length; i++) {
            buyerDeposits[dealId][buyers[i]] = 0;
            buyerUnits[dealId][buyers[i]] = 0;
        }
        emit DealBuyerAccountingCleared(dealId, buyers.length, block.timestamp);
        emit FulfillmentPaymentReleased(dealId, seller, sellerPayout, platformFee, block.timestamp);
        emit DealStatusChanged(dealId, DealStatus.COMPLETED, block.timestamp);
        return true;
    }

    function slashSettledDealGuarantee(string calldata dealId, string calldata reason) external onlyOwner nonReentrant returns (bool) {
        return _slashSettledDealGuarantee(dealId, reason);
    }

    function refundDealAfterFulfillmentDeadline(string calldata dealId, string calldata reason) external nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        require(deal.isSettled && !deal.isRefunded, "NOT_SETTLED");
        require(deal.fulfillmentDeadline > 0 && block.timestamp > deal.fulfillmentDeadline, "FULFILLMENT_DEADLINE_NOT_REACHED");
        return _slashSettledDealGuarantee(dealId, reason);
    }

    function _slashSettledDealGuarantee(string calldata dealId, string calldata reason) internal returns (bool) {
        Deal storage deal = deals[dealId];
        require(deal.isSettled && !deal.isRefunded, "NOT_SETTLED");
        uint256 bond = deal.sellerGuaranteeBond;
        require(bond > 0 && deal.bestSeller != address(0), "NO_BOND");
        address seller = deal.bestSeller;
        deal.sellerGuaranteeBond = 0;
        sellerGuarantees[dealId][seller] = 0;
        dealOffers[dealId][seller].active = false;
        dealOffers[dealId][seller].guaranteeBond = 0;
        if (ladderOffers[dealId][seller]) {
            PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
            for (uint256 i = 0; i < tiers.length; i++) tiers[i].active = false;
            ladderOffers[dealId][seller] = false;
        }
        // A failed settled seller never receives the held order payout. The
        // owner can then refund the buyers through refundBatch.
        // The seller bond is separate from buyer escrow. It was never added
        // to totalEscrow, so it must not be subtracted from buyer funds when
        // a seller fails after price lock.
        deal.sellerPayout = 0;
        deal.platformFee = 0;
        refundTotals[dealId] = deal.totalEscrow;
        dealStatus[dealId] = DealStatus.REFUNDING;
        _push(treasury, bond);
        emit RefundInitiated(dealId, reason, deal.totalEscrow, block.timestamp);
        emit GuaranteeSlashed(dealId, seller, bond, reason, block.timestamp);
        return true;
    }

    function _disburseBuyerSurplus(string calldata dealId, Deal storage deal, address buyer) internal {
        uint256 deposited = buyerDeposits[dealId][buyer];
        uint256 units = buyerUnits[dealId][buyer];
        if (units == 0) units = 1;
        uint256 targetCost = units * deal.bestPrice;
        if (deposited > targetCost) {
            uint256 surplus = deposited - targetCost;
            if (deal.totalEscrow >= surplus) {
                buyerDeposits[dealId][buyer] = targetCost;
                deal.totalEscrow -= surplus;
                bytes32 memo = _marketMemo(dealId, "settlement-surplus");
                _pushMemo(buyer, surplus, memo, dealId, "settlement-surplus");
                emit BuyerRefunded(dealId, buyer, surplus, block.timestamp);
            }
        }
    }

    function disburseSurplusBatch(string calldata dealId, address[] calldata recipients) external onlyOwnerOrExpired(marketDeadlines[dealId]) nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        require(deal.isSettled, "NOT_SETTLED");
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _disburseBuyerSurplus(dealId, deal, recipients[i]);
        }
        return true;
    }

    function refundDeal(string calldata dealId, string calldata reason) external onlyOwner nonReentrant returns (bool) {
        return _finalizeDealAfterDeadline(dealId, reason);
    }

    function refundDealAfterDeadline(string calldata dealId, string calldata reason) external nonReentrant returns (bool) {
        return _finalizeDealAfterDeadline(dealId, reason);
    }

    function _startDeadlineRefund(string calldata dealId, string memory reason) internal returns (bool) {
        Deal storage deal = deals[dealId];
        uint256 deadline = marketDeadlines[dealId];
        require(deadline > 0 && block.timestamp > deadline, "DEADLINE_NOT_REACHED");
        require(!deal.isSettled && !deal.isRefunded && refundTotals[dealId] == 0, "DEAL_CLOSED");

        uint256 escrowSnapshot = deal.totalEscrow;
        refundTotals[dealId] = escrowSnapshot;
        _releaseAllOffers(dealId, "REFUNDED_AFTER_DEADLINE");
        deal.sellerGuaranteeBond = 0;
        emit RefundInitiated(dealId, reason, escrowSnapshot, block.timestamp);
        if (escrowSnapshot == 0) {
            deal.isRefunded = true;
            dealStatus[dealId] = DealStatus.REFUNDED;
            emit DealRefunded(dealId, reason, escrowSnapshot, block.timestamp);
        } else {
            dealStatus[dealId] = DealStatus.REFUNDING;
        }
        emit DealStatusChanged(dealId, dealStatus[dealId], block.timestamp);
        return true;
    }

    function _refundSingleBuyer(string calldata dealId, Deal storage deal, address recipient) internal {
        uint256 amount = buyerDeposits[dealId][recipient];
        if (amount > 0) {
            buyerDeposits[dealId][recipient] = 0;
            buyerUnits[dealId][recipient] = 0;
            if (deal.totalEscrow >= amount) {
                deal.totalEscrow -= amount;
            }
            bytes32 memo = _marketMemo(dealId, "refund");
            _pushMemo(recipient, amount, memo, dealId, "refund");
            emit BuyerRefunded(dealId, recipient, amount, block.timestamp);
        }
    }

    function refundBatch(string calldata dealId, address[] calldata recipients) external onlyOwnerOrExpired(marketDeadlines[dealId]) nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        require(refundTotals[dealId] > 0 && !deal.isRefunded, "NOT_REFUNDING");
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _refundSingleBuyer(dealId, deal, recipients[i]);
        }
        if (deal.totalEscrow == 0) {
            deal.isRefunded = true;
            dealStatus[dealId] = DealStatus.REFUNDED;
            emit DealRefunded(dealId, "", refundTotals[dealId], block.timestamp);
            emit DealStatusChanged(dealId, DealStatus.REFUNDED, block.timestamp);
        }
        return true;
    }

    function slashSellerGuarantee(string calldata dealId, string calldata reason) external onlyOwner nonReentrant returns (bool) {
        Deal storage deal = deals[dealId];
        require(!deal.isSettled && !deal.isRefunded, "DEAL_CLOSED");
        uint256 bond = deal.sellerGuaranteeBond;
        require(bond > 0 && deal.bestSeller != address(0), "NO_BOND");
        address failedSeller = deal.bestSeller;
        ConditionalOffer storage failedOffer = dealOffers[dealId][failedSeller];
        failedOffer.active = false;
        failedOffer.guaranteeBond = 0;
        sellerGuarantees[dealId][failedSeller] = 0;
        deal.sellerGuaranteeBond = 0;
        deal.finalBiddingEndsAt = 0;
        if (ladderOffers[dealId][failedSeller]) {
            PriceTier[] storage failedTiers = dealPriceTiers[dealId][failedSeller];
            for (uint256 i = 0; i < failedTiers.length; i++) failedTiers[i].active = false;
            ladderOffers[dealId][failedSeller] = false;
        }
        _push(treasury, bond);
        emit OfferDeactivated(dealId, failedSeller, "SELLER_FAILED", block.timestamp);
        emit GuaranteeSlashed(dealId, failedSeller, bond, reason, block.timestamp);
        _refreshBestOffer(dealId);
        return true;
    }

    // 2. BUSINESS BULK PURCHASING POOLS
    function joinBusinessPool(string calldata poolId, uint256 commitmentAmount) external nonReentrant returns (bool) {
        require(commitmentAmount >= MIN_BUYER_COMMITMENT, "COMMITMENT_TOO_SMALL");
        BusinessPool storage pool = businessPools[poolId];
        _ensureMarketDeadline(poolId, "business");
        _requireBefore(businessDeadlines[poolId]);
        require(!pool.isSettled && !pool.isRefunded, "POOL_CLOSED");
        require(businessDeposits[poolId][msg.sender] == 0, "BUSINESS_ALREADY_JOINED");
        require(businessBuyers[poolId].length < MAX_MARKET_BUYERS, "BUYER_LIMIT_REACHED");

        _pull(msg.sender, commitmentAmount);

        businessBuyers[poolId].push(msg.sender);
        pool.buyersCount += 1;
        businessDeposits[poolId][msg.sender] += commitmentAmount;
        pool.totalDemand += commitmentAmount;

        emit BusinessPoolJoined(poolId, msg.sender, commitmentAmount, block.timestamp);
        return true;
    }

    function _businessSupplierIsLive(string calldata poolId) internal view returns (bool) {
        BusinessPool storage pool = businessPools[poolId];
        uint256 deadline = businessDeadlines[poolId];
        uint256 effectiveNow = deadline > 0 && block.timestamp > deadline ? deadline : block.timestamp;
        return pool.bestSupplier != address(0)
            && !sellerRevoked[pool.bestSupplier]
            && businessSupplierMaxBuyers[poolId] >= pool.buyersCount
            && businessSupplierOfferExpiry[poolId] >= effectiveNow;
    }

    function _businessBackupIsLive(string calldata poolId, SupplierOffer storage offer) internal view returns (bool) {
        uint256 deadline = businessDeadlines[poolId];
        uint256 effectiveNow = deadline > 0 && block.timestamp > deadline ? deadline : block.timestamp;
        return offer.supplier != address(0)
            && !sellerRevoked[offer.supplier]
            && offer.maxBuyers >= businessPools[poolId].buyersCount
            && offer.offerExpiry >= effectiveNow;
    }

    function _releaseBusinessBackup(string calldata poolId, string memory reason) internal {
        SupplierOffer storage backup = businessBackupOffers[poolId];
        address supplier = backup.supplier;
        uint256 bond = backup.guaranteeBond;
        delete businessBackupOffers[poolId];
        if (supplier != address(0)) {
            businessSupplierGuarantees[poolId][supplier] = 0;
            if (bond > 0) _pushMemo(supplier, bond, _marketMemo(poolId, "supplier-release"), poolId, "supplier-release");
            emit OfferDeactivated(poolId, supplier, reason, block.timestamp);
        }
    }

    function _promoteBusinessBackup(string calldata poolId) internal returns (bool) {
        BusinessPool storage pool = businessPools[poolId];
        if (_businessSupplierIsLive(poolId)) return true;
        if (pool.bestSupplier != address(0)) _releaseBusinessSupplier(poolId, "SUPPLIER_OFFER_NOT_LIVE");
        SupplierOffer storage backup = businessBackupOffers[poolId];
        if (!_businessBackupIsLive(poolId, backup)) {
            if (backup.supplier != address(0)) _releaseBusinessBackup(poolId, "BACKUP_OFFER_NOT_LIVE");
            return false;
        }
        pool.bestSupplier = backup.supplier;
        pool.bestDiscountPercent = backup.value;
        pool.supplierGuaranteeBond = backup.guaranteeBond;
        businessSupplierMaxBuyers[poolId] = backup.maxBuyers;
        businessSupplierOfferExpiry[poolId] = backup.offerExpiry;
        delete businessBackupOffers[poolId];
        emit BackupSupplierPromoted(poolId, 1, pool.bestSupplier, block.timestamp);
        return true;
    }

    function _releaseBusinessSupplier(string calldata poolId, string memory reason) internal {
        BusinessPool storage pool = businessPools[poolId];
        address supplier = pool.bestSupplier;
        uint256 bond = pool.supplierGuaranteeBond;
        pool.bestSupplier = address(0);
        pool.bestDiscountPercent = 0;
        pool.supplierGuaranteeBond = 0;
        businessSupplierMaxBuyers[poolId] = 0;
        businessSupplierOfferExpiry[poolId] = 0;
        if (supplier != address(0)) {
            businessSupplierGuarantees[poolId][supplier] = 0;
            if (bond > 0) _pushMemo(supplier, bond, _marketMemo(poolId, "supplier-release"), poolId, "supplier-release");
        }
        emit OfferDeactivated(poolId, supplier, reason, block.timestamp);
    }

    function submitBusinessOffer(
        string calldata poolId,
        string calldata supplierName,
        uint256 discountPercent,
        uint256 guaranteeBond
    ) external nonReentrant returns (bool) {
        return _submitBusinessOffer(poolId, supplierName, discountPercent, guaranteeBond, MAX_MARKET_BUYERS, 0);
    }

    function submitBusinessOfferWithCapacity(
        string calldata poolId,
        string calldata supplierName,
        uint256 discountPercent,
        uint256 guaranteeBond,
        uint256 maxBuyerCount,
        uint256 offerExpiry
    ) external nonReentrant returns (bool) {
        return _submitBusinessOffer(poolId, supplierName, discountPercent, guaranteeBond, maxBuyerCount, offerExpiry);
    }

    function _submitBusinessOffer(
        string calldata poolId,
        string calldata supplierName,
        uint256 discountPercent,
        uint256 guaranteeBond,
        uint256 maxBuyerCount,
        uint256 offerExpiry
    ) internal returns (bool) {
        require(!sellerRevoked[msg.sender], "SUPPLIER_REVOKED");
        require(discountPercent > 0 && discountPercent < 100 && guaranteeBond >= MIN_SELLER_BOND && maxBuyerCount > 0, "INVALID_OFFER");
        BusinessPool storage pool = businessPools[poolId];
        _ensureMarketDeadline(poolId, "business");
        _requireBefore(businessDeadlines[poolId]);
        require(!pool.isSettled && !pool.isRefunded, "POOL_CLOSED");
        uint256 effectiveExpiry = offerExpiry == 0 ? businessDeadlines[poolId] : offerExpiry;
        require(effectiveExpiry > block.timestamp && effectiveExpiry <= businessDeadlines[poolId], "INVALID_EXPIRY");
        require(maxBuyerCount >= pool.buyersCount, "SUPPLIER_CAPACITY_REACHED");
        _promoteBusinessBackup(poolId);
        SupplierOffer storage backup = businessBackupOffers[poolId];
        if (backup.supplier != address(0) && !_businessBackupIsLive(poolId, backup)) {
            _releaseBusinessBackup(poolId, "BACKUP_OFFER_NOT_LIVE");
        }
        require(msg.sender != pool.bestSupplier && msg.sender != backup.supplier, "SUPPLIER_ALREADY_OFFERED");

        _pull(msg.sender, guaranteeBond);
        businessSupplierGuarantees[poolId][msg.sender] = guaranteeBond;
        if (pool.bestSupplier == address(0) || discountPercent > pool.bestDiscountPercent) {
            if (pool.bestSupplier != address(0)) {
                if (backup.supplier != address(0)) _releaseBusinessBackup(poolId, "OUTRANKED_BY_NEW_OFFER");
                businessBackupOffers[poolId] = SupplierOffer({
                    supplier: pool.bestSupplier,
                    value: pool.bestDiscountPercent,
                    guaranteeBond: pool.supplierGuaranteeBond,
                    maxBuyers: businessSupplierMaxBuyers[poolId],
                    offerExpiry: businessSupplierOfferExpiry[poolId]
                });
            }
            businessSupplierMaxBuyers[poolId] = maxBuyerCount;
            businessSupplierOfferExpiry[poolId] = effectiveExpiry;
            pool.supplierGuaranteeBond = guaranteeBond;
            pool.bestDiscountPercent = discountPercent;
            pool.bestSupplier = msg.sender;
        } else {
            require(backup.supplier == address(0) || discountPercent > backup.value, "OFFER_NOT_TOP_TWO");
            if (backup.supplier != address(0)) _releaseBusinessBackup(poolId, "OUTRANKED_BY_NEW_BACKUP");
            businessBackupOffers[poolId] = SupplierOffer({
                supplier: msg.sender,
                value: discountPercent,
                guaranteeBond: guaranteeBond,
                maxBuyers: maxBuyerCount,
                offerExpiry: effectiveExpiry
            });
        }

        emit BusinessOfferSubmitted(poolId, msg.sender, supplierName, discountPercent, guaranteeBond, block.timestamp);
        return true;
    }

    function settleBusinessPool(string calldata poolId) external onlyOwner nonReentrant returns (bool) {
        return _settleBusinessPool(poolId, false);
    }

    function finalizeBusinessPoolAfterDeadline(string calldata poolId, string calldata reason) external nonReentrant returns (bool) {
        return _finalizeBusinessPoolAfterDeadline(poolId, reason);
    }

    // Both public deadline entry points use the same decision. A valid live
    // supplier settles; otherwise the pool enters refunding. A late caller
    // cannot force a refund while a valid funded offer is available.
    function _finalizeBusinessPoolAfterDeadline(string calldata poolId, string memory reason) internal returns (bool) {
        uint256 deadline = businessDeadlines[poolId];
        require(deadline > 0 && block.timestamp > deadline, "DEADLINE_NOT_REACHED");
        BusinessPool storage pool = businessPools[poolId];
        require(!pool.isSettled && !pool.isRefunded && businessRefundTotals[poolId] == 0, "POOL_CLOSED");
        _promoteBusinessBackup(poolId);
        if (pool.bestSupplier != address(0) && pool.totalDemand > 0 && _businessSupplierIsLive(poolId)) return _settleBusinessPool(poolId, true);
        return _startBusinessRefund(poolId, reason);
    }

    function _settleBusinessPool(string calldata poolId, bool afterDeadline) internal returns (bool) {
        BusinessPool storage pool = businessPools[poolId];
        if (!afterDeadline) {
            uint256 deadline = businessDeadlines[poolId];
            if (deadline > 0 && block.timestamp > deadline) revert("USE_DEADLINE_SETTLEMENT");
            if (deadline > 0) require(block.timestamp >= deadline, "DEADLINE_NOT_REACHED");
        }
        require(!pool.isSettled && !pool.isRefunded, "POOL_CLOSED");
        _promoteBusinessBackup(poolId);
        require(pool.bestSupplier != address(0) && pool.totalDemand > 0 && _businessSupplierIsLive(poolId), "INVALID_POOL");

        pool.isSettled = true;
        _releaseBusinessBackup(poolId, "MARKET_SETTLED");

        uint256 discountedTotal = (pool.totalDemand * (100 - pool.bestDiscountPercent)) / 100;
        uint256 platformFee = discountedTotal / 100;
        uint256 netPayout = discountedTotal - platformFee;
        pool.totalDemand = pool.totalDemand - discountedTotal;
        pool.supplierPayout = netPayout;
        pool.platformFee = platformFee;
        pool.settledGrossVolume = discountedTotal;
        businessFulfillmentDeadlines[poolId] = block.timestamp + DEFAULT_FULFILLMENT_WINDOW;
        emit BusinessPoolSettled(poolId, pool.bestSupplier, netPayout, platformFee, block.timestamp);
        return true;
    }

    function _startBusinessRefund(string calldata poolId, string memory reason) internal returns (bool) {
        BusinessPool storage pool = businessPools[poolId];
        _releaseBusinessBackup(poolId, "MARKET_REFUNDED");
        uint256 demandSnapshot = pool.totalDemand;
        businessRefundTotals[poolId] = demandSnapshot;
        businessRefundRemaining[poolId] = demandSnapshot;
        if (pool.supplierGuaranteeBond > 0 && pool.bestSupplier != address(0)) {
            uint256 bond = pool.supplierGuaranteeBond;
            address supplier = pool.bestSupplier;
            pool.supplierGuaranteeBond = 0;
            businessSupplierGuarantees[poolId][supplier] = 0;
            businessSupplierMaxBuyers[poolId] = 0;
            businessSupplierOfferExpiry[poolId] = 0;
            _pushMemo(supplier, bond, _marketMemo(poolId, "refund"), poolId, "refund");
        }
        emit RefundInitiated(poolId, reason, demandSnapshot, block.timestamp);
        if (demandSnapshot == 0) {
            pool.isRefunded = true;
            emit BusinessPoolRefunded(poolId, reason, demandSnapshot, block.timestamp);
        }
        return true;
    }

    function _disburseSingleBusinessSaving(string calldata poolId, BusinessPool storage pool, address recipient) internal {
        uint256 deposited = businessDeposits[poolId][recipient];
        if (deposited > 0 && pool.totalDemand > 0) {
            uint256 refund = (deposited * pool.bestDiscountPercent) / 100;
            // A dust deposit must never inherit the entire remaining pool.
            // Rounding dust stays in escrow until an explicit policy handles it.
            if (refund == 0) return;
            if (refund > pool.totalDemand) refund = pool.totalDemand;
            pool.totalDemand -= refund;
            // Keep the discounted amount attached to the buyer until
            // fulfillment is confirmed. If the supplier fails after
            // settlement, this is the buyer's refundable balance.
            businessDeposits[poolId][recipient] = deposited - refund;
            bytes32 memo = _marketMemo(poolId, "settlement-surplus");
            _pushMemo(recipient, refund, memo, poolId, "settlement-surplus");
            emit BuyerRefunded(poolId, recipient, refund, block.timestamp);
        }
    }

    function refundBusinessPool(string calldata poolId, string calldata reason) external onlyOwner nonReentrant returns (bool) {
        return _finalizeBusinessPoolAfterDeadline(poolId, reason);
    }

    function refundBusinessPoolAfterDeadline(string calldata poolId, string calldata reason) external nonReentrant returns (bool) {
        return _finalizeBusinessPoolAfterDeadline(poolId, reason);
    }

    function _refundSingleBusiness(string calldata poolId, BusinessPool storage pool, address recipient) internal {
        uint256 amount = businessDeposits[poolId][recipient];
        uint256 refund = amount;
        if (refund > pool.totalDemand) refund = pool.totalDemand;
        if (refund > businessRefundRemaining[poolId]) refund = businessRefundRemaining[poolId];
        if (refund > 0) {
            businessDeposits[poolId][recipient] = amount - refund;
            pool.totalDemand -= refund;
            businessRefundRemaining[poolId] -= refund;
            bytes32 memo = _marketMemo(poolId, "refund");
            _pushMemo(recipient, refund, memo, poolId, "refund");
            emit BuyerRefunded(poolId, recipient, refund, block.timestamp);
        }
    }

    function refundBusinessBatch(string calldata poolId, address[] calldata recipients) external onlyOwnerOrExpired(businessDeadlines[poolId]) nonReentrant returns (bool) {
        BusinessPool storage pool = businessPools[poolId];
        require(businessRefundTotals[poolId] > 0 && !pool.isRefunded, "NOT_REFUNDING");
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _refundSingleBusiness(poolId, pool, recipients[i]);
        }
        if (pool.totalDemand == 0 && businessRefundRemaining[poolId] == 0) {
            pool.isRefunded = true;
            emit BusinessPoolRefunded(poolId, "", businessRefundTotals[poolId], block.timestamp);
        }
        return true;
    }

    function disburseBusinessSavings(string calldata poolId, address[] calldata recipients) external onlyOwnerOrExpired(businessDeadlines[poolId]) nonReentrant returns (bool) {
        BusinessPool storage pool = businessPools[poolId];
        // A later recipient chunk may be a no-op after an earlier chunk
        // consumed the last rounded savings unit. It must not revert the
        // whole native batch in that case.
        require(pool.isSettled, "NOT_SETTLED");
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _disburseSingleBusinessSaving(poolId, pool, recipients[i]);
        }
        return true;
    }

    function sweepBusinessSavingsDust(string calldata poolId) external onlyOwnerOrExpired(businessDeadlines[poolId]) nonReentrant returns (bool) {
        BusinessPool storage pool = businessPools[poolId];
        require(pool.isSettled && pool.supplierPayout > 0 && pool.platformFee > 0 && pool.supplierGuaranteeBond > 0, "FULFILLMENT_PENDING");
        uint256 dust = pool.totalDemand;
        require(dust > 0, "NO_DUST");
        require(dust < businessBuyers[poolId].length, "BUYER_SURPLUS_PENDING");
        pool.totalDemand = 0;
        _pushMemo(treasury, dust, _marketMemo(poolId, "settlement-dust"), poolId, "settlement-dust");
        emit SurplusDustSwept(poolId, dust, block.timestamp);
        return true;
    }

    // 3. REVERSE DEMAND REQUESTS
    function createRequest(
        string calldata requestId,
        string calldata title,
        uint256 maxPrice,
        uint256 authAmount
    ) external nonReentrant returns (bool) {
        require(maxPrice > 0 && authAmount >= MIN_BUYER_COMMITMENT, "INVALID_REQ");
        DemandRequest storage req = demandRequests[requestId];
        _ensureMarketDeadline(requestId, "request");
        _requireBefore(requestDeadlines[requestId]);
        require(!req.isSettled && !req.isRefunded, "REQ_CLOSED");
        require(req.maxPrice == 0, "REQUEST_EXISTS");
        require(requestDeposits[requestId][msg.sender] == 0, "BUYER_ALREADY_JOINED");
        require(requestBuyers[requestId].length < MAX_MARKET_BUYERS, "BUYER_LIMIT_REACHED");

        _pull(msg.sender, authAmount);

        requestDeposits[requestId][msg.sender] = authAmount;
        req.totalEscrow += authAmount;

        req.maxPrice = maxPrice;
        req.buyersCount += 1;
        requestBuyers[requestId].push(msg.sender);

        emit RequestCreated(requestId, msg.sender, title, maxPrice, authAmount, block.timestamp);
        return true;
    }

    function joinRequest(string calldata requestId, uint256 authAmount) external nonReentrant returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        _ensureMarketDeadline(requestId, "request");
        _requireBefore(requestDeadlines[requestId]);
        require(req.maxPrice > 0 && !req.isSettled && !req.isRefunded && authAmount >= MIN_BUYER_COMMITMENT, "INVALID_JOIN");
        require(requestDeposits[requestId][msg.sender] == 0, "BUYER_ALREADY_JOINED");
        require(requestBuyers[requestId].length < MAX_MARKET_BUYERS, "BUYER_LIMIT_REACHED");

        _pull(msg.sender, authAmount);

        requestDeposits[requestId][msg.sender] = authAmount;
        req.totalEscrow += authAmount;

        requestBuyers[requestId].push(msg.sender);
        req.buyersCount += 1;

        emit RequestJoined(requestId, msg.sender, authAmount, req.buyersCount, block.timestamp);
        return true;
    }

    function fundRequest(string calldata requestId, uint256 amount) external nonReentrant returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        _requireBefore(requestDeadlines[requestId]);
        require(req.bestPrice > 0 && !req.isSettled && !req.isRefunded, "OFFER_NOT_ACCEPTED");
        uint256 current = requestDeposits[requestId][msg.sender];
        require(current > 0 && current < req.bestPrice, "INVALID_TOP_UP");
        uint256 remaining = req.bestPrice - current;
        require(amount == remaining, "EXACT_TOP_UP_REQUIRED");

        _pull(msg.sender, amount);
        requestDeposits[requestId][msg.sender] = req.bestPrice;
        req.totalEscrow += amount;
        emit RequestFunded(requestId, msg.sender, amount, req.bestPrice, block.timestamp);
        return true;
    }

    function _requestSupplierIsLive(string calldata requestId) internal view returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        uint256 deadline = requestDeadlines[requestId];
        uint256 effectiveNow = deadline > 0 && block.timestamp > deadline ? deadline : block.timestamp;
        return req.bestSupplier != address(0)
            && !sellerRevoked[req.bestSupplier]
            && requestSupplierMaxBuyers[requestId] >= req.buyersCount
            && requestSupplierOfferExpiry[requestId] >= effectiveNow;
    }

    function _requestBackupIsLive(string calldata requestId, SupplierOffer storage offer) internal view returns (bool) {
        uint256 deadline = requestDeadlines[requestId];
        uint256 effectiveNow = deadline > 0 && block.timestamp > deadline ? deadline : block.timestamp;
        DemandRequest storage req = demandRequests[requestId];
        if (offer.supplier == address(0) || sellerRevoked[offer.supplier]
            || offer.maxBuyers < req.buyersCount || offer.offerExpiry < effectiveNow) return false;
        return true;
    }

    function _requestBuyerFundingComplete(string calldata requestId, uint256 price) internal view returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        if (price == 0 || req.buyersCount == 0 || req.totalEscrow < req.buyersCount * price) return false;
        address[] storage buyers = requestBuyers[requestId];
        for (uint256 i = 0; i < buyers.length; i++) {
            if (requestDeposits[requestId][buyers[i]] < price) return false;
        }
        return true;
    }

    function _releaseRequestBackup(string calldata requestId, string memory reason) internal {
        SupplierOffer storage backup = requestBackupOffers[requestId];
        address supplier = backup.supplier;
        uint256 bond = backup.guaranteeBond;
        delete requestBackupOffers[requestId];
        if (supplier != address(0)) {
            requestSupplierGuarantees[requestId][supplier] = 0;
            if (bond > 0) _pushMemo(supplier, bond, _marketMemo(requestId, "supplier-release"), requestId, "supplier-release");
            emit OfferDeactivated(requestId, supplier, reason, block.timestamp);
        }
    }

    function _promoteRequestBackup(string calldata requestId) internal returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        if (_requestSupplierIsLive(requestId)) return true;
        if (req.bestSupplier != address(0)) _releaseRequestSupplier(requestId, "SUPPLIER_OFFER_NOT_LIVE");
        SupplierOffer storage backup = requestBackupOffers[requestId];
        if (!_requestBackupIsLive(requestId, backup)) {
            if (backup.supplier != address(0)) _releaseRequestBackup(requestId, "BACKUP_OFFER_NOT_LIVE");
            return false;
        }
        req.bestSupplier = backup.supplier;
        req.bestPrice = backup.value;
        req.supplierGuaranteeBond = backup.guaranteeBond;
        requestSupplierMaxBuyers[requestId] = backup.maxBuyers;
        requestSupplierOfferExpiry[requestId] = backup.offerExpiry;
        delete requestBackupOffers[requestId];
        emit BackupSupplierPromoted(requestId, 2, req.bestSupplier, block.timestamp);
        return true;
    }

    function _releaseRequestSupplier(string calldata requestId, string memory reason) internal {
        DemandRequest storage req = demandRequests[requestId];
        address supplier = req.bestSupplier;
        uint256 bond = req.supplierGuaranteeBond;
        req.bestSupplier = address(0);
        req.bestPrice = 0;
        req.supplierGuaranteeBond = 0;
        requestSupplierMaxBuyers[requestId] = 0;
        requestSupplierOfferExpiry[requestId] = 0;
        if (supplier != address(0)) {
            requestSupplierGuarantees[requestId][supplier] = 0;
            if (bond > 0) _pushMemo(supplier, bond, _marketMemo(requestId, "supplier-release"), requestId, "supplier-release");
        }
        emit OfferDeactivated(requestId, supplier, reason, block.timestamp);
    }

    function submitRequestOffer(
        string calldata requestId,
        string calldata supplierName,
        uint256 price,
        uint256 guaranteeBond
    ) external nonReentrant returns (bool) {
        return _submitRequestOffer(requestId, supplierName, price, guaranteeBond, MAX_MARKET_BUYERS, 0);
    }

    function submitRequestOfferWithCapacity(
        string calldata requestId,
        string calldata supplierName,
        uint256 price,
        uint256 guaranteeBond,
        uint256 maxBuyerCount,
        uint256 offerExpiry
    ) external nonReentrant returns (bool) {
        return _submitRequestOffer(requestId, supplierName, price, guaranteeBond, maxBuyerCount, offerExpiry);
    }

    function _submitRequestOffer(
        string calldata requestId,
        string calldata supplierName,
        uint256 price,
        uint256 guaranteeBond,
        uint256 maxBuyerCount,
        uint256 offerExpiry
    ) internal returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        require(!sellerRevoked[msg.sender], "SUPPLIER_REVOKED");
        _ensureMarketDeadline(requestId, "request");
        _requireBefore(requestDeadlines[requestId]);
        require(req.maxPrice > 0 && !req.isSettled && !req.isRefunded, "REQ_CLOSED");
        require(price > 0 && price < req.maxPrice && guaranteeBond >= MIN_SELLER_BOND && maxBuyerCount > 0, "INVALID_OFFER");
        uint256 effectiveExpiry = offerExpiry == 0 ? requestDeadlines[requestId] : offerExpiry;
        require(effectiveExpiry > block.timestamp && effectiveExpiry <= requestDeadlines[requestId], "INVALID_EXPIRY");
        require(maxBuyerCount >= req.buyersCount, "SUPPLIER_CAPACITY_REACHED");
        _promoteRequestBackup(requestId);
        SupplierOffer storage backup = requestBackupOffers[requestId];
        if (backup.supplier != address(0) && !_requestBackupIsLive(requestId, backup)) {
            _releaseRequestBackup(requestId, "BACKUP_OFFER_NOT_LIVE");
        }
        require(msg.sender != req.bestSupplier && msg.sender != backup.supplier, "SUPPLIER_ALREADY_OFFERED");
        _pull(msg.sender, guaranteeBond);
        requestSupplierGuarantees[requestId][msg.sender] = guaranteeBond;
        if (req.bestSupplier == address(0) || price < req.bestPrice) {
            if (req.bestSupplier != address(0)) {
                if (backup.supplier != address(0)) _releaseRequestBackup(requestId, "OUTRANKED_BY_NEW_OFFER");
                requestBackupOffers[requestId] = SupplierOffer({
                    supplier: req.bestSupplier,
                    value: req.bestPrice,
                    guaranteeBond: req.supplierGuaranteeBond,
                    maxBuyers: requestSupplierMaxBuyers[requestId],
                    offerExpiry: requestSupplierOfferExpiry[requestId]
                });
            }
            requestSupplierMaxBuyers[requestId] = maxBuyerCount;
            requestSupplierOfferExpiry[requestId] = effectiveExpiry;
            req.supplierGuaranteeBond = guaranteeBond;
            req.bestPrice = price;
            req.bestSupplier = msg.sender;
        } else {
            require(backup.supplier == address(0) || price < backup.value, "OFFER_NOT_TOP_TWO");
            if (backup.supplier != address(0)) _releaseRequestBackup(requestId, "OUTRANKED_BY_NEW_BACKUP");
            requestBackupOffers[requestId] = SupplierOffer({
                supplier: msg.sender,
                value: price,
                guaranteeBond: guaranteeBond,
                maxBuyers: maxBuyerCount,
                offerExpiry: effectiveExpiry
            });
        }

        emit RequestOfferSubmitted(requestId, msg.sender, supplierName, price, guaranteeBond, block.timestamp);
        return true;
    }

    function settleRequest(string calldata requestId) external onlyOwner nonReentrant returns (bool) {
        return _settleRequest(requestId, false);
    }

    function finalizeRequestAfterDeadline(string calldata requestId, string calldata reason) external nonReentrant returns (bool) {
        return _finalizeRequestAfterDeadline(requestId, reason);
    }

    // Settlement and refund are one deterministic deadline decision for a
    // request too; the permissionless refund alias must not bypass a valid
    // supplier offer.
    function _finalizeRequestAfterDeadline(string calldata requestId, string memory reason) internal returns (bool) {
        uint256 deadline = requestDeadlines[requestId];
        require(deadline > 0 && block.timestamp > deadline, "DEADLINE_NOT_REACHED");
        DemandRequest storage req = demandRequests[requestId];
        require(!req.isSettled && !req.isRefunded && requestRefundTotals[requestId] == 0, "REQ_CLOSED");
        _promoteRequestBackup(requestId);
        if (req.bestSupplier != address(0) && _requestSupplierIsLive(requestId)
            && _requestBuyerFundingComplete(requestId, req.bestPrice)) {
            return _settleRequest(requestId, true);
        }
        if (req.bestSupplier != address(0)) _releaseRequestSupplier(requestId, "BUYERS_NOT_FULLY_FUNDED");
        _promoteRequestBackup(requestId);
        if (req.bestSupplier != address(0) && _requestSupplierIsLive(requestId)
            && _requestBuyerFundingComplete(requestId, req.bestPrice)) {
            return _settleRequest(requestId, true);
        }
        return _startRequestRefund(requestId, reason);
    }

    function _settleRequest(string calldata requestId, bool afterDeadline) internal returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        if (!afterDeadline) {
            uint256 deadline = requestDeadlines[requestId];
            if (deadline > 0 && block.timestamp > deadline) revert("USE_DEADLINE_SETTLEMENT");
            if (deadline > 0) require(block.timestamp >= deadline, "DEADLINE_NOT_REACHED");
        }
        require(!req.isSettled && !req.isRefunded, "REQ_CLOSED");
        _promoteRequestBackup(requestId);
        require(req.bestSupplier != address(0) && req.buyersCount > 0 && _requestSupplierIsLive(requestId), "INVALID_REQ");

        req.isSettled = true;
        _releaseRequestBackup(requestId, "MARKET_SETTLED");

        uint256 grossVolume = req.buyersCount * req.bestPrice;
        require(req.totalEscrow >= grossVolume, "INSUFFICIENT_ESCROW");
        address[] storage fundedBuyers = requestBuyers[requestId];
        for (uint256 i = 0; i < fundedBuyers.length; i++) {
            require(requestDeposits[requestId][fundedBuyers[i]] >= req.bestPrice, "BUYER_UNDERFUNDED");
        }

        if (grossVolume > 0) {
            uint256 platformFee = grossVolume / 100;
            uint256 netPayout = grossVolume - platformFee;
            req.totalEscrow -= grossVolume;
            req.supplierPayout = netPayout;
            req.platformFee = platformFee;
            req.settledGrossVolume = grossVolume;
        }
        requestFulfillmentDeadlines[requestId] = block.timestamp + DEFAULT_FULFILLMENT_WINDOW;
        emit RequestSettled(requestId, req.bestSupplier, req.bestPrice, block.timestamp);
        return true;
    }

    function _startRequestRefund(string calldata requestId, string memory reason) internal returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        _releaseRequestBackup(requestId, "MARKET_REFUNDED");
        uint256 escrowSnapshot = req.totalEscrow;
        requestRefundTotals[requestId] = escrowSnapshot;
        requestRefundRemaining[requestId] = escrowSnapshot;
        if (req.supplierGuaranteeBond > 0 && req.bestSupplier != address(0)) {
            uint256 bond = req.supplierGuaranteeBond;
            address supplier = req.bestSupplier;
            req.supplierGuaranteeBond = 0;
            requestSupplierGuarantees[requestId][supplier] = 0;
            requestSupplierMaxBuyers[requestId] = 0;
            requestSupplierOfferExpiry[requestId] = 0;
            _pushMemo(supplier, bond, _marketMemo(requestId, "refund"), requestId, "refund");
        }
        emit RefundInitiated(requestId, reason, escrowSnapshot, block.timestamp);
        if (escrowSnapshot == 0) {
            req.isRefunded = true;
            emit RequestRefunded(requestId, reason, escrowSnapshot, block.timestamp);
        }
        return true;
    }

    function removeUnfundedRequestBuyersAfterDeadline(string calldata requestId, address[] calldata recipients) external nonReentrant returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        uint256 deadline = requestDeadlines[requestId];
        require(deadline > 0 && block.timestamp > deadline, "DEADLINE_NOT_REACHED");
        require(req.bestPrice > 0 && !req.isSettled && !req.isRefunded, "REQUEST_CLOSED");
        require(recipients.length <= 200, "BATCH_TOO_LARGE");

        for (uint256 i = 0; i < recipients.length; i++) {
            address buyer = recipients[i];
            uint256 deposited = requestDeposits[requestId][buyer];
            if (deposited > 0 && deposited < req.bestPrice) {
                requestDeposits[requestId][buyer] = 0;
                if (req.totalEscrow >= deposited) req.totalEscrow -= deposited;
                if (req.buyersCount > 0) req.buyersCount -= 1;
                _removeRequestBuyer(requestId, buyer);
                _pushMemo(buyer, deposited, _marketMemo(requestId, "refund"), requestId, "refund");
                emit BuyerRefunded(requestId, buyer, deposited, block.timestamp);
            }
        }
        return true;
    }

    function _removeRequestBuyer(string calldata requestId, address buyer) internal {
        address[] storage buyers = requestBuyers[requestId];
        for (uint256 i = 0; i < buyers.length; i++) {
            if (buyers[i] == buyer) {
                buyers[i] = buyers[buyers.length - 1];
                buyers.pop();
                return;
            }
        }
    }

    function confirmSupplierFulfillment(uint8 marketType, string calldata marketId) external onlyOwner nonReentrant returns (bool) {
        require(marketType == 1 || marketType == 2, "INVALID_MARKET_TYPE");
        uint256 bond;
        address supplier;
        if (marketType == 1) {
            BusinessPool storage pool = businessPools[marketId];
            require(pool.isSettled && !pool.isRefunded, "NOT_SETTLED");
            require(businessFulfillmentDeadlines[marketId] == 0 || block.timestamp <= businessFulfillmentDeadlines[marketId], "FULFILLMENT_DEADLINE_PASSED");
            bond = pool.supplierGuaranteeBond;
            supplier = pool.bestSupplier;
            require(bond > 0 && supplier != address(0), "NO_BOND");
            require(pool.totalDemand == 0, "BUYER_SURPLUS_PENDING");
            for (uint256 i = 0; i < businessBuyers[marketId].length; i++) {
                require(businessDeposits[marketId][businessBuyers[marketId][i]] > 0, "BUYER_ACCOUNTING_PENDING");
                businessDeposits[marketId][businessBuyers[marketId][i]] = 0;
            }
            pool.supplierGuaranteeBond = 0;
            businessSupplierGuarantees[marketId][supplier] = 0;
            businessSupplierMaxBuyers[marketId] = 0;
            businessSupplierOfferExpiry[marketId] = 0;
            uint256 payout = pool.supplierPayout;
            uint256 fee = pool.platformFee;
            pool.supplierPayout = 0;
            pool.platformFee = 0;
            bytes32 settlementMemo = _marketMemo(marketId, "settlement");
            if (payout > 0) _pushMemo(supplier, payout, settlementMemo, marketId, "settlement");
            if (fee > 0) _pushMemo(treasury, fee, settlementMemo, marketId, "settlement");
        } else {
            DemandRequest storage req = demandRequests[marketId];
            require(req.isSettled && !req.isRefunded, "NOT_SETTLED");
            require(requestFulfillmentDeadlines[marketId] == 0 || block.timestamp <= requestFulfillmentDeadlines[marketId], "FULFILLMENT_DEADLINE_PASSED");
            bond = req.supplierGuaranteeBond;
            supplier = req.bestSupplier;
            require(bond > 0 && supplier != address(0), "NO_BOND");
            require(req.totalEscrow == 0, "BUYER_SURPLUS_PENDING");
            for (uint256 i = 0; i < requestBuyers[marketId].length; i++) {
                require(requestDeposits[marketId][requestBuyers[marketId][i]] == req.bestPrice, "BUYER_ACCOUNTING_PENDING");
                requestDeposits[marketId][requestBuyers[marketId][i]] = 0;
            }
            req.supplierGuaranteeBond = 0;
            requestSupplierGuarantees[marketId][supplier] = 0;
            requestSupplierMaxBuyers[marketId] = 0;
            requestSupplierOfferExpiry[marketId] = 0;
            uint256 payout = req.supplierPayout;
            uint256 fee = req.platformFee;
            req.supplierPayout = 0;
            req.platformFee = 0;
            bytes32 settlementMemo = _marketMemo(marketId, "settlement");
            if (payout > 0) _pushMemo(supplier, payout, settlementMemo, marketId, "settlement");
            if (fee > 0) _pushMemo(treasury, fee, settlementMemo, marketId, "settlement");
        }
        _pushMemo(supplier, bond, _marketMemo(marketId, "fulfillment"), marketId, "fulfillment");
        return true;
    }

    function slashSettledSupplierGuarantee(
        uint8 marketType,
        string calldata marketId,
        string calldata reason
    ) external onlyOwner nonReentrant returns (bool) {
        return _slashSettledSupplierGuarantee(marketType, marketId, reason);
    }

    function slashBusinessSupplierAfterFulfillmentDeadline(
        string calldata poolId,
        string calldata reason
    ) external nonReentrant returns (bool) {
        require(businessFulfillmentDeadlines[poolId] > 0 && block.timestamp > businessFulfillmentDeadlines[poolId], "FULFILLMENT_DEADLINE_NOT_REACHED");
        return _slashSettledSupplierGuarantee(1, poolId, reason);
    }

    function slashRequestSupplierAfterFulfillmentDeadline(
        string calldata requestId,
        string calldata reason
    ) external nonReentrant returns (bool) {
        require(requestFulfillmentDeadlines[requestId] > 0 && block.timestamp > requestFulfillmentDeadlines[requestId], "FULFILLMENT_DEADLINE_NOT_REACHED");
        return _slashSettledSupplierGuarantee(2, requestId, reason);
    }

    function _slashSettledSupplierGuarantee(
        uint8 marketType,
        string calldata marketId,
        string calldata reason
    ) internal returns (bool) {
        require(marketType == 1 || marketType == 2, "INVALID_MARKET_TYPE");
        uint256 bond;
        address supplier;
        uint256 refundableEscrow;

        if (marketType == 1) {
            BusinessPool storage pool = businessPools[marketId];
            require(pool.isSettled && !pool.isRefunded && businessRefundTotals[marketId] == 0, "NOT_SETTLED");
            bond = pool.supplierGuaranteeBond;
            supplier = pool.bestSupplier;
            require(bond > 0 && supplier != address(0), "NO_BOND");
            require(pool.totalDemand == 0, "BUYER_SURPLUS_PENDING");
            refundableEscrow = pool.supplierPayout + pool.platformFee;
            require(refundableEscrow > 0, "NO_SETTLEMENT_FUNDS");
            pool.supplierPayout = 0;
            pool.platformFee = 0;
            pool.supplierGuaranteeBond = 0;
            businessSupplierGuarantees[marketId][supplier] = 0;
            businessSupplierMaxBuyers[marketId] = 0;
            businessSupplierOfferExpiry[marketId] = 0;
            pool.totalDemand = refundableEscrow;
        } else {
            DemandRequest storage req = demandRequests[marketId];
            require(req.isSettled && !req.isRefunded && requestRefundTotals[marketId] == 0, "NOT_SETTLED");
            bond = req.supplierGuaranteeBond;
            supplier = req.bestSupplier;
            require(bond > 0 && supplier != address(0), "NO_BOND");
            require(req.totalEscrow == 0, "BUYER_SURPLUS_PENDING");
            refundableEscrow = req.supplierPayout + req.platformFee;
            require(refundableEscrow > 0, "NO_SETTLEMENT_FUNDS");
            req.supplierPayout = 0;
            req.platformFee = 0;
            req.supplierGuaranteeBond = 0;
            requestSupplierGuarantees[marketId][supplier] = 0;
            requestSupplierMaxBuyers[marketId] = 0;
            requestSupplierOfferExpiry[marketId] = 0;
            req.totalEscrow = refundableEscrow;
        }

        if (marketType == 1) {
            businessRefundTotals[marketId] = refundableEscrow;
            businessRefundRemaining[marketId] = refundableEscrow;
        } else {
            requestRefundTotals[marketId] = refundableEscrow;
            requestRefundRemaining[marketId] = refundableEscrow;
        }
        _push(treasury, bond);
        emit SupplierGuaranteeSlashed(marketId, marketType, supplier, bond, reason, block.timestamp);
        emit RefundInitiated(marketId, reason, refundableEscrow, block.timestamp);
        return true;
    }

    function _disburseSingleRequestSurplus(
        string calldata requestId,
        DemandRequest storage req,
        address buyer
    ) internal {
        uint256 deposited = requestDeposits[requestId][buyer];
        if (deposited > req.bestPrice && req.totalEscrow > 0) {
            uint256 surplus = deposited - req.bestPrice;
            if (surplus > req.totalEscrow) surplus = req.totalEscrow;
            requestDeposits[requestId][buyer] = deposited - surplus;
            req.totalEscrow -= surplus;
            bytes32 memo = _marketMemo(requestId, "settlement-surplus");
            _pushMemo(buyer, surplus, memo, requestId, "settlement-surplus");
            emit BuyerRefunded(requestId, buyer, surplus, block.timestamp);
        }
    }

    function disburseRequestSurplusBatch(
        string calldata requestId,
        address[] calldata recipients
    ) external onlyOwnerOrExpired(requestDeadlines[requestId]) nonReentrant returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        require(req.isSettled, "NOT_SETTLED");
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _disburseSingleRequestSurplus(requestId, req, recipients[i]);
        }
        return true;
    }

    function sweepRequestSurplusDust(string calldata requestId) external onlyOwnerOrExpired(requestDeadlines[requestId]) nonReentrant returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        require(req.isSettled && req.supplierPayout == 0 && req.platformFee == 0 && req.supplierGuaranteeBond == 0, "FULFILLMENT_PENDING");
        for (uint256 i = 0; i < requestBuyers[requestId].length; i++) {
            require(requestDeposits[requestId][requestBuyers[requestId][i]] <= req.bestPrice, "BUYER_SURPLUS_PENDING");
        }
        uint256 dust = req.totalEscrow;
        require(dust > 0, "NO_DUST");
        req.totalEscrow = 0;
        _pushMemo(treasury, dust, _marketMemo(requestId, "settlement-dust"), requestId, "settlement-dust");
        emit SurplusDustSwept(requestId, dust, block.timestamp);
        return true;
    }

    function refundRequest(string calldata requestId, string calldata reason) external onlyOwner nonReentrant returns (bool) {
        return _finalizeRequestAfterDeadline(requestId, reason);
    }

    function refundRequestAfterDeadline(string calldata requestId, string calldata reason) external nonReentrant returns (bool) {
        return _finalizeRequestAfterDeadline(requestId, reason);
    }

    function _refundSingleRequestBuyer(string calldata requestId, DemandRequest storage req, address recipient) internal {
        uint256 amount = requestDeposits[requestId][recipient];
        uint256 refund = amount;
        if (refund > req.totalEscrow) refund = req.totalEscrow;
        if (refund > requestRefundRemaining[requestId]) refund = requestRefundRemaining[requestId];
        if (refund > 0) {
            requestDeposits[requestId][recipient] = amount - refund;
            req.totalEscrow -= refund;
            requestRefundRemaining[requestId] -= refund;
            bytes32 memo = _marketMemo(requestId, "refund");
            _pushMemo(recipient, refund, memo, requestId, "refund");
            emit BuyerRefunded(requestId, recipient, refund, block.timestamp);
        }
    }

    function refundRequestBatch(string calldata requestId, address[] calldata recipients) external onlyOwnerOrExpired(requestDeadlines[requestId]) nonReentrant returns (bool) {
        DemandRequest storage req = demandRequests[requestId];
        require(requestRefundTotals[requestId] > 0 && !req.isRefunded, "NOT_REFUNDING");
        require(recipients.length <= 200, "BATCH_TOO_LARGE");
        for (uint256 i = 0; i < recipients.length; i++) {
            _refundSingleRequestBuyer(requestId, req, recipients[i]);
        }
        if (req.totalEscrow == 0 && requestRefundRemaining[requestId] == 0) {
            req.isRefunded = true;
            emit RequestRefunded(requestId, "", requestRefundTotals[requestId], block.timestamp);
        }
        return true;
    }

    function getDealBuyers(string calldata dealId) external view returns (address[] memory) {
        return dealBuyers[dealId];
    }

    function getRequestBuyers(string calldata requestId) external view returns (address[] memory) {
        return requestBuyers[requestId];
    }

    function getBusinessBuyers(string calldata poolId) external view returns (address[] memory) {
        return businessBuyers[poolId];
    }

    function getDealState(string calldata dealId) external view returns (
        uint256 buyersCount,
        uint256 bestPrice,
        address bestSeller,
        uint256 totalEscrow,
        uint256 sellerGuaranteeBond,
        bool isSettled,
        bool isRefunded
    ) {
        Deal storage d = deals[dealId];
        return (
            d.buyersCount,
            d.bestPrice,
            d.bestSeller,
            d.totalEscrow,
            d.sellerGuaranteeBond,
            d.isSettled,
            d.isRefunded
        );
    }

    function getDealFundingState(string calldata dealId) external view returns (
        uint256 joinedBuyers,
        uint256 fundedBuyers,
        uint256 joinedUnits,
        uint256 fundedUnits,
        uint256 totalEscrow,
        uint256 currentPrice
    ) {
        Deal storage deal = deals[dealId];
        joinedBuyers = deal.buyersCount;
        joinedUnits = deal.committedUnits;
        totalEscrow = deal.totalEscrow;
        currentPrice = deal.bestPrice;
        address[] storage buyers = dealBuyers[dealId];
        for (uint256 i = 0; i < buyers.length; i++) {
            address buyer = buyers[i];
            uint256 units = buyerUnits[dealId][buyer];
            if (units > 0 && deal.bestPrice > 0 && buyerDeposits[dealId][buyer] >= units * deal.bestPrice) {
                fundedBuyers += 1;
                fundedUnits += units;
            }
        }
    }

    function getDealSettlementState(string calldata dealId) external view returns (
        uint256 sellerPayout,
        uint256 platformFee,
        uint256 settledGrossVolume,
        uint256 settlementTargetBuyerCount
    ) {
        Deal storage deal = deals[dealId];
        return (deal.sellerPayout, deal.platformFee, deal.settledGrossVolume, deal.settlementTargetBuyerCount);
    }

    function getDealTimingState(string calldata dealId) external view returns (uint256 finalBiddingEndsAt, uint256 marketDeadline, uint256 fulfillmentDeadline) {
        return (deals[dealId].finalBiddingEndsAt, marketDeadlines[dealId], deals[dealId].fulfillmentDeadline);
    }

    function getDealOffer(string calldata dealId, address seller) external view returns (
        uint256 price,
        uint256 guaranteeBond,
        uint256 maxBuyerUnits,
        uint256 offerExpiry,
        uint256 minimumBuyerCount,
        bool active
    ) {
        ConditionalOffer storage offer = dealOffers[dealId][seller];
        return (offer.price, offer.guaranteeBond, offer.maxBuyerUnits, offer.offerExpiry, offer.minimumBuyerCount, offer.active);
    }

    function getDealPriceLadder(string calldata dealId, address seller) external view returns (
        uint256[] memory prices,
        uint256[] memory minimumBuyerCounts,
        uint256 maxBuyerUnits,
        uint256 offerExpiry,
        uint256 guaranteeBond,
        bool active
    ) {
        PriceTier[] storage tiers = dealPriceTiers[dealId][seller];
        prices = new uint256[](tiers.length);
        minimumBuyerCounts = new uint256[](tiers.length);
        for (uint256 i = 0; i < tiers.length; i++) {
            prices[i] = tiers[i].price;
            minimumBuyerCounts[i] = tiers[i].minimumBuyerCount;
            maxBuyerUnits = tiers[i].maxBuyerUnits;
            offerExpiry = tiers[i].offerExpiry;
        }
        guaranteeBond = sellerGuarantees[dealId][seller];
        active = ladderOffers[dealId][seller];
    }

}
