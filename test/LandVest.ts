import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress } from "viem";

import {
  CHECKLIST_COMPLETE,
  PropertyStatus,
  SAMPLE_INFO,
  SAMPLE_TERMS,
  TokenizationStatus,
  TxType,
  Verification,
  approveAndTokenize,
  approveInvestor,
  approveMerchant,
  deployPlatform,
  fundWallet,
  listedSample,
  submitSample,
  tok,
  usd,
} from "./helpers.js";

describe("ComplianceRegistry (KYC / KYB)", () => {
  it("walks an investor through NotStarted -> Pending -> Approved", async () => {
    const p = await deployPlatform();
    assert.equal(await p.compliance.read.kycStatusOf([p.investor.account.address]), Verification.NotStarted);
    assert.equal(await p.compliance.read.canInvest([p.investor.account.address]), false);

    await p.compliance.write.submitKyc(["ipfs://kyc"], { account: p.investor.account });
    assert.equal(await p.compliance.read.kycStatusOf([p.investor.account.address]), Verification.Pending);
    assert.equal(await p.compliance.read.canInvest([p.investor.account.address]), false);

    await p.compliance.write.reviewKyc([p.investor.account.address, Verification.Approved]);
    assert.equal(await p.compliance.read.kycStatusOf([p.investor.account.address]), Verification.Approved);
    assert.equal(await p.compliance.read.canInvest([p.investor.account.address]), true);
    assert.equal(await p.compliance.read.investorCount(), 1n);
  });

  it("only a reviewer can decide, and only with a real decision", async () => {
    const p = await deployPlatform();
    await p.compliance.write.submitKyc(["ipfs://kyc"], { account: p.investor.account });

    await p.viem.assertions.revertWithCustomError(
      p.compliance.write.reviewKyc([p.investor.account.address, Verification.Approved], { account: p.stranger.account }),
      p.compliance,
      "AccessControlUnauthorizedAccount",
    );
    await p.viem.assertions.revertWithCustomError(
      p.compliance.write.reviewKyc([p.investor.account.address, Verification.Pending]),
      p.compliance,
      "InvalidDecision",
    );
    await p.viem.assertions.revertWithCustomError(
      p.compliance.write.reviewKyc([p.stranger.account.address, Verification.Approved]),
      p.compliance,
      "NothingToReview",
    );
  });

  it("lets a rejected investor resubmit, and a suspended one cannot invest", async () => {
    const p = await deployPlatform();
    await p.compliance.write.submitKyc(["ipfs://kyc"], { account: p.investor.account });
    await p.compliance.write.reviewKyc([p.investor.account.address, Verification.ActionRequired]);
    await p.compliance.write.submitKyc(["ipfs://kyc-v2"], { account: p.investor.account });
    assert.equal(await p.compliance.read.kycStatusOf([p.investor.account.address]), Verification.Pending);
    await p.compliance.write.reviewKyc([p.investor.account.address, Verification.Approved]);
    await p.compliance.write.setInvestorSuspended([p.investor.account.address, true]);
    assert.equal(await p.compliance.read.canInvest([p.investor.account.address]), false);
  });

  it("registers a merchant through KYB", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const record = await p.compliance.read.getMerchant([p.merchant.account.address]);
    assert.equal(record.companyName, "GreenFields Capital Ltd.");
    assert.equal(record.kybStatus, Verification.Approved);
    assert.equal(await p.compliance.read.canListProperty([p.merchant.account.address]), true);
    await p.viem.assertions.revertWithCustomError(
      p.compliance.write.submitKyb(["", "X", ""], { account: p.stranger.account }),
      p.compliance,
      "EmptyField",
    );
  });
});

