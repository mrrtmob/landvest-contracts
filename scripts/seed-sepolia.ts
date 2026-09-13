/**
 * Seeds an already-deployed Sepolia instance with the smallest world that makes
 * all three portals reachable from MetaMask: one merchant, one investor, and a
 * couple of listed properties.
 *
 *   npx hardhat run scripts/seed-sepolia.ts --network sepolia
 *
 * Why this exists alongside `seed.ts`, rather than being a flag on it:
 *
 * - `seed.ts` calls `deploy()` first. On a public network that would redeploy
 *   the contracts and orphan the addresses the UI already points at.
 * - `seed.ts` reads eight unlocked accounts off the node. `hardhat.config.ts`
 *   gives Sepolia exactly one (`SEPOLIA_PRIVATE_KEY`), so `wallets[1]` is
 *   `undefined` and the first merchant throws. The extra accounts have to be
 *   derived here and funded with real ETH before they can transact.
 * - A local chain mines instantly; Sepolia does not. Every write below waits
 *   for its receipt, because `reviewKyb` reverts with `NothingToReview` if it
 *   lands in the same block as the `submitKyb` it is reviewing.
 * - Ten properties, six merchants and five background investors is roughly two
 *   hundred transactions. That is a lot of testnet ETH to demonstrate a role
 *   split, so this seeds two properties and stops.
 *
 * Everything is idempotent: each step reads the chain first and skips what is
 * already done. A run that dies halfway — a rate-limited RPC, a dropped
 * transaction — is resumed by running it again.
 *
 * It talks to viem directly rather than through `hardhat-viem` because the
 * addresses and ABIs are already in `deployment.json`, and attaching to a
 * deployment is not what the plugin's helpers are shaped for.
 *
 * Environment:
 *   SEPOLIA_PRIVATE_KEY    the deployer — admin, reviewer and funding source
 *   SEPOLIA_DEMO_MNEMONIC  derives the merchant and investor accounts
 *   SEPOLIA_RPC_URL        optional; `deployment.json` already carries one
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseEther,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_FILE = resolve(here, "..", "deployments", "sepolia.json");
const UI_DEPLOYMENT_FILE = resolve(
  here, "..", "..", "land-investment", "src", "chain", "deployment.json",
);

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const tok = (n: number) => parseUnits(String(n), 18);

const VERIFICATION = { not_started: 0, pending: 1, approved: 2, rejected: 3, action_required: 4 } as const;

/** `LandVestPlatform.PropertyStatus`, in the contract's order — `Draft` is 0. */
const PROPERTY_STATUS = {
  draft: 0, submitted: 1, under_review: 2, action_required: 3,
  approved: 4, rejected: 5, tokenized: 6,
} as const;

/** `LandVestPlatform.TokenizationStatus`, in the contract's order. */
const TOKENIZATION_STATUS = {
  draft: 0, pending: 1, approved: 2, rejected: 3, active: 4,
} as const;

/**
 * The statuses `approveProperty` will accept, mirroring `_isReviewable`.
 * Calling it on anything else reverts with `InvalidStatus`, so the guards below
 * check membership rather than ordering.
 */
const REVIEWABLE: readonly number[] = [
  PROPERTY_STATUS.submitted, PROPERTY_STATUS.under_review, PROPERTY_STATUS.action_required,
];

const CHECKLIST_COMPLETE = 0x7f;

/** ETH each demo account is topped up to, so it can pay for its own writes. */
const GAS_FLOOR = parseEther("0.01");
/** Refuse to start below this, rather than stranding the run halfway. */
const DEPLOYER_FLOOR = parseEther("0.05");

/* -------------------------------------------------------------------------- */
/* Deployment file                                                             */
/* -------------------------------------------------------------------------- */

interface Deployment {
  chainId: number;
  network: string;
  rpcUrl: string | null;
  deployedAt?: string;
  admin: string;
  treasury: string;
  contracts: {
    MockUSD: Address;
    ComplianceRegistry: Address;
    PropertyTokenFactory: Address;
    LandVestPlatform: Address;
  };
  abis: Record<string, Abi>;
  accounts?: { admin: string; investor: string; merchants: Record<string, string> };
  propertyIds?: Record<string, number>;
}

