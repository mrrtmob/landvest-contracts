# LandVest on-chain architecture

This document explains how the UI flow of the LandVest demo maps onto the smart contracts, what each
contract stores, which rules it enforces, and the decisions behind the design.

## 1. From UI flow to contracts

The UI (`land-investment`) is a three-portal demo: **Merchant** lists a property, **Admin** verifies and
tokenizes it, **Investor** buys tokens. Its "five-minute demo" is reproduced one-to-one on-chain:

| # | Portal | UI screen / action | Contract call | Resulting state |
|---|---|---|---|---|
| 1 | Merchant | `/merchant/kyb` — KYB already Approved | `ComplianceRegistry.submitKyb` then admin `reviewKyb(Approved)` | `canListProperty(merchant) == true` |
| 2 | Merchant | `/merchant/properties/new` — 6-step wizard, Submit | `LandVestPlatform.submitProperty(info, terms)` | property `Submitted`, tokenization `Pending` |
| 3 | Merchant | `/merchant/properties` — asset shows Submitted | `getState(id).status` | — |
| 4 | Admin | `/admin/properties` → Pending → open | `startReview(id)` (optional) | `UnderReview` |
| 5 | Admin | tick all 7 checklist items, Approve | `setChecklist(id, mask)` / `approveProperty(id, mask, note)` | `Approved` — **not listed** |
| 6 | Admin | `/admin/tokenization` → Approve Tokenization | `approveTokenization(id)` | `Tokenized`; ERC-20 deployed and minted |
| 7 | Public | `/properties` — asset is listed | `listedPropertyIds()` | — |
| 8 | Investor | enter $2,000 → Buy Tokens → Confirm | `deposit(amount)` then `buyTokens(id, amount)` | 1,000 tokens, $10 fee, $2,010 debited |
| 9 | Investor | `/user/dashboard`, `/user/wallet` | `getHolding`, `walletBalanceOf`, `userLedger` | holding + two ledger rows |
| 10 | Merchant | `/merchant/dashboard` — funding increased | `getState(id).fundingRaised` | — |

The KYC gate ("Complete KYC to invest") is `ComplianceRegistry.canInvest`, checked inside `buyTokens`.

### Status enums are the UI unions, in the same order

```
PropertyStatus       draft, submitted, under_review, action_required, approved, rejected, tokenized
TokenizationStatus   draft, pending, approved, rejected, active
VerificationStatus   not_started, pending, approved, rejected, action_required
TransactionType      investment, deposit, withdrawal, distribution, fee
```

So `Number(state.status)` indexes straight into the UI's label maps.

## 2. Contracts

```
                 ┌────────────────────┐   canInvest / canListProperty   ┌──────────────────────┐
                 │ ComplianceRegistry │ <────────────────────────────── │   LandVestPlatform   │
                 │  KYC / KYB records │                                 │ properties, wallet,  │
                 └────────────────────┘                                 │ sale, ledger, fees   │
                                                                        └──────────┬───────────┘
                 ┌────────────────────┐   create(name, symbol, …)                  │
                 │PropertyTokenFactory│ <──────────────────────────────────────────┤
                 └─────────┬──────────┘                                            │ transfer (primary sale)
                           │ new                                                   │ distribute / withdrawDividendFor
                           v                                                       v
                 ┌────────────────────┐                                 ┌──────────────────────┐
                 │   PropertyToken    │  one per tokenized property     │       MockUSD        │
                 │ ERC-20 + lock-up + │ <────── holds income in tUSD ── │ 6-dec test stablecoin│
                 │ income accounting  │                                 └──────────────────────┘
                 └────────────────────┘
```

### 2.1 `ComplianceRegistry`

* `submitKyc(metadataURI)` / `submitKyb(companyName, registrationNumber, metadataURI)` — the last step
  of the two wizards. A record can be resubmitted after `Rejected` or `ActionRequired`; it cannot be
  resubmitted while `Pending`.
* `reviewKyc(investor, status)` / `reviewKyb(merchant, status)` — `REVIEWER_ROLE` only; the decision must
  be `Approved`, `Rejected` or `ActionRequired`.