describe("Merchant: property submission wizard", () => {
  it("requires an approved KYB", async () => {
    const p = await deployPlatform();
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.submitProperty([SAMPLE_INFO, SAMPLE_TERMS], { account: p.merchant.account }),
      p.platform,
      "KybNotApproved",
    );
  });

  it("creates the property as Submitted with a Pending tokenization request", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    assert.equal(id, 1n);

    const info = await p.platform.read.getPropertyInfo([id]);
    const terms = await p.platform.read.getTerms([id]);
    const state = await p.platform.read.getState([id]);

    assert.equal(info.name, SAMPLE_INFO.name);
    assert.equal(info.tokenSymbol, "PPRD");
    assert.equal(terms.tokenSupply, tok(1_000_000));
    assert.equal(state.status, PropertyStatus.Submitted);
    assert.equal(state.tokenizationStatus, TokenizationStatus.Pending);
    assert.equal(getAddress(state.merchant), getAddress(p.merchant.account.address));
    assert.equal(state.tokenPrice, usd(2));
    assert.equal(state.availableTokens, tok(400_000)); // 40 % of 1,000,000
    assert.equal(state.fundingRaised, 0n);
    assert.equal(await p.platform.read.propertyIdBySlug(["pprd"]), 1n);
    assert.deepEqual(await p.platform.read.merchantProperties([p.merchant.account.address]), [1n]);
    assert.deepEqual(await p.platform.read.listedPropertyIds(), []);
  });

  it("validates the terms the way the wizard's zod schema does", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.submitProperty(
        [SAMPLE_INFO, { ...SAMPLE_TERMS, investorAllocationPct: 60, merchantRetentionPct: 50 }],
        { account: p.merchant.account },
      ),
      p.platform,
      "AllocationExceeds100",
    );
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.submitProperty([SAMPLE_INFO, { ...SAMPLE_TERMS, initialNav: 0n }], {
        account: p.merchant.account,
      }),
      p.platform,
      "InvalidTerms",
    );
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.submitProperty([{ ...SAMPLE_INFO, name: "" }, SAMPLE_TERMS], {
        account: p.merchant.account,
      }),
      p.platform,
      "EmptyField",
    );
    await submitSample(p);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.submitProperty([SAMPLE_INFO, SAMPLE_TERMS], { account: p.merchant.account }),
      p.platform,
      "SlugTaken",
    );
  });

  it("fills the platform defaults for maximum investment and lock-up", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p, {}, { ...SAMPLE_TERMS, maximumInvestment: 0n, lockupMonths: 0 });
    const terms = await p.platform.read.getTerms([id]);
    assert.equal(terms.maximumInvestment, usd(100_000));
    assert.equal(terms.lockupMonths, 12);
  });
});

describe("Admin: property review", () => {
  it("cannot approve until all seven checklist items are ticked", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);

    // Tick six of seven from the review rail.
    await p.platform.write.setChecklist([id, 0b0111111]);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.approveProperty([id, 0, "looks good"]),
      p.platform,
      "ChecklistIncomplete",
    );
    // Tick the last one at approval time.
    await p.platform.write.approveProperty([id, 0b1000000, "looks good"]);
    const state = await p.platform.read.getState([id]);
    assert.equal(state.status, PropertyStatus.Approved);
    assert.equal(state.checklist, CHECKLIST_COMPLETE);
    assert.equal(state.reviewNote, "looks good");
    // Approved but NOT yet listed.
    assert.deepEqual(await p.platform.read.listedPropertyIds(), []);
  });

  it("only an admin can review", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.approveProperty([id, CHECKLIST_COMPLETE, ""], { account: p.merchant.account }),
      p.platform,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("rejection and information requests require a note", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.rejectProperty([id, ""]),
      p.platform,
      "NoteRequired",
    );
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.requestPropertyInfo([id, ""]),
      p.platform,
      "NoteRequired",
    );
    await p.platform.write.rejectProperty([id, "Title deed does not match the registry."]);
    assert.equal((await p.platform.read.getState([id])).status, PropertyStatus.Rejected);
  });

  it("request info -> merchant resubmits -> under review -> approved", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.platform.write.setChecklist([id, 0b0000011]);
    await p.platform.write.requestPropertyInfo([id, "Please upload the latest survey."]);
    assert.equal((await p.platform.read.getState([id])).status, PropertyStatus.ActionRequired);

    await p.viem.assertions.revertWithCustomError(
      p.platform.write.resubmitProperty([id, "ipfs://v2", SAMPLE_INFO.documentsHash], { account: p.stranger.account }),
      p.platform,
      "NotMerchantOfProperty",
    );
    await p.platform.write.resubmitProperty([id, "ipfs://v2", SAMPLE_INFO.documentsHash], {
      account: p.merchant.account,
    });
    let state = await p.platform.read.getState([id]);
    assert.equal(state.status, PropertyStatus.Submitted);
    assert.equal(state.checklist, 0); // review starts over
    assert.equal((await p.platform.read.getPropertyInfo([id])).metadataURI, "ipfs://v2");

    await p.platform.write.startReview([id]);
    assert.equal((await p.platform.read.getState([id])).status, PropertyStatus.UnderReview);
    await p.platform.write.approveProperty([id, CHECKLIST_COMPLETE, ""]);
    state = await p.platform.read.getState([id]);
    assert.equal(state.status, PropertyStatus.Approved);
  });

  it("a valuation review moves the NAV and the primary-sale price", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    assert.equal(await p.platform.read.tokenNav([id]), usd(2.04));
    await p.platform.write.updateValuation([id, usd(2_500_000)]);
    assert.equal(await p.platform.read.tokenNav([id]), usd(2.5));
    assert.equal((await p.platform.read.getState([id])).tokenPrice, usd(2.5));
  });
});

