/**
 * Seeds a freshly deployed local chain with the same demo world the UI ships
 * with: the six merchants, the ten properties (in their fixture statuses),
 * Daniel Kim's four holdings, and a few background investors so funding bars
 * are not empty.
 *
 *   npx hardhat run scripts/seed.ts --network localhost
 *
 * Hardhat account mapping (same order as `npx hardhat node` prints them):
 *   #0  admin / treasury            #1  GreenFields Capital (merchant)
 *   #2  Daniel Kim (investor)       #3  Mekong Estates      (merchant)
 *   #4  Angkor Holdings (merchant)  #5  Coastal DevCo        (merchant)
 *   #6  Royal Land (merchant)       #7  Sunrise Agri         (merchant)
 *   #8 - #12  background investors
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseUnits } from "viem";

import { deploy } from "./deploy.js";

const here = dirname(fileURLToPath(import.meta.url));

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const tok = (n: number) => parseUnits(String(n), 18);

const VERIFICATION = { not_started: 0, pending: 1, approved: 2, rejected: 3, action_required: 4 } as const;
const CHECKLIST_COMPLETE = 0x7f;

interface SeedMerchant { id: string; companyName: string; registrationNumber: string; kybStatus: keyof typeof VERIFICATION }
interface SeedProperty {
  slug: string; name: string; tokenSymbol: string; propertyType: number; location: string; merchantId: string;
  landArea: number; valuation: number; tokenSupply: number; initialNav: number; investorAllocationPct: number;
  merchantRetentionPct: number; minimumInvestment: number; maximumInvestment: number; fundingTarget: number;
  fundingRaised: number; lockupMonths: number; expectedYield: number; status: string; tokenizationStatus: string;
}
interface SeedHolding { propertyId: string; quantity: number }
interface SeedData { merchants: SeedMerchant[]; properties: SeedProperty[]; demoHoldings: SeedHolding[] }

async function main() {
  const data = JSON.parse(readFileSync(resolve(here, "seed-data.json"), "utf8")) as SeedData;
  const { viem, admin, usd: usdToken, compliance, platform, deployment, connection } = await deploy();
  const wallets = await viem.getWalletClients();

  const merchantWallet: Record<string, (typeof wallets)[number]> = {
    greenfields: wallets[1],
    "mekong-estates": wallets[3],
    "angkor-holdings": wallets[4],
    "coastal-devco": wallets[5],
    "royal-land": wallets[6],
    "sunrise-agri": wallets[7],
  };
  const investor = wallets[2];
  const background = wallets.slice(8, 13);

  console.log("\nSeeding merchants (KYB)...");
  for (const m of data.merchants) {
    const w = merchantWallet[m.id];
    await compliance.write.submitKyb([m.companyName, m.registrationNumber, `ipfs://kyb/${m.id}`], { account: w.account });
    // A property can only be listed by an approved merchant; every fixture
    // property's owner is approved regardless of the fixture's KYB badge, so
    // the marketplace looks like the UI. Angkor / Sunrise stay pending only
    // when they own nothing listed.
    const ownsListed = data.properties.some((p) => p.merchantId === m.id && p.status === "tokenized");
    const status = ownsListed ? "approved" : m.kybStatus;
    if (status !== "pending") {
      await compliance.write.reviewKyb([w.account.address, VERIFICATION[status]]);
    }
    console.log(`  ${m.companyName.padEnd(28)} ${w.account.address}  ${status}`);
  }

  console.log("\nSeeding investors (KYC)...");
  await compliance.write.submitKyc(["ipfs://kyc/daniel-kim"], { account: investor.account });
  await compliance.write.reviewKyc([investor.account.address, VERIFICATION.approved]);
  console.log(`  Daniel Kim                   ${investor.account.address}  approved`);
  for (const w of background) {
    await compliance.write.submitKyc([`ipfs://kyc/${w.account.address}`], { account: w.account });
    await compliance.write.reviewKyc([w.account.address, VERIFICATION.approved]);
  }

  console.log("\nSeeding properties...");
  const idBySlug: Record<string, bigint> = {};
  for (const p of data.properties) {
    const w = merchantWallet[p.merchantId];
    await platform.write.submitProperty(
      [
        {
          slug: p.slug,
          name: p.name,
          tokenSymbol: p.tokenSymbol,
          location: p.location,
          metadataURI: `ipfs://landvest/${p.slug}`,
          propertyType: p.propertyType,
          landArea: BigInt(p.landArea),
          valuation: usd(p.valuation),
          documentsHash: `0x${p.slug.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0")}` as `0x${string}`,
        },
        {
          tokenSupply: tok(p.tokenSupply),
          initialNav: usd(p.initialNav),
          investorAllocationPct: p.investorAllocationPct,
          merchantRetentionPct: p.merchantRetentionPct,
          minimumInvestment: usd(p.minimumInvestment),
          maximumInvestment: usd(p.maximumInvestment),
          fundingTarget: usd(p.fundingTarget),
          lockupMonths: p.lockupMonths,
          expectedYieldBps: Math.round(p.expectedYield * 10_000),
        },
      ],
      { account: w.account },
    );
    const id = await platform.read.propertyCount();
    idBySlug[p.slug] = id;

    // Move each property to its fixture status.
    switch (p.status) {
      case "under_review":
        await platform.write.startReview([id]);
        await platform.write.setChecklist([id, 0b0000111]);
        break;
      case "action_required":
        await platform.write.requestPropertyInfo([id, "Please provide the updated survey."]);
        break;
      case "approved":
        await platform.write.approveProperty([id, CHECKLIST_COMPLETE, "All checks passed"]);
        break;
      case "rejected":
        await platform.write.rejectProperty([id, "Did not pass verification review."]);
        break;
      case "tokenized":
        await platform.write.approveProperty([id, CHECKLIST_COMPLETE, "All checks passed"]);
        await platform.write.approveTokenization([id]);
        break;
      default:
        break; // submitted
    }
    if (p.status === "submitted" && p.tokenizationStatus === "draft") {
      await platform.write.requestTokenizationChanges([id, "Changes requested - revise the allocation split and resubmit."]);
    }
    console.log(`  #${id} ${p.tokenSymbol.padEnd(5)} ${p.name.padEnd(36)} ${p.status}`);
  }

  console.log("\nFunding Daniel Kim's wallet and buying his four holdings...");
  // Opening wallet $10,250 after the holdings are bought, so fund holdings + fees + 10,250.
  const holdingsCost = data.demoHoldings.reduce((sum, h) => {
    const p = data.properties.find((x) => x.slug === h.propertyId)!;
    return sum + h.quantity * p.initialNav;
  }, 0);
  const fundAmount = usd(Math.ceil(holdingsCost * 1.005) + 10_250 + 50);
  await usdToken.write.mint([investor.account.address, fundAmount]);
  await usdToken.write.approve([platform.address, fundAmount], { account: investor.account });
  await platform.write.deposit([fundAmount], { account: investor.account });
  for (const h of data.demoHoldings) {
    const p = data.properties.find((x) => x.slug === h.propertyId)!;
    const amount = usd(h.quantity * p.initialNav);
    await platform.write.buyTokens([idBySlug[h.propertyId], amount], { account: investor.account });
    console.log(`  bought ${h.quantity} ${p.tokenSymbol} for $${(h.quantity * p.initialNav).toFixed(2)}`);
  }
  // Leave the wallet at exactly $10,250 like the fixture.
  const bal = await platform.read.walletBalanceOf([investor.account.address]);
  if (bal > usd(10_250)) await platform.write.withdraw([bal - usd(10_250)], { account: investor.account });

  console.log("\nBackground investors so funding bars are not empty...");
  const listed = data.properties.filter((p) => p.status === "tokenized");
  for (const [i, w] of background.entries()) {
    const fund = usd(100_000 * 3 + 10_000);
    await usdToken.write.mint([w.account.address, fund]);
    await usdToken.write.approve([platform.address, fund], { account: w.account });
    await platform.write.deposit([fund], { account: w.account });
    for (const [j, p] of listed.entries()) {
      if ((i + j) % 2 !== 0) continue;
      const ticket = Math.min(p.maximumInvestment, 20_000 + ((i * 7 + j * 13) % 5) * 15_000);
      await platform.write.buyTokens([idBySlug[p.slug], usd(ticket)], { account: w.account });
    }
  }

  // Give MetaMask users something to deposit: 10,000 tUSD in each demo wallet.
  for (const w of [investor, ...Object.values(merchantWallet)]) {
    await usdToken.write.mint([w.account.address, usd(10_000)]);
  }

  // Record the demo identities next to the addresses for the UI.
  const enriched = {
    ...deployment,
    accounts: {
      admin: admin.account.address,
      investor: investor.account.address,
      merchants: Object.fromEntries(Object.entries(merchantWallet).map(([id, w]) => [id, w.account.address])),
    },
    propertyIds: Object.fromEntries(Object.entries(idBySlug).map(([slug, id]) => [slug, Number(id)])),
  };
  const outFile = resolve(here, "..", "deployments", `${connection.networkName}.json`);
  writeFileSync(outFile, JSON.stringify(enriched, null, 2));
  const uiFile = resolve(here, "..", "..", "land-investment", "src", "chain", "deployment.json");
  try {
    writeFileSync(uiFile, JSON.stringify(enriched, null, 2));
  } catch {
    // UI project not present; fine.
  }

  console.log("\nDone. Summary:");
  console.log(`  properties: ${await platform.read.propertyCount()}  listed: ${(await platform.read.listedPropertyIds()).length}`);
  console.log(`  Daniel's wallet: $${Number(await platform.read.walletBalanceOf([investor.account.address])) / 1e6}`);
  console.log(`  total invested: $${Number(await platform.read.totalInvested()) / 1e6}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
