// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ComplianceRegistry} from "./ComplianceRegistry.sol";
import {PropertyToken, PropertyTokenFactory} from "./PropertyToken.sol";

/**
 * @title LandVestPlatform
 * @notice On-chain implementation of the LandVest demo flow:
 *
 *   Merchant submits a property            submitProperty()          -> Submitted
 *   Admin ticks the 7-item checklist and   approveProperty()         -> Approved (NOT yet tradable)
 *   Admin approves the tokenization        approveTokenization()     -> Tokenized  (token deployed + minted)
 *   Property appears in the marketplace    listedPropertyIds()
 *   Investor funds the wallet              deposit()
 *   Investor buys tokens                   buyTokens()               -> holding + ledger rows
 *   Merchant sees funding progress         getState(id).fundingRaised
 *
 * Units
 *   - USD amounts use the settlement token's 6 decimals ($1.00 = 1_000_000).
 *   - Property tokens have 18 decimals; `tokenSupply` is stored in those units.
 *   - `tokenPrice` / `initialNav` are USD (6 dec) per one whole token (1e18).
 *   - Percentages are whole points (40 = 40 %), yields are basis points.
 *
 * Every rule the UI enforces in `demo-store.ts` is enforced here: KYC gate,
 * minimum / maximum ticket, wallet balance including the fee, allocation split,
 * the checklist gate before approval, and the two-step approve -> tokenize gate.
 */