describe("Admin: tokenization", () => {
  it("is impossible before the property is approved (two-step gate)", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.approveTokenization([id]),
      p.platform,
      "InvalidStatus",
    );
  });

  it("deploys the token, mints the 40 / 55 / 5 split, and lists the property", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.platform.write.approveProperty([id, CHECKLIST_COMPLETE, ""]);

    await p.viem.assertions.emit(p.platform.write.approveTokenization([id]), p.platform, "PropertyTokenized");

    const state = await p.platform.read.getState([id]);
    assert.equal(state.status, PropertyStatus.Tokenized);
    assert.equal(state.tokenizationStatus, TokenizationStatus.Active);
    assert.notEqual(state.token, "0x0000000000000000000000000000000000000000");
    assert.deepEqual(await p.platform.read.listedPropertyIds(), [id]);

    const token = await p.viem.getContractAt("PropertyToken", state.token);
    assert.equal(await token.read.name(), SAMPLE_INFO.name);
    assert.equal(await token.read.symbol(), "PPRD");
    assert.equal(await token.read.totalSupply(), tok(1_000_000));
    assert.equal(await token.read.balanceOf([p.platform.address]), tok(400_000)); // investor allocation
    assert.equal(await token.read.balanceOf([p.merchant.account.address]), tok(550_000)); // merchant retention
    assert.equal(await token.read.balanceOf([p.admin.account.address]), tok(50_000)); // treasury
    assert.equal(await token.read.isLocked(), true);

    const latest = await p.networkHelpers.time.latest();
    assert.equal(Number(state.lockupEnd), latest + 6 * 30 * 24 * 60 * 60);
  });

  it("can only be approved once", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.approveTokenization([id]),
      p.platform,
      "InvalidStatus",
    );
  });

  it("request changes -> merchant revises terms -> pending again -> approved", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.platform.write.approveProperty([id, CHECKLIST_COMPLETE, ""]);
    await p.platform.write.requestTokenizationChanges([id, "Revise the allocation split."]);
    let state = await p.platform.read.getState([id]);
    assert.equal(state.tokenizationStatus, TokenizationStatus.Draft);
    assert.equal(state.tokenizationNote, "Revise the allocation split.");

    await p.platform.write.updateTerms([id, { ...SAMPLE_TERMS, investorAllocationPct: 50, merchantRetentionPct: 45 }], {
      account: p.merchant.account,
    });
    state = await p.platform.read.getState([id]);
    assert.equal(state.tokenizationStatus, TokenizationStatus.Pending);
    assert.equal(state.availableTokens, tok(500_000));

    await p.platform.write.approveTokenization([id]);
    const token = await p.viem.getContractAt("PropertyToken", (await p.platform.read.getState([id])).token);
    assert.equal(await token.read.balanceOf([p.platform.address]), tok(500_000));
    assert.equal(await token.read.balanceOf([p.merchant.account.address]), tok(450_000));
  });

  it("rejecting a tokenization keeps the property approved but unlisted", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.platform.write.approveProperty([id, CHECKLIST_COMPLETE, ""]);
    await p.platform.write.rejectTokenization([id, "Supply too large for the valuation."]);
    const state = await p.platform.read.getState([id]);
    assert.equal(state.status, PropertyStatus.Approved);
    assert.equal(state.tokenizationStatus, TokenizationStatus.Rejected);
    assert.deepEqual(await p.platform.read.listedPropertyIds(), []);
  });
});

