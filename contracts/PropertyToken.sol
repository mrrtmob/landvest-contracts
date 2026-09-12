// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title PropertyToken
 * @notice One ERC-20 per tokenized property. Created by the platform the moment
 *         an admin approves a tokenization request (`/admin/tokenization`), and
 *         minted exactly once with the full supply split three ways:
 *
 *           investor allocation -> held by the platform for the primary sale
 *           merchant retention  -> the property owner
 *           treasury            -> the platform treasury
 *
 * Two rules from the offering terms are enforced here rather than trusted:
 *
 *  1. Lock-up. Until `lockupEnd`, tokens can only move to or from the platform
 *     (the primary sale). Holder-to-holder transfers revert, so nobody can dump
 *     a fresh issue on a secondary market before the lock-up expires.
 *
 *  2. Income distributions. Rental / yield income deposited by the merchant is
 *     shared pro-rata with every holder using the "magnified dividend per share"
 *     accounting pattern, so a holder's claimable amount stays correct across
 *     transfers without iterating over holders.
 */
contract PropertyToken is ERC20 {
    using SafeERC20 for IERC20;

    uint256 private constant MAGNITUDE = 2 ** 128;

    address public immutable platform;
    IERC20 public immutable usd;
    uint256 public immutable propertyId;
    uint64 public immutable lockupEnd;

    bool public minted;
    uint256 public totalDistributed;

    uint256 private _magnifiedDividendPerShare;
    mapping(address => int256) private _magnifiedDividendCorrections;
    mapping(address => uint256) private _withdrawnDividends;

    event SupplyMinted(uint256 investorAllocation, uint256 merchantRetention, uint256 treasuryAllocation);
    event IncomeDistributed(uint256 amount, uint256 totalDistributed);
    event DividendWithdrawn(address indexed holder, address indexed to, uint256 amount);

    error OnlyPlatform();
    error AlreadyMinted();
    error TransferLocked(uint64 lockupEnd);
    error NoSupply();
    error NothingToClaim();

    modifier onlyPlatform() {
        if (msg.sender != platform) revert OnlyPlatform();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address platform_,
        address usd_,
        uint256 propertyId_,
        uint64 lockupEnd_
    ) ERC20(name_, symbol_) {
        platform = platform_;
        usd = IERC20(usd_);
        propertyId = propertyId_;
        lockupEnd = lockupEnd_;
    }

    /* ---------------------------------------------------------------------- */
    /* Issuance                                                                 */
    /* ---------------------------------------------------------------------- */

    /// @notice One-shot mint of the full supply according to the approved split.
    function mintSupply(
        uint256 investorAllocation,
        address merchant,
        uint256 merchantRetention,
        address treasury,
        uint256 treasuryAllocation
    ) external onlyPlatform {
        if (minted) revert AlreadyMinted();
        minted = true;
        if (investorAllocation > 0) _mint(platform, investorAllocation);
        if (merchantRetention > 0) _mint(merchant, merchantRetention);
        if (treasuryAllocation > 0) _mint(treasury, treasuryAllocation);
        emit SupplyMinted(investorAllocation, merchantRetention, treasuryAllocation);
    }

    /* ---------------------------------------------------------------------- */
    /* Lock-up                                                                  */
    /* ---------------------------------------------------------------------- */

    function isLocked() public view returns (bool) {
        return block.timestamp < lockupEnd;
    }

    function _update(address from, address to, uint256 value) internal override {
        bool isMint = from == address(0);
        bool isBurn = to == address(0);
        bool touchesPlatform = from == platform || to == platform;
        if (!isMint && !isBurn && !touchesPlatform && isLocked()) {
            revert TransferLocked(lockupEnd);
        }

        super._update(from, to, value);

        // Keep each side's claimable income unchanged by the balance movement.
        int256 correction = _toInt256(_magnifiedDividendPerShare * value);
        if (!isMint) _magnifiedDividendCorrections[from] += correction;
        if (!isBurn) _magnifiedDividendCorrections[to] -= correction;
    }

    /* ---------------------------------------------------------------------- */
    /* Income distribution                                                      */
    /* ---------------------------------------------------------------------- */

    /// @notice Called by the platform after it has transferred `amount` tUSD to
    ///         this contract. Every current holder's claimable income grows by
    ///         `amount * balance / totalSupply`.
    function distribute(uint256 amount) external onlyPlatform {
        uint256 supply = totalSupply();
        if (supply == 0) revert NoSupply();
        if (amount == 0) return;
        _magnifiedDividendPerShare += (amount * MAGNITUDE) / supply;
        totalDistributed += amount;
        emit IncomeDistributed(amount, totalDistributed);
    }

    /// @notice Income earned by `holder` since the token was minted, claimed or not.
    function accumulativeDividendOf(address holder) public view returns (uint256) {
        int256 magnified = _toInt256(_magnifiedDividendPerShare * balanceOf(holder)) +
            _magnifiedDividendCorrections[holder];
        return uint256(magnified) / MAGNITUDE;
    }

    /// @notice Income `holder` can claim right now.
    function withdrawableDividendOf(address holder) public view returns (uint256) {
        return accumulativeDividendOf(holder) - _withdrawnDividends[holder];
    }

    function withdrawnDividendOf(address holder) external view returns (uint256) {
        return _withdrawnDividends[holder];
    }

    /// @notice Pays `holder`'s claimable income to `to`. Only the platform calls
    ///         this so the payout lands in the holder's LandVest wallet and is
    ///         written to the ledger as a `Distribution`.
    function withdrawDividendFor(address holder, address to) external onlyPlatform returns (uint256 amount) {
        amount = withdrawableDividendOf(holder);
        if (amount == 0) revert NothingToClaim();
        _withdrawnDividends[holder] += amount;
        usd.safeTransfer(to, amount);
        emit DividendWithdrawn(holder, to, amount);
    }

    function _toInt256(uint256 value) private pure returns (int256) {
        require(value <= uint256(type(int256).max), "PropertyToken: overflow");
        return int256(value);
    }
}

/**
 * @title PropertyTokenFactory
 * @notice Deploys `PropertyToken`s on behalf of the platform. Kept separate so
 *         the token creation bytecode does not live inside the platform contract.
 */
contract PropertyTokenFactory {
    address public platform;
    address public immutable deployer;

    error OnlyPlatform();
    error PlatformAlreadySet();

    constructor() {
        deployer = msg.sender;
    }

    function setPlatform(address platform_) external {
        if (platform != address(0) || msg.sender != deployer) revert PlatformAlreadySet();
        platform = platform_;
    }

    function create(
        string calldata name,
        string calldata symbol,
        address usd,
        uint256 propertyId,
        uint64 lockupEnd
    ) external returns (address) {
        if (msg.sender != platform) revert OnlyPlatform();
        PropertyToken token = new PropertyToken(name, symbol, platform, usd, propertyId, lockupEnd);
        return address(token);
    }
}
