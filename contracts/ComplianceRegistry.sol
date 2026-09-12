// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ComplianceRegistry
 * @notice Identity layer of the LandVest platform. Mirrors the investor KYC
 *         wizard (`/user/kyc`), the merchant KYB wizard (`/merchant/kyb`) and
 *         the admin verification queue (`/admin/verification`).
 *
 * Lifecycle (identical for KYC and KYB, matching `VerificationStatus` in the UI):
 *
 *   NotStarted --submit--> Pending --review--> Approved | Rejected | ActionRequired
 *                                                 ^                       |
 *                                                 +------- resubmit ------+
 *
 * Only an account holding `REVIEWER_ROLE` (the platform admin team) can move a
 * record out of `Pending`. Accounts can also be suspended, which every
 * money-moving action on the platform checks.
 */
contract ComplianceRegistry is AccessControl {
    bytes32 public constant REVIEWER_ROLE = keccak256("REVIEWER_ROLE");

    /// @dev Same five states, same order, as the UI's `VerificationStatus`.
    enum VerificationStatus {
        NotStarted,
        Pending,
        Approved,
        Rejected,
        ActionRequired
    }

    struct InvestorRecord {
        VerificationStatus kycStatus;
        bool suspended;
        /// @dev Off-chain pointer (IPFS CID / URL) to the encrypted KYC bundle.
        string metadataURI;
        uint64 submittedAt;
        uint64 reviewedAt;
    }

    struct MerchantRecord {
        VerificationStatus kybStatus;
        bool suspended;
        string companyName;
        string registrationNumber;
        string metadataURI;
        uint64 submittedAt;
        uint64 reviewedAt;
    }

    mapping(address => InvestorRecord) private _investors;
    mapping(address => MerchantRecord) private _merchants;

    /// @notice Every address that has ever submitted KYC, for the admin users table.
    address[] public investorList;
    /// @notice Every address that has ever submitted KYB, for the admin merchants table.
    address[] public merchantList;

    event KycSubmitted(address indexed investor, string metadataURI);
    event KycReviewed(address indexed investor, VerificationStatus status, address indexed reviewer);
    event KybSubmitted(address indexed merchant, string companyName, string registrationNumber);
    event KybReviewed(address indexed merchant, VerificationStatus status, address indexed reviewer);
    event InvestorSuspended(address indexed investor, bool suspended);
    event MerchantSuspended(address indexed merchant, bool suspended);

    error AlreadyPending();
    error NothingToReview();
    error InvalidDecision();
    error EmptyField();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REVIEWER_ROLE, admin);
    }

    /* ---------------------------------------------------------------------- */
    /* Investor KYC                                                             */
    /* ---------------------------------------------------------------------- */

    /// @notice Step 5 of the KYC wizard: "Submit for verification".
    function submitKyc(string calldata metadataURI) external {
        InvestorRecord storage record = _investors[msg.sender];
        if (record.kycStatus == VerificationStatus.Pending) revert AlreadyPending();
        if (record.submittedAt == 0) investorList.push(msg.sender);
        record.kycStatus = VerificationStatus.Pending;
        record.metadataURI = metadataURI;
        record.submittedAt = uint64(block.timestamp);
        emit KycSubmitted(msg.sender, metadataURI);
    }

    /// @notice Admin decision from the KYC review drawer. `status` must be
    ///         Approved, Rejected or ActionRequired.
    function reviewKyc(address investor, VerificationStatus status) external onlyRole(REVIEWER_ROLE) {
        InvestorRecord storage record = _investors[investor];
        if (record.submittedAt == 0) revert NothingToReview();
        if (status == VerificationStatus.NotStarted || status == VerificationStatus.Pending) {
            revert InvalidDecision();
        }
        record.kycStatus = status;
        record.reviewedAt = uint64(block.timestamp);
        emit KycReviewed(investor, status, msg.sender);
    }

    function setInvestorSuspended(address investor, bool suspended) external onlyRole(REVIEWER_ROLE) {
        _investors[investor].suspended = suspended;
        emit InvestorSuspended(investor, suspended);
    }

    /* ---------------------------------------------------------------------- */
    /* Merchant KYB                                                             */
    /* ---------------------------------------------------------------------- */

    /// @notice Step 4 of the KYB wizard: "Submit for review".
    function submitKyb(
        string calldata companyName,
        string calldata registrationNumber,
        string calldata metadataURI
    ) external {
        if (bytes(companyName).length == 0 || bytes(registrationNumber).length == 0) revert EmptyField();
        MerchantRecord storage record = _merchants[msg.sender];
        if (record.kybStatus == VerificationStatus.Pending) revert AlreadyPending();
        if (record.submittedAt == 0) merchantList.push(msg.sender);
        record.kybStatus = VerificationStatus.Pending;
        record.companyName = companyName;
        record.registrationNumber = registrationNumber;
        record.metadataURI = metadataURI;
        record.submittedAt = uint64(block.timestamp);
        emit KybSubmitted(msg.sender, companyName, registrationNumber);
    }

    /// @notice Admin decision from the KYB review drawer.
    function reviewKyb(address merchant, VerificationStatus status) external onlyRole(REVIEWER_ROLE) {
        MerchantRecord storage record = _merchants[merchant];
        if (record.submittedAt == 0) revert NothingToReview();
        if (status == VerificationStatus.NotStarted || status == VerificationStatus.Pending) {
            revert InvalidDecision();
        }
        record.kybStatus = status;
        record.reviewedAt = uint64(block.timestamp);
        emit KybReviewed(merchant, status, msg.sender);
    }

    function setMerchantSuspended(address merchant, bool suspended) external onlyRole(REVIEWER_ROLE) {
        _merchants[merchant].suspended = suspended;
        emit MerchantSuspended(merchant, suspended);
    }

    /* ---------------------------------------------------------------------- */
    /* Views                                                                    */
    /* ---------------------------------------------------------------------- */

    function getInvestor(address investor) external view returns (InvestorRecord memory) {
        return _investors[investor];
    }

    function getMerchant(address merchant) external view returns (MerchantRecord memory) {
        return _merchants[merchant];
    }

    function kycStatusOf(address investor) external view returns (VerificationStatus) {
        return _investors[investor].kycStatus;
    }

    function kybStatusOf(address merchant) external view returns (VerificationStatus) {
        return _merchants[merchant].kybStatus;
    }

    /// @notice The single gate the "Buy Tokens" button checks.
    function canInvest(address investor) external view returns (bool) {
        InvestorRecord storage record = _investors[investor];
        return record.kycStatus == VerificationStatus.Approved && !record.suspended;
    }

    /// @notice The gate the property submission wizard checks.
    function canListProperty(address merchant) external view returns (bool) {
        MerchantRecord storage record = _merchants[merchant];
        return record.kybStatus == VerificationStatus.Approved && !record.suspended;
    }

    function investorCount() external view returns (uint256) {
        return investorList.length;
    }

    function merchantCount() external view returns (uint256) {
        return merchantList.length;
    }
}