* `setInvestorSuspended` / `setMerchantSuspended` — the admin "Suspend account" action.
* `canInvest(addr)` and `canListProperty(addr)` are the two gates the platform calls.
* `investorList` / `merchantList` back the admin Users and Merchants tables.

Documents never go on-chain: `metadataURI` points at an (encrypted) off-chain bundle.

### 2.2 `LandVestPlatform`

State is split into three structs per property so the getters do not hit stack limits:

* `PropertyInfo` — what the merchant typed in wizard steps 1–4: slug, name, symbol, location, `metadataURI`,
  type, land area, valuation, and `documentsHash` (keccak of the uploaded document list).
* `OfferingTerms` — wizard step 5: supply, initial NAV, investor/merchant split, min/max ticket, funding
  target, lock-up, expected yield (bps). Validated like the zod schema: everything positive,
  `investor + merchant <= 100`, `max >= min`. Zero `maximumInvestment` / `lockupMonths` take the platform
  defaults ($100,000 / 12 months), exactly like `demo-store.submitProperty`.
* `PropertyState` — everything that changes afterwards: statuses, merchant, token address, token price,
  funding raised, available tokens, investor count, checklist bitmask, notes, timestamps, lock-up end.

**Merchant** functions: `submitProperty`, `resubmitProperty` (answers *Action Required*), `updateTerms`
(answers *Changes requested* on the tokenization), `distributeIncome`.

**Admin** functions (`ADMIN_ROLE`): `startReview`, `setChecklist`, `approveProperty`, `rejectProperty`,
`requestPropertyInfo`, `updateValuation`, `approveTokenization`, `rejectTokenization`,
`requestTokenizationChanges`, `updateSettings`, `pause`/`unpause`.

**Investor** functions: `deposit`, `withdraw`, `buyTokens`, `claimDistribution`.

Rules enforced (each one has a test):

| Rule in the UI | Where it is enforced on-chain |
|---|---|
| Approve button disabled until all 7 checklist items are ticked | `approveProperty` reverts `ChecklistIncomplete` unless `checklist == 0x7F` |
| Reject / Request info require a note | `NoteRequired` |
| Approval does **not** list the asset; tokenization does | `approveTokenization` requires `Approved`; `listedPropertyIds` filters `Tokenized` |
| Tokenization can be approved once | second call reverts `InvalidStatus` |
| "Complete KYC to invest" | `KycNotApproved` |
| Minimum / maximum investment | `BelowMinimum` / `AboveMaximum` |
| Fee = max(0.5 % × amount, $1), charged on top | `quoteFee`; wallet must cover `amount + fee` (`InsufficientFunds`) |
| Only the investor allocation is for sale | `InsufficientTokens` |
| Funding raised, available tokens, investor count update on purchase | `buyTokens` effects |
| Two ledger rows per purchase (investment + fee) | `_record` |
| Investor / merchant split, treasury gets the rest | `approveTokenization` minting |
| Lock-up months | `PropertyToken.lockupEnd` |

Units: USD is 6-decimal (`$1 = 1_000_000`), tokens are 18-decimal, `tokenPrice` is USD per whole
token, `tokens = amount * 1e18 / tokenPrice` — the integer form of `estimateTokens()` in
`lib/tokenomics.ts`.

The **internal wallet** (`walletBalanceOf`) mirrors the UI's wallet: `deposit` pulls tUSD in,
`withdraw` pushes it out, purchases and fees move balances internally. The platform fee accrues to the
treasury's wallet balance and can be withdrawn like any other balance.

The **ledger** (`LedgerEntry[]`, `userLedger`, `getLedger(offset, limit)`) is what `/user/wallet`
history and `/admin/transactions` read.

### 2.3 `PropertyToken` and `PropertyTokenFactory`

`approveTokenization` asks the factory to deploy a fresh ERC-20 named after the property and mints the
whole supply once:

* investor allocation → held by the platform for the primary sale,
* merchant retention → the merchant,
* remainder (treasury %) → the treasury.

