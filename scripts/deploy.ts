/**
 * Deploys the LandVest contracts and writes the addresses + ABIs to
 *   deployments/<network>.json                       (this project)
 *   ../land-investment/src/chain/deployment.json     (the UI, when present)
 *
 *   npx hardhat run scripts/deploy.ts --network localhost
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import hre, { network } from "hardhat";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The RPC URL to record for a network.
 *
 * `null` used to be written for anything that was not localhost, and
 * `src/chain/config.ts` falls back to `http://127.0.0.1:8545` when it reads
 * one — so a Sepolia deploy silently pointed the UI at a local node that was
 * not running. The env var is the same one `hardhat.config.ts` already reads
 * for the network, and the previous deployment file is the fallback for a
 * project configured through the Hardhat keystore instead.
 */
function rpcUrlFor(networkName: string, previous: string | null): string | null {
  if (networkName === "localhost") return "http://127.0.0.1:8545";
  const fromEnv = process.env[`${networkName.toUpperCase()}_RPC_URL`]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : previous;
}

/** The rpcUrl already recorded for this network, if any. */
function previousRpcUrl(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { rpcUrl?: string | null };
    return parsed.rpcUrl ?? null;
  } catch {
    return null;
  }
}

export async function deploy() {
  const connection = await network.getOrCreate();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [admin] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();

  console.log(`Deploying LandVest to chain ${chainId} (${connection.networkName}) as ${admin.account.address}`);

  const usd = await viem.deployContract("MockUSD", [admin.account.address]);
  const compliance = await viem.deployContract("ComplianceRegistry", [admin.account.address]);
  const factory = await viem.deployContract("PropertyTokenFactory", []);
  const platform = await viem.deployContract("LandVestPlatform", [
    admin.account.address,
    usd.address,
    compliance.address,
    factory.address,
    admin.account.address, // treasury = admin on local networks
  ]);
  await factory.write.setPlatform([platform.address]);

  const names = ["MockUSD", "ComplianceRegistry", "PropertyTokenFactory", "LandVestPlatform", "PropertyToken"] as const;
  const abis: Record<string, unknown> = {};
  for (const name of names) abis[name] = (await hre.artifacts.readArtifact(name)).abi;

  const outDirEarly = resolve(here, "..", "deployments");
  const rpcUrl = rpcUrlFor(
    connection.networkName,
    previousRpcUrl(resolve(outDirEarly, `${connection.networkName}.json`)),
  );
  if (rpcUrl === null) {
    console.warn(
      `No RPC URL recorded for ${connection.networkName}. Set ${connection.networkName.toUpperCase()}_RPC_URL, ` +
        `or the UI will fall back to http://127.0.0.1:8545.`,
    );
  }

  const deployment = {
    chainId,
    network: connection.networkName,
    rpcUrl,
    deployedAt: new Date().toISOString(),
    admin: admin.account.address,
    treasury: admin.account.address,
    contracts: {
      MockUSD: usd.address,
      ComplianceRegistry: compliance.address,
      PropertyTokenFactory: factory.address,
      LandVestPlatform: platform.address,
    },
    abis,
  };

  const outDir = outDirEarly;
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `${connection.networkName}.json`);
  writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`Wrote ${outFile}`);

  const uiDir = resolve(here, "..", "..", "land-investment", "src", "chain");
  if (existsSync(resolve(uiDir, ".."))) {
    mkdirSync(uiDir, { recursive: true });
    const uiFile = resolve(uiDir, "deployment.json");
    writeFileSync(uiFile, JSON.stringify(deployment, null, 2));
    console.log(`Wrote ${uiFile}`);
  }

  for (const [name, address] of Object.entries(deployment.contracts)) console.log(`  ${name.padEnd(22)} ${address}`);
  return { connection, viem, admin, usd, compliance, factory, platform, deployment };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  deploy().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
