import { network } from "hardhat";
import { parseUnits } from "viem";

/** `$2,000.00` -> `2_000_000000n` (6-decimal settlement token). */
export function usd(amount: number): bigint {
  return BigInt(Math.round(amount * 1e6));
}

/** Whole property tokens -> 18-decimal units. */
export function tok(amount: number | string): bigint {
  return parseUnits(String(amount), 18);
}

export const CHECKLIST_COMPLETE = 0x7f;

export enum Verification {
  NotStarted,
  Pending,
  Approved,
  Rejected,
  ActionRequired,
}

export enum PropertyStatus {
  Draft,
  Submitted,
  UnderReview,
  ActionRequired,
  Approved,
  Rejected,
  Tokenized,
}

export enum TokenizationStatus {
  Draft,
  Pending,
  Approved,
  Rejected,
  Active,
}

export enum TxType {
  Investment,
  Deposit,
  Withdrawal,
  Distribution,
  Fee,
}

/** The "Phnom Penh Riverside District" fixture, as the wizard would submit it. */
export const SAMPLE_INFO = {
  slug: "pprd",
  name: "Phnom Penh Riverside District",
  tokenSymbol: "PPRD",
  location: "Chroy Changvar, Phnom Penh",
  metadataURI: "ipfs://bafy-pprd",
  propertyType: 6, // mixed_use
  landArea: 24_000n,
  valuation: usd(2_040_000),
  documentsHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as const,
};

export const SAMPLE_TERMS = {
  tokenSupply: tok(1_000_000),
  initialNav: usd(2),
  investorAllocationPct: 40,
  merchantRetentionPct: 55,
  minimumInvestment: usd(100),
  maximumInvestment: usd(100_000),
  fundingTarget: usd(800_000),
  lockupMonths: 6,
  expectedYieldBps: 820,
};

/**
 * Deploys the whole platform on a fresh simulated chain.
 *
 * Accounts: [0] admin & treasury, [1] merchant, [2] investor, [3] second investor, [4] stranger.
 */
export async function deployPlatform() {
  const connection = await network.create();
  const { viem, networkHelpers } = connection;
  const publicClient = await viem.getPublicClient();
  const [admin, merchant, investor, investor2, stranger] = await viem.getWalletClients();

  const usdToken = await viem.deployContract("MockUSD", [admin.account.address]);
  const compliance = await viem.deployContract("ComplianceRegistry", [admin.account.address]);
  const factory = await viem.deployContract("PropertyTokenFactory", []);
  const platform = await viem.deployContract("LandVestPlatform", [
    admin.account.address,
    usdToken.address,
    compliance.address,
    factory.address,
    admin.account.address,
  ]);
  await factory.write.setPlatform([platform.address]);

  return {
    connection,
    viem,
    networkHelpers,
    publicClient,
    admin,
    merchant,
    investor,
    investor2,
    stranger,
    usdToken,
    compliance,
    factory,
    platform,
  };
}

export type Platform = Awaited<ReturnType<typeof deployPlatform>>;

/** Merchant KYB approved, as the demo starts (`/merchant/kyb` shows Approved). */
export async function approveMerchant(p: Platform) {
  await p.compliance.write.submitKyb(["GreenFields Capital Ltd.", "KH-CO-2021-04871", "ipfs://kyb"], {
    account: p.merchant.account,
  });
  await p.compliance.write.reviewKyb([p.merchant.account.address, Verification.Approved]);
}

/** Investor KYC approved, as the demo starts (Daniel Kim is Approved). */
export async function approveInvestor(p: Platform, who = p.investor) {
  await p.compliance.write.submitKyc(["ipfs://kyc"], { account: who.account });
  await p.compliance.write.reviewKyc([who.account.address, Verification.Approved]);
}

/** Faucet + approve + deposit into the LandVest wallet. */
export async function fundWallet(p: Platform, who: Platform["investor"], amount: bigint) {
  await p.usdToken.write.mint([who.account.address, amount]);
  await p.usdToken.write.approve([p.platform.address, amount], { account: who.account });
  await p.platform.write.deposit([amount], { account: who.account });
}

/** Merchant submits the sample property. Returns its id (1 on a fresh chain). */
export async function submitSample(p: Platform, overrides: Partial<typeof SAMPLE_INFO> = {}, terms = SAMPLE_TERMS) {
  await p.platform.write.submitProperty([{ ...SAMPLE_INFO, ...overrides }, terms], {
    account: p.merchant.account,
  });
  return p.platform.read.propertyCount();
}

/** Admin ticks all 7 boxes and approves, then approves the tokenization. */
export async function approveAndTokenize(p: Platform, id: bigint) {
  await p.platform.write.approveProperty([id, CHECKLIST_COMPLETE, "All checks passed"]);
  await p.platform.write.approveTokenization([id]);
}

/** Runs the whole "five-minute demo" up to a listed property. */
export async function listedSample(p: Platform) {
  await approveMerchant(p);
  const id = await submitSample(p);
  await approveAndTokenize(p, id);
  return id;
}