Two term rules live in the token so no one can bypass them:

* **Lock-up.** Until `lockupEnd` (`lockupMonths × 30 days` from tokenization) a transfer must involve
  the platform. The primary sale works; holder-to-holder transfers revert `TransferLocked`. The
  merchant's retained tokens are locked too.
* **Income distribution.** `distributeIncome` moves tUSD from the merchant into the token contract and
  calls `distribute(amount)`, which raises a magnified per-share accumulator. Every holder's claim is
  `balance × accumulator` with per-address corrections updated in `_update`, so the numbers stay right
  across transfers without looping over holders. `claimDistribution` pays the share into the holder's
  LandVest wallet and records a `Distribution` ledger row. Integer division floors, so a claim can be
  short by 1 unit ($0.000001); the dust stays in the token contract.

The factory exists so that the `PropertyToken` creation bytecode is not embedded in the platform,
keeping `LandVestPlatform` under the 24 KB deploy limit (≈19.7 KB with the optimizer).

### 2.4 `MockUSD`

A stand-in for USDC on test networks: 6 decimals, owner-mintable, plus `faucet()` that gives any
caller 10,000 tUSD. Replace with the real stablecoin address in the platform constructor for a
production deployment and drop the faucet.

## 3. Roles

| Role | Contract | Who |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | both | deployer; can grant roles and change settings |
| `ADMIN_ROLE` | `LandVestPlatform` | the review team: property, tokenization, valuation, pause |
| `REVIEWER_ROLE` | `ComplianceRegistry` | the review team: KYC / KYB decisions, suspensions |
| merchant | implicit | any address with an approved KYB record |
| investor | implicit | any address with an approved KYC record |

## 4. Events

Every state change emits an event the UI or an indexer can follow: `PropertySubmitted`,
`PropertyStatusChanged`, `ChecklistUpdated`, `TokenizationStatusChanged`, `PropertyTokenized`,
`ValuationUpdated`, `Deposited`, `Withdrawn`, `TokensPurchased`, `IncomeDistributed`,
`DistributionClaimed`, `LedgerRecorded`, `SettingsUpdated`, plus `KycSubmitted/Reviewed`,
`KybSubmitted/Reviewed` on the registry.

## 5. Security notes

* Checks-effects-interactions plus `ReentrancyGuard` on every function that moves tokens or tUSD.
* `Pausable` on deposits, withdrawals, purchases, submissions and distributions.
* Custom errors everywhere (cheaper, and the UI decodes them into readable messages).
* `SafeERC20` for the stablecoin; the platform never trusts a return value.
* The platform holds unsold investor allocation and all deposited tUSD — it is the custody point.
  Upgrading it later would need a migration function or a proxy; neither is included in this version.

## 6. What is deliberately off-chain

Descriptions, galleries, boundaries, document files, valuer names, KYC documents. They are large,
mutable and private; the chain stores their hash / URI. In the demo UI these fields are kept in the
browser (`localStorage`) for wizard-submitted listings and taken from the fixtures for the seeded ones.

## 7. Testing

`test/LandVest.ts` — 35 cases run by `npx hardhat test`:

* Compliance: KYC and KYB lifecycle, reviewer-only decisions, resubmission, suspension.
* Submission: KYB gate, created state, zod-equivalent validation, defaults, slug uniqueness.
* Review: checklist gate, admin-only, mandatory notes, request-info → resubmit → approve, valuation.
* Tokenization: two-step gate, deployment and 40/55/5 mint, single approval, request changes → new
  terms → approve, rejection keeps the asset unlisted.
* Wallet: deposit, withdraw, insufficient funds, ledger rows.
* Purchase: the $2,000 → 1,000 PPRD / $10 fee / $2,010 demo, $1 minimum fee, repeat buys, KYC gate,
  min/max, insufficient funds, not tokenized, oversubscription, pause.
* Token: lock-up, platform-only mint.
* Distributions: pro-rata claim into the wallet, merchant-only.
* Settings and paged ledger.
