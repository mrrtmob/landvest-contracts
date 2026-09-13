# Deploying to a public testnet (Sepolia)

## 1. What you need

| Item | Where to get it |
|---|---|
| A Sepolia RPC URL | Free tier at Alchemy, Infura, QuickNode, or a public endpoint such as `https://ethereum-sepolia-rpc.publicnode.com` |
| A deployer account with Sepolia ETH | Create a **new** account in MetaMask for this, export its private key, and fund it from a faucet (Alchemy, Infura, Google Cloud, sepoliafaucet.com). About **0.1 Sepolia ETH** covers the full seed (roughly 20M gas) with room to spare. |

Never use a key that holds real funds, and never commit the key.

## 2. Store the secrets

Hardhat 3 keeps them in an encrypted keystore, outside the repo:

```bash
cd landvest-contracts
npx hardhat keystore set SEPOLIA_RPC_URL        # paste the RPC URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY    # paste the deployer's private key (0x…)
```

Environment variables with the same names also work (`export SEPOLIA_PRIVATE_KEY=0x…`).

## 3. Deploy and seed

```bash
npm run seed:sepolia
# = npx hardhat run scripts/seed-testnet.ts --network sepolia
```

The script deploys the four contracts, then, from the deployer account alone, registers it as the
merchant (GreenFields) and as an approved investor, submits the ten fixture properties, approves
and tokenizes the seven that are live in the demo, and funds the deployer's LandVest wallet with
25,000 tUSD. Every transaction waits for its block, so expect **5–10 minutes** and around 40
transactions. Options:

```bash
SEED_PROPERTIES=3 npm run seed:sepolia      # only the first three properties (cheaper, faster)
SEED_FUND_USD=5000 npm run seed:sepolia     # smaller wallet top-up
PUBLIC_RPC_URL=https://… npm run seed:sepolia   # read endpoint written for the UI (default: publicnode)
```

Deploy only, no seed: `npm run deploy:sepolia`.

Output:

* `deployments/sepolia.json` — addresses, ABIs, property ids.
* `../land-investment/src/chain/deployment.json` — the same file, which is what the UI reads.
  **The UI follows whichever network was deployed last.** To go back to the local node, run the
  local seed again; to switch to Sepolia again, copy `deployments/sepolia.json` over it.

The `rpcUrl` written for the UI is a key-free public endpoint, never your private RPC URL, because
the file ships with the front-end.

## 4. Run the UI against Sepolia

```bash
cd land-investment
npm run dev        # or npm run build && npm run start
```

Press **Connect Wallet → Connect MetaMask**. The "local node" options disappear automatically because
the RPC is not loopback. MetaMask is asked to switch to Sepolia (chain id 11155111).

* The **deployer account** is admin, merchant and investor at once: it can review, tokenize, submit
  listings and buy.
* **Any other account** can press "Get 10,000 test USD" in the wallet menu (the faucet is open),
  submit KYC from `/user/kyc`, and buy once the deployer approves it in `/admin/verification`.
  A second account that submits KYB from `/merchant/kyb` and gets approved can list properties.

Blocks take about 12 seconds on Sepolia, so each action's toast stays on "waiting for the block" for
that long, and the page re-reads the chain every 6 seconds.

## 5. Verify the source on Etherscan (optional)

```bash
npx hardhat verify --network sepolia <MockUSD address> <deployer address>
npx hardhat verify --network sepolia <ComplianceRegistry address> <deployer address>
npx hardhat verify --network sepolia <PropertyTokenFactory address>
npx hardhat verify --network sepolia <LandVestPlatform address> <deployer> <MockUSD> <ComplianceRegistry> <PropertyTokenFactory> <deployer>
```

Set an Etherscan API key first: `npx hardhat keystore set ETHERSCAN_API_KEY` and add
`verify: { etherscan: { apiKey: configVariable("ETHERSCAN_API_KEY") } }` to `hardhat.config.ts`.

## 6. Other networks

Add a network block to `hardhat.config.ts` (same shape as `sepolia`, with its own config variables),
add its chain id and a public RPC to `PUBLIC_RPC_BY_CHAIN` in `scripts/deploy.ts`, and run the seed
with `--network <name>`. For a mainnet deployment replace `MockUSD` with the real stablecoin address
in the `LandVestPlatform` constructor and remove the faucet.

## 7. Costs and limits to keep in mind

* Each tokenization deploys a new ERC-20 (~1.15M gas). Seeding all ten properties is ~20M gas.
* The lock-up clock is real time on a testnet: a 6-month lock-up really lasts 6 months.
* Sepolia state is public. Do not put anything private in `metadataURI` strings.
