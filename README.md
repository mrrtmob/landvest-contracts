# LandVest Smart Contracts

On-chain implementation of the **LandVest** tokenized real-estate platform whose UI lives in
`../land-investment`. Every screen flow in that UI — merchant listing, admin review, tokenization,
investor KYC, wallet and token purchase — has a matching contract function here, with the same rules
enforced by the EVM instead of a browser store.

```
Merchant submits a property            submitProperty()          -> Submitted
Admin ticks the 7 checklist items and  approveProperty()         -> Approved   (NOT yet tradable)
Admin approves the tokenization        approveTokenization()     -> Tokenized  (ERC-20 deployed + minted)
Property appears in the marketplace    listedPropertyIds()
Investor deposits test USD             deposit()
Investor buys tokens                   buyTokens()               -> ERC-20 balance + ledger rows
Merchant sees funding progress         getState(id).fundingRaised
```

Full design notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Connecting the UI and MetaMask: [`docs/UI-INTEGRATION.md`](docs/UI-INTEGRATION.md).

## Contracts

| Contract | Purpose |
|---|---|
| `LandVestPlatform` | The platform: property lifecycle, review checklist, tokenization, internal USD wallet, primary sale, fee, ledger, income distribution. |
| `ComplianceRegistry` | Investor KYC and merchant KYB records, reviewed by accounts with `REVIEWER_ROLE`. |
| `PropertyToken` | One ERC-20 per tokenized property, with lock-up and pro-rata income distribution. Created by `PropertyTokenFactory`. |
| `MockUSD` | 6-decimal test stablecoin (`tUSD`) with a public `faucet()` for local networks. |

## Quick start

```bash
npm install
npx hardhat compile
npx hardhat test              # 35 tests covering the whole flow

# Local network for MetaMask + the UI
npx hardhat node                                  # terminal 1, chain id 31337
npx hardhat run scripts/seed.ts --network localhost   # terminal 2: deploy + seed the demo world
```

`scripts/seed.ts` deploys the four contracts and recreates the UI's demo world on-chain: the six
merchants, the ten fixture properties in their fixture statuses, Daniel Kim's four holdings, and a few
background investors. It writes `deployments/localhost.json` and, when the UI project sits next to
this one, `../land-investment/src/chain/deployment.json`.

On a fresh `hardhat node` the addresses are always:

| Contract | Address |
|---|---|
| MockUSD | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| ComplianceRegistry | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| PropertyTokenFactory | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| LandVestPlatform | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |

## Demo accounts (Hardhat node, chain id 31337)

| # | Role in the seed | Address |
|---|---|---|
| 0 | Admin / treasury | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| 1 | GreenFields Capital (merchant) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| 2 | Daniel Kim (investor, KYC approved) | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| 3 | Mekong Estates (merchant) | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| 4 | Angkor Holdings (merchant, KYB pending) | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` |
| 5 | Coastal DevCo (merchant) | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` |
| 6 | Royal Land (merchant) | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` |
| 7 | Sunrise Agri (merchant) | `0x14dC79964da2C08b23698B3D3cc7Ca32193d9955` |
| 8–12 | Background investors | — |

The private keys are the standard Hardhat ones printed by `npx hardhat node` (they are public and
must never hold real funds). Import #0, #1 and #2 into MetaMask to act as admin, merchant and
investor.

## Deploying to Sepolia

```bash
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY     # a throwaway account with ~0.1 Sepolia ETH
npm run seed:sepolia                             # deploy + seed from that one account
```

Step by step, including what the UI needs afterwards: [`docs/TESTNET.md`](docs/TESTNET.md).

## Scripts

| Command | What it does |
|---|---|
| `npx hardhat test` | Runs `test/LandVest.ts` on the in-process simulated chain. |
| `npx hardhat run scripts/deploy.ts --network localhost` | Deploys the contracts only. |
| `npx hardhat run scripts/seed.ts --network localhost` | Deploys and seeds the demo world. |
| `npm run seed:sepolia` | Deploys and seeds Sepolia from the single configured account (`scripts/seed-testnet.ts`). |
| `npm run deploy:sepolia` | Deploys the contracts to Sepolia without seeding. |

## Layout

```
contracts/         Solidity sources
test/              node:test + viem tests (helpers.ts holds the fixture)
scripts/           deploy.ts, seed.ts, seed-data.json (extracted from the UI fixtures)
deployments/       generated per-network address + ABI files (git-ignored)
docs/              architecture and integration notes
```