describe("Investor: wallet", () => {
  it("deposits and withdraws tUSD through the LandVest wallet", async () => {
    const p = await deployPlatform();
    await p.usdToken.write.faucet({ account: p.investor.account });
    assert.equal(await p.usdToken.read.balanceOf([p.investor.account.address]), usd(10_000));

    await p.usdToken.write.approve([p.platform.address, usd(10_250)], { account: p.investor.account });
    await p.platform.write.deposit([usd(10_000)], { account: p.investor.account });
    assert.equal(await p.platform.read.walletBalanceOf([p.investor.account.address]), usd(10_000));
    assert.equal(await p.usdToken.read.balanceOf([p.investor.account.address]), 0n);

    await p.platform.write.withdraw([usd(250)], { account: p.investor.account });
    assert.equal(await p.platform.read.walletBalanceOf([p.investor.account.address]), usd(9_750));
    assert.equal(await p.usdToken.read.balanceOf([p.investor.account.address]), usd(250));

    await p.viem.assertions.revertWithCustomError(
      p.platform.write.withdraw([usd(20_000)], { account: p.investor.account }),
      p.platform,
      "InsufficientFunds",
    );
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.deposit([0n], { account: p.investor.account }),
      p.platform,
      "ZeroAmount",
    );

    const ids = await p.platform.read.userLedger([p.investor.account.address]);
    assert.equal(ids.length, 2);
    const first = await p.platform.read.getLedgerEntry([ids[0]]);
    assert.equal(first.txType, TxType.Deposit);
    assert.equal(first.amount, usd(10_000));
  });
});