contract LandVestPlatform is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ---------------------------------------------------------------------- */
    /* Constants                                                                */
    /* ---------------------------------------------------------------------- */

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint256 public constant USD = 1e6;
    uint256 public constant TOKEN_UNIT = 1e18;
    uint256 public constant BPS = 10_000;

    /// @dev Bit positions of `PROPERTY_REVIEW_CHECKLIST` in the admin review rail.
    uint8 public constant CHECK_OWNERSHIP_VERIFIED = 1 << 0;
    uint8 public constant CHECK_TITLE_VERIFIED = 1 << 1;
    uint8 public constant CHECK_BOUNDARY_VERIFIED = 1 << 2;
    uint8 public constant CHECK_MERCHANT_MATCH = 1 << 3;
    uint8 public constant CHECK_DUPLICATE_CHECK = 1 << 4;
    uint8 public constant CHECK_VALUATION_REVIEW = 1 << 5;
    uint8 public constant CHECK_LEGAL_REVIEW = 1 << 6;
    uint8 public constant CHECKLIST_COMPLETE = 0x7F;

    /* ---------------------------------------------------------------------- */
    /* Types                                                                    */
    /* ---------------------------------------------------------------------- */

    /// @dev Same members, same order, as `PropertyStatus` in the UI.
    enum PropertyStatus {
        Draft,
        Submitted,
        UnderReview,
        ActionRequired,
        Approved,
        Rejected,
        Tokenized
    }

    /// @dev Same members, same order, as `TokenizationStatus` in the UI.
    enum TokenizationStatus {
        Draft,
        Pending,
        Approved,
        Rejected,
        Active
    }

    /// @dev Same members, same order, as `TransactionType` in the UI.
    enum TxType {
        Investment,
        Deposit,
        Withdrawal,
        Distribution,
        Fee
    }

    /// @notice What the merchant types in wizard steps 1-4 (basics, location, ownership, documents).
    struct PropertyInfo {
        /// @dev URL-safe unique id, e.g. "pprd" or "kep-coastal-villas-listing-11".
        string slug;
        string name;
        string tokenSymbol;
        /// @dev "District, Province" as shown on the cards.
        string location;
        /// @dev IPFS CID / URL of the full listing: description, gallery, boundary, documents.
        string metadataURI;
        /// @dev Index into the UI's `PropertyType` union.
        uint8 propertyType;
        /// @dev Square metres.
        uint256 landArea;
        /// @dev Independent valuation in USD (6 dec).
        uint256 valuation;
        /// @dev keccak256 of the concatenated document hashes the admin verifies.
        bytes32 documentsHash;
    }

    /// @notice Wizard step 5 (tokenization terms).
    struct OfferingTerms {
        uint256 tokenSupply;
        /// @dev Launch price per whole token in USD (6 dec).
        uint256 initialNav;
        uint8 investorAllocationPct;
        uint8 merchantRetentionPct;
        uint256 minimumInvestment;
        uint256 maximumInvestment;
        uint256 fundingTarget;
        uint32 lockupMonths;
        uint16 expectedYieldBps;
    }

    /// @notice Everything that changes after submission.
    struct PropertyState {
        PropertyStatus status;
        TokenizationStatus tokenizationStatus;
        address merchant;
        address token;
        uint256 tokenPrice;
        uint256 fundingRaised;
        uint256 availableTokens;
        uint256 investorCount;
        uint8 checklist;
        uint64 submittedAt;
        uint64 lastUpdatedAt;
        uint64 lockupEnd;
        string reviewNote;
        string tokenizationNote;
    }

    struct Holding {
        uint256 quantity;
        uint256 costBasis;
        uint256 tokensBought;
        uint64 firstInvestedAt;
    }

    struct LedgerEntry {
        uint256 id;
        uint64 timestamp;
        TxType txType;
        address user;
        uint256 propertyId;
        uint256 amount;
        uint256 tokenQuantity;
    }

    /* ---------------------------------------------------------------------- */
    /* Storage                                                                  */
    /* ---------------------------------------------------------------------- */

    IERC20 public immutable usd;
    ComplianceRegistry public immutable compliance;
    PropertyTokenFactory public immutable tokenFactory;

    address public treasury;
    uint256 public platformFeeBps = 50; // 0.5 %
    uint256 public minPlatformFee = 1 * USD; // $1 floor
    uint256 public defaultMaximumInvestment = 100_000 * USD;
    uint32 public defaultLockupMonths = 12;

    uint256 public propertyCount;
    mapping(uint256 => PropertyInfo) private _info;
    mapping(uint256 => OfferingTerms) private _terms;
    mapping(uint256 => PropertyState) private _state;
    mapping(bytes32 => uint256) private _idBySlug;
    mapping(address => uint256[]) private _merchantProperties;

    mapping(address => uint256) public walletBalanceOf;
    mapping(address => mapping(uint256 => Holding)) private _holdings;
    mapping(address => uint256[]) private _investorProperties;

    LedgerEntry[] private _ledger;
    mapping(address => uint256[]) private _userLedger;

    uint256 public totalInvested;
    uint256 public totalFeesCollected;

    /* ---------------------------------------------------------------------- */
    /* Events                                                                   */
    /* ---------------------------------------------------------------------- */

    event PropertySubmitted(uint256 indexed propertyId, address indexed merchant, string slug, string tokenSymbol);
    event PropertyStatusChanged(uint256 indexed propertyId, PropertyStatus status, address indexed by, string note);
    event ChecklistUpdated(uint256 indexed propertyId, uint8 checklist);
    event TokenizationStatusChanged(uint256 indexed propertyId, TokenizationStatus status, address indexed by, string note);
    event PropertyTokenized(uint256 indexed propertyId, address indexed token, uint256 investorAllocation, uint256 merchantRetention, uint256 treasuryAllocation, uint64 lockupEnd);
    event ValuationUpdated(uint256 indexed propertyId, uint256 valuation, uint256 tokenPrice);
    event Deposited(address indexed investor, uint256 amount);
    event Withdrawn(address indexed investor, uint256 amount);
    event TokensPurchased(uint256 indexed propertyId, address indexed investor, uint256 amount, uint256 fee, uint256 tokens);
    event IncomeDistributed(uint256 indexed propertyId, address indexed merchant, uint256 amount);
    event DistributionClaimed(uint256 indexed propertyId, address indexed investor, uint256 amount);
    event LedgerRecorded(uint256 indexed id, address indexed user, TxType txType, uint256 indexed propertyId, uint256 amount, uint256 tokenQuantity);
    event SettingsUpdated(uint256 platformFeeBps, uint256 minPlatformFee, uint256 defaultMaximumInvestment, uint32 defaultLockupMonths, address treasury);

    /* ---------------------------------------------------------------------- */
    /* Errors                                                                   */
    /* ---------------------------------------------------------------------- */

    error KybNotApproved();
    error KycNotApproved();
    error NotMerchantOfProperty();
    error UnknownProperty();
    error SlugTaken();
    error EmptyField();
    error InvalidTerms();
    error AllocationExceeds100();
    error InvalidStatus(PropertyStatus current);
    error InvalidTokenizationStatus(TokenizationStatus current);
    error ChecklistIncomplete(uint8 checklist);
    error NoteRequired();
    error ZeroAmount();
    error BelowMinimum(uint256 minimum);
    error AboveMaximum(uint256 maximum);
    error InsufficientFunds(uint256 required, uint256 available);
    error InsufficientTokens(uint256 requested, uint256 available);
    error NotTokenized();
    error ZeroAddress();

    /* ---------------------------------------------------------------------- */
    /* Constructor                                                              */
    /* ---------------------------------------------------------------------- */

    constructor(address admin, address usd_, address compliance_, address factory_, address treasury_) {
        if (admin == address(0) || usd_ == address(0) || compliance_ == address(0) || factory_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        usd = IERC20(usd_);
        compliance = ComplianceRegistry(compliance_);
        tokenFactory = PropertyTokenFactory(factory_);
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /* ---------------------------------------------------------------------- */
    /* Modifiers / guards                                                       */
    /* ---------------------------------------------------------------------- */

    modifier propertyExists(uint256 propertyId) {
        _requireExists(propertyId);
        _;
    }

    modifier onlyPropertyMerchant(uint256 propertyId) {
        _requireExists(propertyId);
        if (_state[propertyId].merchant != msg.sender) revert NotMerchantOfProperty();
        _;
    }

    /* ---------------------------------------------------------------------- */
    /* Merchant: property submission wizard                                     */
    /* ---------------------------------------------------------------------- */

    /// @notice Step 6 of the wizard: "Submit for verification". Creates the
    ///         property in `Submitted` and its tokenization request in `Pending`.
    function submitProperty(PropertyInfo calldata info, OfferingTerms calldata terms)
        external
        whenNotPaused
        returns (uint256 propertyId)
    {
        if (!compliance.canListProperty(msg.sender)) revert KybNotApproved();
        if (bytes(info.slug).length == 0 || bytes(info.name).length == 0 || bytes(info.tokenSymbol).length == 0) {
            revert EmptyField();
        }
        if (info.valuation == 0 || info.landArea == 0) revert InvalidTerms();

        bytes32 slugKey = keccak256(bytes(info.slug));
        if (_idBySlug[slugKey] != 0) revert SlugTaken();

        OfferingTerms memory normalized = _validateTerms(terms);

        propertyId = ++propertyCount;
        _idBySlug[slugKey] = propertyId;
        _info[propertyId] = info;
        _terms[propertyId] = normalized;

        PropertyState storage s = _state[propertyId];
        s.status = PropertyStatus.Submitted;
        s.tokenizationStatus = TokenizationStatus.Pending;
        s.merchant = msg.sender;
        s.tokenPrice = normalized.initialNav;
        s.availableTokens = _investorAllocationTokens(normalized);
        s.submittedAt = uint64(block.timestamp);
        s.lastUpdatedAt = uint64(block.timestamp);

        _merchantProperties[msg.sender].push(propertyId);

        emit PropertySubmitted(propertyId, msg.sender, info.slug, info.tokenSymbol);
        emit PropertyStatusChanged(propertyId, PropertyStatus.Submitted, msg.sender, "");
        emit TokenizationStatusChanged(propertyId, TokenizationStatus.Pending, msg.sender, "");
    }

    /// @notice Answer an admin "more information requested" decision with an
    ///         updated listing bundle. `ActionRequired` -> `Submitted`.
    function resubmitProperty(uint256 propertyId, string calldata metadataURI, bytes32 documentsHash)
        external
        whenNotPaused
        onlyPropertyMerchant(propertyId)
    {
        PropertyState storage s = _state[propertyId];
        if (s.status != PropertyStatus.ActionRequired) revert InvalidStatus(s.status);
        _info[propertyId].metadataURI = metadataURI;
        _info[propertyId].documentsHash = documentsHash;
        s.status = PropertyStatus.Submitted;
        s.checklist = 0;
        s.lastUpdatedAt = uint64(block.timestamp);
        emit PropertyStatusChanged(propertyId, PropertyStatus.Submitted, msg.sender, "");
    }

    /// @notice Revise the tokenization terms after the admin requested changes
    ///         or rejected them. `Draft` / `Rejected` -> `Pending`. Impossible
    ///         once the token exists.
    function updateTerms(uint256 propertyId, OfferingTerms calldata terms)
        external
        whenNotPaused
        onlyPropertyMerchant(propertyId)
    {
        PropertyState storage s = _state[propertyId];
        if (s.status == PropertyStatus.Tokenized) revert InvalidStatus(s.status);
        if (s.tokenizationStatus != TokenizationStatus.Draft && s.tokenizationStatus != TokenizationStatus.Rejected) {
            revert InvalidTokenizationStatus(s.tokenizationStatus);
        }
        OfferingTerms memory normalized = _validateTerms(terms);
        _terms[propertyId] = normalized;
        s.tokenPrice = normalized.initialNav;
        s.availableTokens = _investorAllocationTokens(normalized);
        s.tokenizationStatus = TokenizationStatus.Pending;
        s.tokenizationNote = "";
        s.lastUpdatedAt = uint64(block.timestamp);
        emit TokenizationStatusChanged(propertyId, TokenizationStatus.Pending, msg.sender, "");
    }

    /* ---------------------------------------------------------------------- */
    /* Admin: property review (`/admin/properties/[id]`)                        */
    /* ---------------------------------------------------------------------- */

    /// @notice Opening the review screen: `Submitted` -> `UnderReview`.
    function startReview(uint256 propertyId) external onlyRole(ADMIN_ROLE) propertyExists(propertyId) {
        PropertyState storage s = _state[propertyId];
        if (s.status != PropertyStatus.Submitted) revert InvalidStatus(s.status);
        s.status = PropertyStatus.UnderReview;
        s.lastUpdatedAt = uint64(block.timestamp);
        emit PropertyStatusChanged(propertyId, PropertyStatus.UnderReview, msg.sender, "");
    }

    /// @notice Tick / untick checklist items (bitmask of the CHECK_* constants).
    function setChecklist(uint256 propertyId, uint8 checklist) external onlyRole(ADMIN_ROLE) propertyExists(propertyId) {
        PropertyState storage s = _state[propertyId];
        if (!_isReviewable(s.status)) revert InvalidStatus(s.status);
        s.checklist = checklist & CHECKLIST_COMPLETE;
        emit ChecklistUpdated(propertyId, s.checklist);
    }

    /// @notice "Approve" in the decision rail. Stays disabled in the UI until all
    ///         seven items are ticked; here it reverts instead. Approval clears
    ///         verification only: the asset is NOT listed until tokenization.
    function approveProperty(uint256 propertyId, uint8 checklist, string calldata note)
        external
        onlyRole(ADMIN_ROLE)
        propertyExists(propertyId)
    {
        PropertyState storage s = _state[propertyId];
        if (!_isReviewable(s.status)) revert InvalidStatus(s.status);
        uint8 merged = (s.checklist | checklist) & CHECKLIST_COMPLETE;
        if (merged != CHECKLIST_COMPLETE) revert ChecklistIncomplete(merged);
        s.checklist = merged;
        emit ChecklistUpdated(propertyId, merged);
        _setStatus(propertyId, PropertyStatus.Approved, note);
    }

    /// @notice "Reject" in the decision rail. A note is mandatory, as in the UI.
    function rejectProperty(uint256 propertyId, string calldata note)
        external
        onlyRole(ADMIN_ROLE)
        propertyExists(propertyId)
    {
        if (bytes(note).length == 0) revert NoteRequired();
        if (!_isReviewable(_state[propertyId].status)) revert InvalidStatus(_state[propertyId].status);
        _setStatus(propertyId, PropertyStatus.Rejected, note);
    }

    /// @notice "Request more information". A note is mandatory, as in the UI.
    function requestPropertyInfo(uint256 propertyId, string calldata note)
        external
        onlyRole(ADMIN_ROLE)
        propertyExists(propertyId)
    {
        if (bytes(note).length == 0) revert NoteRequired();
        if (!_isReviewable(_state[propertyId].status)) revert InvalidStatus(_state[propertyId].status);
        _setStatus(propertyId, PropertyStatus.ActionRequired, note);
    }

    /// @notice Valuation review queue: a new independent valuation moves the NAV
    ///         and, for the primary sale, the token price.
    function updateValuation(uint256 propertyId, uint256 valuation)
        external
        onlyRole(ADMIN_ROLE)
        propertyExists(propertyId)
    {
        if (valuation == 0) revert InvalidTerms();
        _info[propertyId].valuation = valuation;
        PropertyState storage s = _state[propertyId];
        s.tokenPrice = (valuation * TOKEN_UNIT) / _terms[propertyId].tokenSupply;
        s.lastUpdatedAt = uint64(block.timestamp);
        emit ValuationUpdated(propertyId, valuation, s.tokenPrice);
    }

    /* ---------------------------------------------------------------------- */
    /* Admin: tokenization (`/admin/tokenization`)                              */
    /* ---------------------------------------------------------------------- */

    /// @notice "Approve Tokenization" - the single step that publishes an asset.
    ///         Deploys the ERC-20, mints the full supply per the approved split,
    ///         starts the lock-up clock and lists the property.
    function approveTokenization(uint256 propertyId)
        external
        onlyRole(ADMIN_ROLE)
        propertyExists(propertyId)
        nonReentrant
    {
        PropertyState storage s = _state[propertyId];
        if (s.status != PropertyStatus.Approved) revert InvalidStatus(s.status);
        if (s.tokenizationStatus != TokenizationStatus.Pending) revert InvalidTokenizationStatus(s.tokenizationStatus);

        PropertyInfo storage info = _info[propertyId];
        OfferingTerms storage terms = _terms[propertyId];

        uint256 investorAllocation = _investorAllocationTokens(terms);
        uint256 merchantRetention = (terms.tokenSupply * terms.merchantRetentionPct) / 100;
        uint256 treasuryAllocation = terms.tokenSupply - investorAllocation - merchantRetention;
        uint64 lockupEnd = uint64(block.timestamp + uint256(terms.lockupMonths) * 30 days);

        address token = tokenFactory.create(info.name, info.tokenSymbol, address(usd), propertyId, lockupEnd);
        PropertyToken(token).mintSupply(investorAllocation, s.merchant, merchantRetention, treasury, treasuryAllocation);

        s.token = token;
        s.lockupEnd = lockupEnd;
        s.availableTokens = investorAllocation;
        s.tokenizationStatus = TokenizationStatus.Active;
        s.tokenizationNote = "";

        emit PropertyTokenized(propertyId, token, investorAllocation, merchantRetention, treasuryAllocation, lockupEnd);
        emit TokenizationStatusChanged(propertyId, TokenizationStatus.Active, msg.sender, "");
        _setStatus(propertyId, PropertyStatus.Tokenized, "");
    }

    function rejectTokenization(uint256 propertyId, string calldata note)
        external
        onlyRole(ADMIN_ROLE)
        propertyExists(propertyId)
    {
        _setTokenizationStatus(propertyId, TokenizationStatus.Rejected, note);
    }

    /// @notice "Request changes": sends the terms back to the merchant as a draft.
    function requestTokenizationChanges(uint256 propertyId, string calldata note)
        external
        onlyRole(ADMIN_ROLE)
        propertyExists(propertyId)
    {
        _setTokenizationStatus(propertyId, TokenizationStatus.Draft, note);
    }

    /* ---------------------------------------------------------------------- */
    /* Investor: wallet (`/user/wallet`)                                        */
    /* ---------------------------------------------------------------------- */

    /// @notice "Deposit": pull tUSD from the caller into their LandVest wallet.
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usd.safeTransferFrom(msg.sender, address(this), amount);
        walletBalanceOf[msg.sender] += amount;
        _record(TxType.Deposit, msg.sender, 0, amount, 0);
        emit Deposited(msg.sender, amount);
    }

    /// @notice "Withdraw": push tUSD from the LandVest wallet back to the caller.
    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = walletBalanceOf[msg.sender];
        if (amount > balance) revert InsufficientFunds(amount, balance);
        walletBalanceOf[msg.sender] = balance - amount;
        usd.safeTransfer(msg.sender, amount);
        _record(TxType.Withdrawal, msg.sender, 0, amount, 0);
        emit Withdrawn(msg.sender, amount);
    }

    /* ---------------------------------------------------------------------- */
    /* Investor: buy tokens (`/user/properties/[id]` investment panel)          */
    /* ---------------------------------------------------------------------- */

    /// @notice "Buy Tokens" -> "Confirm". `amount` is the USD ticket; the fee is
    ///         charged on top, exactly as the order summary in the panel shows.
    function buyTokens(uint256 propertyId, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        propertyExists(propertyId)
        returns (uint256 tokens, uint256 fee)
    {
        if (!compliance.canInvest(msg.sender)) revert KycNotApproved();
        PropertyState storage s = _state[propertyId];
        if (s.status != PropertyStatus.Tokenized) revert NotTokenized();

        OfferingTerms storage terms = _terms[propertyId];
        if (amount < terms.minimumInvestment) revert BelowMinimum(terms.minimumInvestment);
        if (amount > terms.maximumInvestment) revert AboveMaximum(terms.maximumInvestment);

        tokens = quoteTokens(propertyId, amount);
        if (tokens == 0) revert ZeroAmount();
        if (tokens > s.availableTokens) revert InsufficientTokens(tokens, s.availableTokens);

        fee = quoteFee(amount);
        uint256 total = amount + fee;
        uint256 balance = walletBalanceOf[msg.sender];
        if (total > balance) revert InsufficientFunds(total, balance);

        // Effects
        walletBalanceOf[msg.sender] = balance - total;
        walletBalanceOf[treasury] += fee;
        totalFeesCollected += fee;
        totalInvested += amount;

        s.fundingRaised += amount;
        s.availableTokens -= tokens;
        s.lastUpdatedAt = uint64(block.timestamp);

        Holding storage h = _holdings[msg.sender][propertyId];
        if (h.firstInvestedAt == 0) {
            h.firstInvestedAt = uint64(block.timestamp);
            s.investorCount += 1;
            _investorProperties[msg.sender].push(propertyId);
        }
        h.costBasis += amount;
        h.tokensBought += tokens;

        // Interaction: primary sale from the platform's allocation
        PropertyToken(s.token).transfer(msg.sender, tokens);

        _record(TxType.Investment, msg.sender, propertyId, amount, tokens);
        _record(TxType.Fee, msg.sender, propertyId, fee, 0);
        emit TokensPurchased(propertyId, msg.sender, amount, fee, tokens);
    }

    /* ---------------------------------------------------------------------- */
    /* Income distributions                                                     */
    /* ---------------------------------------------------------------------- */

    /// @notice Merchant pays rental / yield income to every token holder pro-rata.
    function distributeIncome(uint256 propertyId, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        onlyPropertyMerchant(propertyId)
    {
        if (amount == 0) revert ZeroAmount();
        PropertyState storage s = _state[propertyId];
        if (s.status != PropertyStatus.Tokenized) revert NotTokenized();
        usd.safeTransferFrom(msg.sender, s.token, amount);
        PropertyToken(s.token).distribute(amount);
        emit IncomeDistributed(propertyId, msg.sender, amount);
    }

    /// @notice Investor collects their share into their LandVest wallet.
    function claimDistribution(uint256 propertyId)
        external
        whenNotPaused
        nonReentrant
        propertyExists(propertyId)
        returns (uint256 amount)
    {
        PropertyState storage s = _state[propertyId];
        if (s.status != PropertyStatus.Tokenized) revert NotTokenized();
        amount = PropertyToken(s.token).withdrawDividendFor(msg.sender, address(this));
        walletBalanceOf[msg.sender] += amount;
        _record(TxType.Distribution, msg.sender, propertyId, amount, 0);
        emit DistributionClaimed(propertyId, msg.sender, amount);
    }

    /* ---------------------------------------------------------------------- */
    /* Admin: platform settings (`/admin/settings`)                             */
    /* ---------------------------------------------------------------------- */

    function updateSettings(
        uint256 feeBps,
        uint256 minFee,
        uint256 maximumInvestment,
        uint32 lockupMonths,
        address treasury_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > 1_000) revert InvalidTerms(); // hard cap 10 %
        if (treasury_ == address(0)) revert ZeroAddress();
        platformFeeBps = feeBps;
        minPlatformFee = minFee;
        defaultMaximumInvestment = maximumInvestment;
        defaultLockupMonths = lockupMonths;
        treasury = treasury_;
        emit SettingsUpdated(feeBps, minFee, maximumInvestment, lockupMonths, treasury_);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /* ---------------------------------------------------------------------- */
    /* Views                                                                    */
    /* ---------------------------------------------------------------------- */

    function getPropertyInfo(uint256 propertyId) external view propertyExists(propertyId) returns (PropertyInfo memory) {
        return _info[propertyId];
    }

    function getTerms(uint256 propertyId) external view propertyExists(propertyId) returns (OfferingTerms memory) {
        return _terms[propertyId];
    }

    function getState(uint256 propertyId) external view propertyExists(propertyId) returns (PropertyState memory) {
        return _state[propertyId];
    }

    function propertyIdBySlug(string calldata slug) external view returns (uint256) {
        return _idBySlug[keccak256(bytes(slug))];
    }

    function merchantProperties(address merchant) external view returns (uint256[] memory) {
        return _merchantProperties[merchant];
    }

    /// @notice Every property live in the public marketplace (`/properties`).
    function listedPropertyIds() external view returns (uint256[] memory ids) {
        uint256 n;
        for (uint256 i = 1; i <= propertyCount; i++) {
            if (_state[i].status == PropertyStatus.Tokenized) n++;
        }
        ids = new uint256[](n);
        uint256 j;
        for (uint256 i = 1; i <= propertyCount; i++) {
            if (_state[i].status == PropertyStatus.Tokenized) ids[j++] = i;
        }
    }

    /// @notice Live token balance plus the cost basis the UI needs for avg buy price and P/L.
    function getHolding(address investor, uint256 propertyId) external view propertyExists(propertyId) returns (Holding memory h) {
        h = _holdings[investor][propertyId];
        address token = _state[propertyId].token;
        h.quantity = token == address(0) ? 0 : PropertyToken(token).balanceOf(investor);
    }

    function investorProperties(address investor) external view returns (uint256[] memory) {
        return _investorProperties[investor];
    }

    function claimableIncome(address investor, uint256 propertyId) external view propertyExists(propertyId) returns (uint256) {
        address token = _state[propertyId].token;
        return token == address(0) ? 0 : PropertyToken(token).withdrawableDividendOf(investor);
    }

    /// @notice `tokenNav` in the UI: valuation / supply, in USD (6 dec) per whole token.
    function tokenNav(uint256 propertyId) public view propertyExists(propertyId) returns (uint256) {
        return (_info[propertyId].valuation * TOKEN_UNIT) / _terms[propertyId].tokenSupply;
    }

    /// @notice `estimateTokens(amount, tokenPrice)` in the UI.
    function quoteTokens(uint256 propertyId, uint256 amount) public view propertyExists(propertyId) returns (uint256) {
        uint256 price = _state[propertyId].tokenPrice;
        return price == 0 ? 0 : (amount * TOKEN_UNIT) / price;
    }

    /// @notice `platformFee(amount)` in the UI: max(amount * 0.5 %, $1).
    function quoteFee(uint256 amount) public view returns (uint256) {
        if (amount == 0) return 0;
        uint256 fee = (amount * platformFeeBps) / BPS;
        return fee < minPlatformFee ? minPlatformFee : fee;
    }

    function ledgerLength() external view returns (uint256) {
        return _ledger.length;
    }

    function getLedgerEntry(uint256 id) external view returns (LedgerEntry memory) {
        return _ledger[id];
    }

    /// @notice Ledger ids for one user, oldest first (`/user/wallet` history).
    function userLedger(address user) external view returns (uint256[] memory) {
        return _userLedger[user];
    }

    /// @notice Paged read of the whole ledger (`/admin/transactions`).
    function getLedger(uint256 offset, uint256 limit) external view returns (LedgerEntry[] memory page) {
        uint256 len = _ledger.length;
        if (offset >= len) return new LedgerEntry[](0);
        uint256 end = offset + limit > len ? len : offset + limit;
        page = new LedgerEntry[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = _ledger[i];
    }

    /* ---------------------------------------------------------------------- */
    /* Internals                                                                */
    /* ---------------------------------------------------------------------- */

    function _requireExists(uint256 propertyId) private view {
        if (propertyId == 0 || propertyId > propertyCount) revert UnknownProperty();
    }

    function _isReviewable(PropertyStatus status) private pure returns (bool) {
        return status == PropertyStatus.Submitted || status == PropertyStatus.UnderReview || status == PropertyStatus.ActionRequired;
    }

    function _setStatus(uint256 propertyId, PropertyStatus status, string memory note) private {
        PropertyState storage s = _state[propertyId];
        s.status = status;
        if (bytes(note).length != 0) s.reviewNote = note;
        s.lastUpdatedAt = uint64(block.timestamp);
        emit PropertyStatusChanged(propertyId, status, msg.sender, note);
    }

    function _setTokenizationStatus(uint256 propertyId, TokenizationStatus status, string memory note) private {
        PropertyState storage s = _state[propertyId];
        if (s.tokenizationStatus != TokenizationStatus.Pending) revert InvalidTokenizationStatus(s.tokenizationStatus);
        s.tokenizationStatus = status;
        s.tokenizationNote = note;
        s.lastUpdatedAt = uint64(block.timestamp);
        emit TokenizationStatusChanged(propertyId, status, msg.sender, note);
    }

    /// @dev Mirrors the zod `tokenizationSchema`: every figure positive and
    ///      investor + merchant <= 100. Fills the two platform defaults.
    function _validateTerms(OfferingTerms calldata terms) private view returns (OfferingTerms memory out) {
        if (terms.tokenSupply == 0 || terms.initialNav == 0 || terms.minimumInvestment == 0 || terms.fundingTarget == 0) {
            revert InvalidTerms();
        }
        if (uint16(terms.investorAllocationPct) + uint16(terms.merchantRetentionPct) > 100) revert AllocationExceeds100();
        out = terms;
        if (out.maximumInvestment == 0) out.maximumInvestment = defaultMaximumInvestment;
        if (out.maximumInvestment < out.minimumInvestment) revert InvalidTerms();
        if (out.lockupMonths == 0) out.lockupMonths = defaultLockupMonths;
    }

    function _investorAllocationTokens(OfferingTerms memory terms) private pure returns (uint256) {
        return (terms.tokenSupply * terms.investorAllocationPct) / 100;
    }

    function _record(TxType txType, address user, uint256 propertyId, uint256 amount, uint256 tokenQuantity) private {
        uint256 id = _ledger.length;
        _ledger.push(LedgerEntry({
            id: id,
            timestamp: uint64(block.timestamp),
            txType: txType,
            user: user,
            propertyId: propertyId,
            amount: amount,
            tokenQuantity: tokenQuantity
        }));
        _userLedger[user].push(id);
        emit LedgerRecorded(id, user, txType, propertyId, amount, tokenQuantity);
    }
}
