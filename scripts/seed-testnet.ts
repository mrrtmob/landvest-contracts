/**
 * Seeds a public testnet (Sepolia) from ONE funded account.
 *
 * Unlike `seed.ts`, which spreads the demo world over a dozen unlocked local
 * accounts, this script only has the deployer key. The deployer therefore
 * plays every role: it is the admin, it registers itself as the merchant
 * (GreenFields Capital) and approves its own KYC as an investor. Every
 * transaction waits for its receipt because a public network does not mine
 * instantly.
 *
 *   npx hardhat keystore set SEPOLIA_RPC_URL
 *   npx hardhat keystore set SEPOLIA_PRIVATE_KEY
 *   npx hardhat run scripts/seed-testnet.ts --network sepolia
 *
 * Environment overrides:
 *   SEED_PROPERTIES=3   only seed the first N fixture properties (default: all 10)
 *   SEED_FUND_USD=5000  tUSD minted to the deployer's LandVest wallet (default: 25,000)
 *   PUBLIC_RPC_URL=...  read endpoint written into the UI's deployment.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseUnits, type Hash } from "viem";

import { deploy } from "./deploy.js";

const here = dirname(fileURLToPath(import.meta.url));

const usd = (n: number) => BigInt(Math.round(n * 1e6));
const tok = (n: number) => parseUnits(String(n), 18);
const CHECKLIST_COMPLETE = 0x7f;
const APPROVED = 2;

interface SeedProperty {
  slug: string; name: string; tokenSymbol: string; propertyType: number; location: string; merchantId: string;
  landArea: number; valuation: number; tokenSupply: number; initialNav: number; investorAllocationPct: number;
  merchantRetentionPct: number; minimumInvestment: number; maximumInvestment: number; fundingTarget: number;
  lockupMonths: number; expectedYield: number; status: string; tokenizationStatus: string;
}
interface SeedData { properties: SeedProperty[] }

async function main() {
  const data = JSON.parse(readFileSync(resolve(here, "seed-data.json"), "utf8")) as SeedData;
  const limit = Number(process.env.SEED_PROPERTIES ?? data.properties.length);
  const fundUsd = Number(process.env.SEED_FUND_USD ?? 25_000);

  const { viem, admin, usd: usdToken, compliance, platform, deployment, connection } = await deploy();
  const publicClient = await viem.getPublicClient();
  const me = admin.account.address;

  let count = 0;
  const tx = async (label: string, hash: Promise<Hash>) => {
    const h = await hash;
    const receipt = await publicClient.waitForTransactionReceipt({ hash: h });
    count += 1;
    console.log(`  [${count}] ${label.padEnd(44)} block ${receipt.blockNumber} gas ${receipt.gasUsed}`);
    if (receipt.status !== "success") throw new Error(`${label} reverted (${h})`);
    return receipt;
  };

  console.log(`\nDeployer ${me} plays admin, merchant and investor on ${connection.networkName}.`);

  console.log("\nCompliance...");
  await tx("KYB: GreenFields Capital", compliance.write.submitKyb(["GreenFields Capital Ltd.", "KH-CO-2021-04871", "ipfs://kyb/greenfields"]));
  await tx("KYB approved", compliance.write.reviewKyb([me, APPROVED]));
  await tx("KYC: deployer as investor", compliance.write.submitKyc(["ipfs://kyc/deployer"]));
  await tx("KYC approved", compliance.write.reviewKyc([me, APPROVED]));

  console.log("\nProperties...");
  const idBySlug: Record<string, number> = {};
  for (const p of data.properties.slice(0, limit)) {
    await tx(`submit ${p.tokenSymbol} ${p.name}`, platform.write.submitProperty([
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
    ]));
    const id = Number(await platform.read.propertyCount());
    idBySlug[p.slug] = id;

    switch (p.status) {
      case "under_review":
        await tx(`  start review #${id}`, platform.write.startReview([BigInt(id)]));
        await tx(`  checklist #${id}`, platform.write.setChecklist([BigInt(id), 0b0000111]));
        break;
      case "approved":
        await tx(`  approve #${id}`, platform.write.approveProperty([BigInt(id), CHECKLIST_COMPLETE, "All checks passed"]));
        break;
      case "tokenized":
        await tx(`  approve #${id}`, platform.write.approveProperty([BigInt(id), CHECKLIST_COMPLETE, "All checks passed"]));
        await tx(`  tokenize #${id} (deploys ${p.tokenSymbol} ERC-20)`, platform.write.approveTokenization([BigInt(id)]));
        break;
      default:
        break;
    }
    if (p.status === "submitted" && p.tokenizationStatus === "draft") {
      await tx(`  request changes #${id}`, platform.write.requestTokenizationChanges([BigInt(id), "Revise the allocation split and resubmit."]));
    }
  }

  console.log("\nFunding the deployer's LandVest wallet with test USD...");
  await tx(`mint ${fundUsd} tUSD`, usdToken.write.mint([me, usd(fundUsd)]));
  await tx("approve platform", usdToken.write.approve([platform.address, usd(fundUsd)]));
  await tx("deposit", platform.write.deposit([usd(fundUsd)]));

  const enriched = {
    ...deployment,
    accounts: { admin: me, investor: me, merchants: { greenfields: me } },
    propertyIds: idBySlug,
  };
  writeFileSync(resolve(here, "..", "deployments", `${connection.networkName}.json`), JSON.stringify(enriched, null, 2));
  try {
    writeFileSync(resolve(here, "..", "..", "land-investment", "src", "chain", "deployment.json"), JSON.stringify(enriched, null, 2));
  } catch {
    // UI project not present
  }

  console.log(`\nDone in ${count} transactions.`);
  console.log(`  properties: ${await platform.read.propertyCount()}  listed: ${(await platform.read.listedPropertyIds()).length}`);
  console.log(`  wallet: $${Number(await platform.read.walletBalanceOf([me])) / 1e6}`);
  console.log("\nConnect MetaMask with the deployer account to act as admin, merchant and investor.");
  console.log("Any other MetaMask account can use the tUSD faucet, submit KYC, and buy once you approve it.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