describe("Investor: buy tokens (the five-minute demo)", () => {
  it("$2,000 buys 1,000 PPRD, charges a $10 fee and debits $2,010", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(10_250)); // Daniel's opening balance

    assert.equal(await p.platform.read.quoteTokens([id, usd(2_000)]), tok(1_000));
    assert.equal(await p.platform.read.quoteFee([usd(2_000)]), usd(10));

    await p.viem.assertions.emitWithArgs(
      p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account }),
      p.platform,
      "TokensPurchased",
      [id, getAddress(p.investor.account.address), usd(2_000), usd(10), tok(1_000)],
    );

    // Wallet
    assert.equal(await p.platform.read.walletBalanceOf([p.investor.account.address]), usd(8_240));
    assert.equal(await p.platform.read.walletBalanceOf([p.admin.account.address]), usd(10)); // treasury fee

    // Holding
    const holding = await p.platform.read.getHolding([p.investor.account.address, id]);
    assert.equal(holding.quantity, tok(1_000));
    assert.equal(holding.costBasis, usd(2_000));
    assert.equal(holding.tokensBought, tok(1_000));
    assert.deepEqual(await p.platform.read.investorProperties([p.investor.account.address]), [id]);

    // Property (what the merchant dashboard reads)
    const state = await p.platform.read.getState([id]);
    assert.equal(state.fundingRaised, usd(2_000));
    assert.equal(state.availableTokens, tok(399_000));
    assert.equal(state.investorCount, 1n);

    // Ledger: deposit, investment, fee
    const ids = await p.platform.read.userLedger([p.investor.account.address]);
    assert.equal(ids.length, 3);
    const investment = await p.platform.read.getLedgerEntry([ids[1]]);
    const fee = await p.platform.read.getLedgerEntry([ids[2]]);
    assert.equal(investment.txType, TxType.Investment);
    assert.equal(investment.tokenQuantity, tok(1_000));
    assert.equal(fee.txType, TxType.Fee);
    assert.equal(fee.amount, usd(10));

    assert.equal(await p.platform.read.totalInvested(), usd(2_000));
    assert.equal(await p.platform.read.totalFeesCollected(), usd(10));
  });

  it("charges the $1 minimum fee on small tickets", async () => {
    const p = await deployPlatform();
    assert.equal(await p.platform.read.quoteFee([usd(100)]), usd(1));
    assert.equal(await p.platform.read.quoteFee([usd(199)]), usd(1));
    assert.equal(await p.platform.read.quoteFee([usd(200)]), usd(1));
    assert.equal(await p.platform.read.quoteFee([usd(201)]), usd(1.005));
  });

  it("a second purchase does not double-count the investor", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(10_000));
    await p.platform.write.buyTokens([id, usd(1_000)], { account: p.investor.account });
    await p.platform.write.buyTokens([id, usd(500)], { account: p.investor.account });
    const state = await p.platform.read.getState([id]);
    assert.equal(state.investorCount, 1n);
    assert.equal(state.fundingRaised, usd(1_500));
    const holding = await p.platform.read.getHolding([p.investor.account.address, id]);
    assert.equal(holding.quantity, tok(750));
    assert.equal(holding.costBasis, usd(1_500));
  });

  it("is blocked without an approved KYC ('Complete KYC to invest')", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await fundWallet(p, p.investor, usd(5_000));
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account }),
      p.platform,
      "KycNotApproved",
    );
    // Pending is not enough either.
    await p.compliance.write.submitKyc(["ipfs://kyc"], { account: p.investor.account });
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account }),
      p.platform,
      "KycNotApproved",
    );
  });

  it("enforces the minimum and maximum ticket", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(150_000));
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(99)], { account: p.investor.account }),
      p.platform,
      "BelowMinimum",
    );
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(100_001)], { account: p.investor.account }),
      p.platform,
      "AboveMaximum",
    );
  });

  it("fails when the wallet cannot cover amount + fee", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(2_000)); // exactly the ticket, not the fee
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account }),
      p.platform,
      "InsufficientFunds",
    );
  });

  it("cannot buy an approved-but-not-tokenized property", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    const id = await submitSample(p);
    await p.platform.write.approveProperty([id, CHECKLIST_COMPLETE, ""]);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(5_000));
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account }),
      p.platform,
      "NotTokenized",
    );
  });

  it("cannot oversubscribe the investor allocation", async () => {
    const p = await deployPlatform();
    await approveMerchant(p);
    // Tiny offering: 1,000 tokens, 40 % for investors = 400 tokens = $800 at $2.
    const id = await submitSample(p, {}, { ...SAMPLE_TERMS, tokenSupply: tok(1_000), fundingTarget: usd(800) });
    await approveAndTokenize(p, id);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(5_000));
    await p.platform.write.buyTokens([id, usd(700)], { account: p.investor.account });
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(200)], { account: p.investor.account }),
      p.platform,
      "InsufficientTokens",
    );
  });

  it("is paused by the admin in an emergency", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(5_000));
    await p.platform.write.pause();
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account }),
      p.platform,
      "EnforcedPause",
    );
    await p.platform.write.unpause();
    await p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account });
  });
});

describe("PropertyToken: lock-up", () => {
  it("blocks holder-to-holder transfers until the lock-up ends", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(5_000));
    await p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account });
    const token = await p.viem.getContractAt("PropertyToken", (await p.platform.read.getState([id])).token);

    await p.viem.assertions.revertWithCustomError(
      token.write.transfer([p.investor2.account.address, tok(10)], { account: p.investor.account }),
      token,
      "TransferLocked",
    );
    // The merchant's retained tokens are locked too.
    await p.viem.assertions.revertWithCustomError(
      token.write.transfer([p.investor2.account.address, tok(10)], { account: p.merchant.account }),
      token,
      "TransferLocked",
    );

    await p.networkHelpers.time.increase(6 * 30 * 24 * 60 * 60 + 1);
    assert.equal(await token.read.isLocked(), false);
    await token.write.transfer([p.investor2.account.address, tok(10)], { account: p.investor.account });
    assert.equal(await token.read.balanceOf([p.investor2.account.address]), tok(10));
  });

  it("only the platform can mint, and only once", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    const token = await p.viem.getContractAt("PropertyToken", (await p.platform.read.getState([id])).token);
    await p.viem.assertions.revertWithCustomError(
      token.write.mintSupply([1n, p.admin.account.address, 0n, p.admin.account.address, 0n]),
      token,
      "OnlyPlatform",
    );
    await p.viem.assertions.revertWithCustomError(
      p.factory.write.create(["X", "X", p.usdToken.address, 99n, 0n]),
      p.factory,
      "OnlyPlatform",
    );
  });
});