/**
 * The deployment to seed.
 *
 * `deployments/sepolia.json` is where `deploy.ts` writes; the UI's copy is the
 * fallback, because a Sepolia deploy that predates this script may only have
 * left the UI one behind.
 */
function loadDeployment(): { deployment: Deployment; source: string } {
  for (const file of [DEPLOYMENT_FILE, UI_DEPLOYMENT_FILE]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Deployment;
      if (parsed.chainId && parsed.contracts?.LandVestPlatform) return { deployment: parsed, source: file };
    } catch {
      // Try the next one.
    }
  }
  throw new Error(
    `No deployment found. Run "npx hardhat run scripts/deploy.ts --network sepolia" first.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Seed data                                                                   */
/* -------------------------------------------------------------------------- */

interface SeedProperty {
  slug: string; name: string; tokenSymbol: string; propertyType: number; location: string;
  landArea: number; valuation: number; tokenSupply: number; initialNav: number;
  investorAllocationPct: number; merchantRetentionPct: number; minimumInvestment: number;
  maximumInvestment: number; fundingTarget: number; lockupMonths: number; expectedYield: number;
  status: string;
}

/** The two properties this seed lists, taken from the same fixture file as the local seed. */
function chooseProperties(): SeedProperty[] {
  const data = JSON.parse(
    readFileSync(resolve(here, "seed-data.json"), "utf8"),
  ) as { properties: SeedProperty[] };
  return data.properties.filter((property) => property.status === "tokenized").slice(0, 2);
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value.trim();
  throw new Error(`${name} is not set.\n  ${hint}`);
}

/**
 * The mnemonic behind the demo accounts.
 *
 * Refused rather than generated on the fly: a mnemonic invented mid-run would
 * be funded with real ETH and then lost the moment the process exits. Printing
 * one and stopping costs a second run and strands nothing.
 */
function requireMnemonic(): string {
  const value = process.env.SEPOLIA_DEMO_MNEMONIC?.trim();
  if (value) return value;
  throw new Error(
    `SEPOLIA_DEMO_MNEMONIC is not set.\n` +
      `  It derives the merchant and investor accounts, and MetaMask imports it to sign as them.\n` +
      `  Here is a fresh one — save it, then set it and run this again:\n\n` +
      `    ${generateMnemonic(english)}\n`,
  );
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                                */
/* -------------------------------------------------------------------------- */

interface Ctx {
  publicClient: PublicClient;
  compliance: { address: Address; abi: Abi };
  platform: { address: Address; abi: Abi };
  usdToken: { address: Address; abi: Abi };
}

/**
 * Send one write and wait for it to be mined.
 *
 * The wait is the whole point. Sepolia batches into ~12-second blocks, and
 * every step below depends on the previous one being visible — reviewing a KYB
 * that has not landed reverts, and listing a property from a merchant whose
 * approval is still pending reverts too.
 */
async function send(
  ctx: Ctx,
  label: string,
  run: () => Promise<Hex>,
): Promise<void> {
  process.stdout.write(`  ${label.padEnd(46)}`);
  const hash = await run();
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`ok  ${hash.slice(0, 10)}…  gas ${receipt.gasUsed}`);
}

function skip(label: string, reason: string): void {
  console.log(`  ${label.padEnd(46)}—   ${reason}`);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const { deployment, source } = loadDeployment();
  console.log(`Deployment: ${source}`);
  console.log(`  chain ${deployment.chainId} (${deployment.network})`);

  const rpcUrl = process.env.SEPOLIA_RPC_URL?.trim() || deployment.rpcUrl;
  if (!rpcUrl) {
    throw new Error(
      `The deployment has no rpcUrl and SEPOLIA_RPC_URL is not set.\n` +
        `  Set SEPOLIA_RPC_URL, or add "rpcUrl" to ${source}.`,
    );
  }

  const chain = defineChain({
    id: deployment.chainId,
    name: deployment.network,
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const deployerKey = requireEnv(
    "SEPOLIA_PRIVATE_KEY",
    "The deployer account — it is the admin, the reviewer and the funding source.",
  );
  const mnemonic = requireMnemonic();

  const adminAccount = privateKeyToAccount(
    (deployerKey.startsWith("0x") ? deployerKey : `0x${deployerKey}`) as Hex,
  );
  const merchantAccount = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  const investorAccount = mnemonicToAccount(mnemonic, { addressIndex: 1 });

  const admin = createWalletClient({ account: adminAccount, chain, transport: http(rpcUrl) });
  const merchant = createWalletClient({ account: merchantAccount, chain, transport: http(rpcUrl) });
  const investor = createWalletClient({ account: investorAccount, chain, transport: http(rpcUrl) });

  const ctx: Ctx = {
    publicClient,
    compliance: { address: deployment.contracts.ComplianceRegistry, abi: deployment.abis.ComplianceRegistry },
    platform: { address: deployment.contracts.LandVestPlatform, abi: deployment.abis.LandVestPlatform },
    usdToken: { address: deployment.contracts.MockUSD, abi: deployment.abis.MockUSD },
  };

  const write = (client: WalletClient, contract: { address: Address; abi: Abi }, fn: string, args: unknown[]) =>
    () =>
      client.writeContract({
        address: contract.address,
        abi: contract.abi,
        functionName: fn,
        args,
        account: client.account!,
        chain,
      });

  const read = <T>(contract: { address: Address; abi: Abi }, fn: string, args: unknown[]): Promise<T> =>
    publicClient.readContract({
      address: contract.address,
      abi: contract.abi,
      functionName: fn,
      args,
    }) as Promise<T>;

  console.log(`\nAccounts`);
  console.log(`  admin / reviewer   ${adminAccount.address}`);
  console.log(`  merchant  (m/0)    ${merchantAccount.address}`);
  console.log(`  investor  (m/1)    ${investorAccount.address}`);

  /* ------------------------------------------------------------- preflight */

  console.log(`\nPreflight`);
  const adminRole = await read<Hex>(ctx.platform, "ADMIN_ROLE", []);
  const isAdmin = await read<boolean>(ctx.platform, "hasRole", [adminRole, adminAccount.address]);
  if (!isAdmin) {
    throw new Error(
      `${adminAccount.address} does not hold the platform's ADMIN_ROLE.\n` +
        `  SEPOLIA_PRIVATE_KEY must be the account that deployed these contracts.`,
    );
  }
  console.log(`  admin role                                  ok`);

  const reviewerRole = await read<Hex>(ctx.compliance, "REVIEWER_ROLE", []);
  const isReviewer = await read<boolean>(ctx.compliance, "hasRole", [reviewerRole, adminAccount.address]);
  if (!isReviewer) throw new Error(`${adminAccount.address} does not hold REVIEWER_ROLE on the registry.`);
  console.log(`  reviewer role                               ok`);

  const adminBalance = await publicClient.getBalance({ address: adminAccount.address });
  console.log(`  deployer balance                            ${formatEther(adminBalance)} ETH`);
  if (adminBalance < DEPLOYER_FLOOR) {
    throw new Error(
      `The deployer holds ${formatEther(adminBalance)} ETH, which is not enough to seed.\n` +
        `  Top it up to at least ${formatEther(DEPLOYER_FLOOR)} ETH from a Sepolia faucet.`,
    );
  }

  /* ------------------------------------------------------------------- gas */

  console.log(`\nFunding the demo accounts`);
  for (const [label, account] of [
    ["merchant", merchantAccount],
    ["investor", investorAccount],
  ] as const) {
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance >= GAS_FLOOR) {
      skip(`${label} gas`, `has ${formatEther(balance)} ETH`);
      continue;
    }
    const topUp = GAS_FLOOR - balance;
    await send(ctx, `${label} gas +${formatEther(topUp)} ETH`, () =>
      admin.sendTransaction({ account: adminAccount, chain, to: account.address, value: topUp }),
    );
  }

  /* --------------------------------------------------------------- merchant */

  console.log(`\nMerchant verification (KYB)`);
  const merchantRecord = await read<{ submittedAt: bigint; kybStatus: number }>(
    ctx.compliance, "getMerchant", [merchantAccount.address],
  );
  if (merchantRecord.submittedAt > 0n) {
    skip("submitKyb", "already submitted");
  } else {
    await send(ctx, "submitKyb", write(merchant, ctx.compliance, "submitKyb", [
      "GreenFields Capital Ltd.", "KH-CO-2021-04871", "ipfs://kyb/greenfields",
    ]));
  }

  const kybStatus = await read<bigint>(ctx.compliance, "kybStatusOf", [merchantAccount.address]);
  if (Number(kybStatus) === VERIFICATION.approved) {
    skip("reviewKyb approved", "already approved");
  } else {
    await send(ctx, "reviewKyb approved", write(admin, ctx.compliance, "reviewKyb", [
      merchantAccount.address, VERIFICATION.approved,
    ]));
  }

  /* --------------------------------------------------------------- investor */

  console.log(`\nInvestor verification (KYC)`);
  const investorRecord = await read<{ submittedAt: bigint }>(
    ctx.compliance, "getInvestor", [investorAccount.address],
  );
  if (investorRecord.submittedAt > 0n) {
    skip("submitKyc", "already submitted");
  } else {
    await send(ctx, "submitKyc", write(investor, ctx.compliance, "submitKyc", [
      `ipfs://kyc/${investorAccount.address}`,
    ]));
  }

  const kycStatus = await read<bigint>(ctx.compliance, "kycStatusOf", [investorAccount.address]);
  if (Number(kycStatus) === VERIFICATION.approved) {
    skip("reviewKyc approved", "already approved");
  } else {
    await send(ctx, "reviewKyc approved", write(admin, ctx.compliance, "reviewKyc", [
      investorAccount.address, VERIFICATION.approved,
    ]));
  }

  /* ------------------------------------------------------------- properties */

  console.log(`\nProperties`);
  const properties = chooseProperties();
  const idBySlug: Record<string, number> = { ...(deployment.propertyIds ?? {}) };

  for (const property of properties) {
    const existing = await read<bigint>(ctx.platform, "propertyIdBySlug", [property.slug]);
    let id = existing;

    if (id === 0n) {
      await send(ctx, `submitProperty ${property.tokenSymbol}`, write(merchant, ctx.platform, "submitProperty", [
        {
          slug: property.slug,
          name: property.name,
          tokenSymbol: property.tokenSymbol,
          location: property.location,
          metadataURI: `ipfs://landvest/${property.slug}`,
          propertyType: property.propertyType,
          landArea: BigInt(property.landArea),
          valuation: usd(property.valuation),
          documentsHash: `0x${property.slug.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0")}` as Hex,
        },
        {
          tokenSupply: tok(property.tokenSupply),
          initialNav: usd(property.initialNav),
          investorAllocationPct: property.investorAllocationPct,
          merchantRetentionPct: property.merchantRetentionPct,
          minimumInvestment: usd(property.minimumInvestment),
          maximumInvestment: usd(property.maximumInvestment),
          fundingTarget: usd(property.fundingTarget),
          lockupMonths: property.lockupMonths,
          expectedYieldBps: Math.round(property.expectedYield * 10_000),
        },
      ]));
      id = await read<bigint>(ctx.platform, "propertyIdBySlug", [property.slug]);
    } else {
      skip(`submitProperty ${property.tokenSymbol}`, `already #${id}`);
    }

    idBySlug[property.slug] = Number(id);

    const state = await read<{ status: number; tokenizationStatus: number }>(
      ctx.platform, "getState", [id],
    );

    if (REVIEWABLE.includes(state.status)) {
      await send(ctx, `approveProperty #${id}`, write(admin, ctx.platform, "approveProperty", [
        id, CHECKLIST_COMPLETE, "Seeded on Sepolia",
      ]));
    } else if (state.status === PROPERTY_STATUS.approved || state.status === PROPERTY_STATUS.tokenized) {
      skip(`approveProperty #${id}`, "already approved");
    } else {
      // Draft or Rejected. `approveProperty` would revert with InvalidStatus,
      // and a rejected property needs a human decision rather than a re-run.
      console.log(`  ${`approveProperty #${id}`.padEnd(46)}!   status ${state.status}, not reviewable — skipping this property`);
      continue;
    }

    const afterApproval = await read<{ status: number; tokenizationStatus: number }>(
      ctx.platform, "getState", [id],
    );
    if (afterApproval.status === PROPERTY_STATUS.tokenized) {
      skip(`approveTokenization #${id}`, "already tokenized");
    } else if (
      afterApproval.status === PROPERTY_STATUS.approved &&
      afterApproval.tokenizationStatus === TOKENIZATION_STATUS.pending
    ) {
      await send(ctx, `approveTokenization #${id}`, write(admin, ctx.platform, "approveTokenization", [id]));
    } else {
      // `approveTokenization` insists on Approved + Pending; anything else is a
      // tokenization request that was withdrawn or refused.
      console.log(`  ${`approveTokenization #${id}`.padEnd(46)}!   tokenization status ${afterApproval.tokenizationStatus} — skipping`);
    }
  }

  /* ------------------------------------------------------------------ money */

  console.log(`\nTest dollars`);
  const wantUsd = usd(50_000);
  for (const [label, account] of [
    ["merchant", merchantAccount],
    ["investor", investorAccount],
  ] as const) {
    const balance = await read<bigint>(ctx.usdToken, "balanceOf", [account.address]);
    if (balance >= wantUsd) {
      skip(`mint tUSD to ${label}`, `has ${Number(balance) / 1e6}`);
      continue;
    }
    await send(ctx, `mint tUSD to ${label}`, write(admin, ctx.usdToken, "mint", [
      account.address, wantUsd - balance,
    ]));
  }

  const firstProperty = properties[0];
  const firstState = firstProperty
    ? await read<{ status: number }>(ctx.platform, "getState", [BigInt(idBySlug[firstProperty.slug] ?? 0)])
    : null;

  if (firstProperty && firstState?.status !== PROPERTY_STATUS.tokenized) {
    skip("investor buys tokens", "the first property is not tokenized");
  } else if (firstProperty) {
    const walletBalance = await read<bigint>(ctx.platform, "walletBalanceOf", [investorAccount.address]);
    const ticket = usd(Math.max(firstProperty.minimumInvestment, 1_000));

    if (walletBalance >= ticket) {
      skip("investor deposit", `wallet holds ${Number(walletBalance) / 1e6}`);
    } else {
      const topUp = ticket * 3n;
      await send(ctx, "approve platform", write(investor, ctx.usdToken, "approve", [
        ctx.platform.address, topUp,
      ]));
      await send(ctx, "investor deposit", write(investor, ctx.platform, "deposit", [topUp]));
    }

    const holding = await read<{ quantity: bigint }>(ctx.platform, "getHolding", [
      investorAccount.address, BigInt(idBySlug[firstProperty.slug]),
    ]);
    if (holding.quantity > 0n) {
      skip(`buy ${firstProperty.tokenSymbol}`, "already holds tokens");
    } else {
      await send(ctx, `buy ${firstProperty.tokenSymbol}`, write(investor, ctx.platform, "buyTokens", [
        BigInt(idBySlug[firstProperty.slug]), ticket,
      ]));
    }
  }

  /* ------------------------------------------------------------------ write */

  const enriched: Deployment = {
    ...deployment,
    rpcUrl,
    accounts: {
      admin: adminAccount.address,
      investor: investorAccount.address,
      merchants: { greenfields: merchantAccount.address },
    },
    propertyIds: idBySlug,
  };

  for (const file of [DEPLOYMENT_FILE, UI_DEPLOYMENT_FILE]) {
    try {
      writeFileSync(file, JSON.stringify(enriched, null, 2));
      console.log(`\nWrote ${file}`);
    } catch (error) {
      console.log(`\nCould not write ${file}: ${(error as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- summary */

  const merchantCount = await read<bigint>(ctx.compliance, "merchantCount", []);
  const listed = await read<bigint[]>(ctx.platform, "listedPropertyIds", []);

  console.log(`\nDone.`);
  console.log(`  merchants on-chain: ${merchantCount}   listed properties: ${listed.length}`);
  console.log(`\nTo sign in through the UI, import the demo accounts into MetaMask with`);
  console.log(`the SEPOLIA_DEMO_MNEMONIC, then pick:`);
  console.log(`  account 1  ${merchantAccount.address}   →  Merchant portal`);
  console.log(`  account 2  ${investorAccount.address}   →  Investor portal`);
  console.log(`  the deployer ${adminAccount.address}  →  Admin portal`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