describe("Income distributions", () => {
  it("shares rental income pro-rata and pays it into the LandVest wallet", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await approveInvestor(p, p.investor2);
    await fundWallet(p, p.investor, usd(10_000));
    await fundWallet(p, p.investor2, usd(10_000));
    // investor: 1,000 tokens; investor2: 3,000 tokens; supply 1,000,000
    await p.platform.write.buyTokens([id, usd(2_000)], { account: p.investor.account });
    await p.platform.write.buyTokens([id, usd(6_000)], { account: p.investor2.account });

    // Merchant distributes $10,000 -> $0.01 per token.
    await p.usdToken.write.mint([p.merchant.account.address, usd(10_000)]);
    await p.usdToken.write.approve([p.platform.address, usd(10_000)], { account: p.merchant.account });
    await p.platform.write.distributeIncome([id, usd(10_000)], { account: p.merchant.account });

    // Pro-rata accounting floors, so a holder can be short by at most 1 unit
    // ($0.000001); the dust stays in the token contract.
    const share1 = await p.platform.read.claimableIncome([p.investor.account.address, id]);
    const share2 = await p.platform.read.claimableIncome([p.investor2.account.address, id]);
    assert.ok(share1 >= usd(10) - 1n && share1 <= usd(10), `investor share ${share1}`);
    assert.ok(share2 >= usd(30) - 1n && share2 <= usd(30), `investor2 share ${share2}`);

    const before = await p.platform.read.walletBalanceOf([p.investor.account.address]);
    await p.platform.write.claimDistribution([id], { account: p.investor.account });
    assert.equal(await p.platform.read.walletBalanceOf([p.investor.account.address]), before + share1);
    assert.equal(await p.platform.read.claimableIncome([p.investor.account.address, id]), 0n);

    // Nothing left to claim: the token contract reverts with NothingToClaim.
    const token = await p.viem.getContractAt("PropertyToken", (await p.platform.read.getState([id])).token);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.claimDistribution([id], { account: p.investor.account }),
      token,
      "NothingToClaim",
    );

    const ids = await p.platform.read.userLedger([p.investor.account.address]);
    const last = await p.platform.read.getLedgerEntry([ids[ids.length - 1]]);
    assert.equal(last.txType, TxType.Distribution);
    assert.equal(last.amount, share1);
  });

  it("only the property's merchant can distribute", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.distributeIncome([id, usd(1)], { account: p.stranger.account }),
      p.platform,
      "NotMerchantOfProperty",
    );
  });
});

describe("Admin: settings", () => {
  it("updates the fee schedule and treasury", async () => {
    const p = await deployPlatform();
    await p.platform.write.updateSettings([100n, usd(2), usd(50_000), 9, p.stranger.account.address]);
    assert.equal(await p.platform.read.platformFeeBps(), 100n);
    assert.equal(await p.platform.read.quoteFee([usd(1_000)]), usd(10));
    assert.equal(await p.platform.read.quoteFee([usd(10)]), usd(2));
    assert.equal(getAddress(await p.platform.read.treasury()), getAddress(p.stranger.account.address));
    await p.viem.assertions.revertWithCustomError(
      p.platform.write.updateSettings([100n, usd(2), usd(50_000), 9, p.stranger.account.address], {
        account: p.merchant.account,
      }),
      p.platform,
      "AccessControlUnauthorizedAccount",
    );
  });

  it("pages the platform-wide ledger", async () => {
    const p = await deployPlatform();
    const id = await listedSample(p);
    await approveInvestor(p);
    await fundWallet(p, p.investor, usd(5_000));
    await p.platform.write.buyTokens([id, usd(1_000)], { account: p.investor.account });
    assert.equal(await p.platform.read.ledgerLength(), 3n);
    const page = await p.platform.read.getLedger([1n, 10n]);
    assert.equal(page.length, 2);
    assert.equal(page[0].txType, TxType.Investment);
    assert.equal(page[1].txType, TxType.Fee);
    assert.equal((await p.platform.read.getLedger([10n, 10n])).length, 0);
  });
});
