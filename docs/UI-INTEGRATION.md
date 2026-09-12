# Connecting the LandVest UI to the contracts

The Next.js app in `../land-investment` can run in two modes:

* **Demo mode** (default) — everything simulated in the browser, as before.
* **Chain mode** — a wallet is connected; the store mirrors the chain and every action is a signed
  transaction. Nothing in chain mode is written to `localStorage`, and disconnecting restores the
  saved demo world.

## 1. Run it

```bash
# terminal 1 — local chain
cd landvest-contracts
npx hardhat node

# terminal 2 — deploy + seed (writes ../land-investment/src/chain/deployment.json)
cd landvest-contracts
npx hardhat run scripts/seed.ts --network localhost

# terminal 3 — UI
cd land-investment
npm run dev            # http://localhost:3000
```

Press **Connect Wallet** in the header. Two options appear:

1. **Connect MetaMask** — the normal path (see §2).
2. **Local Hardhat node — sign without MetaMask (dev only)** — appears only when the RPC URL in
   `deployment.json` is loopback. It signs with the node's unlocked accounts, so you can act as the
   admin, the merchant or the investor with one click and no key import. Use it for quick checks; it
   does nothing on a public network.

The chip that replaces the button shows the short address and the wallet's on-chain role
(**Admin** / **Merchant** / **Investor**). Its menu has the tUSD faucet, a manual re-sync and
Disconnect.

## 2. MetaMask setup

1. Add the network (the app does this for you on first connect, or add it manually):
   * Network name: `Hardhat Local`
   * RPC URL: `http://127.0.0.1:8545`
   * Chain ID: `31337`
   * Currency symbol: `ETH`
2. Import the demo accounts with the private keys printed by `npx hardhat node`:

   | Account | Acts as | Address |
   |---|---|---|
   | #0 | Admin | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
   | #1 | GreenFields Capital (merchant) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
   | #2 | Daniel Kim (investor) | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |

   These keys are public test keys; never send real funds to them.
3. Optional: add the tUSD token to MetaMask (`0x5FbDB2315678afecb367f032d93F642f64180aa3`, 6 decimals)
   to see the faucet balance there.
4. Switching the active account in MetaMask switches the app's role automatically.

If you restart `hardhat node`, run the seed again **and** reset the account in MetaMask
(Settings → Advanced → Clear activity tab data) so its nonce matches the fresh chain.

## 3. The five-minute demo, on-chain

| Step | Account | Screen | What happens |
|---|---|---|---|
| 1 | Merchant | `/merchant/properties/new` | Submit → `submitProperty` tx. The descriptive fields are kept in this browser; the chain stores the hash. The new listing appears under `/merchant/properties` as **Submitted**. |
| 2 | Admin | `/admin/properties/<id>` | Tick the 7 checklist items, Approve → `approveProperty` tx. Reject / Request information send their note on-chain. |
| 3 | Admin | `/admin/tokenization` | Review → Approve Tokenization → `approveTokenization` tx deploys the ERC-20 and mints the supply. |
| 4 | Anyone | `/properties` | The asset is listed. |
| 5 | Investor | wallet menu → **Get 10,000 test USD** | `faucet()` tx. |
| 6 | Investor | `/user/wallet` → Deposit | `approve` + `deposit` txs. "tUSD in MetaMask" shows what is still undeposited. |
| 7 | Investor | `/user/properties/<id>` → Buy Tokens | `buyTokens` tx; receipt shows tokens, fee, total. |
| 8 | Investor | `/user/dashboard`, `/user/wallet` | Holdings, balances and ledger are read from the chain. |
| 9 | Merchant | `/merchant/dashboard` | Funding raised comes from `getState(id).fundingRaised`. |

Also wired: KYC submission (`/user/kyc`), KYB submission (`/merchant/kyb`), and the admin KYC / KYB
decisions in `/admin/verification`, which now review the wallet addresses that submitted on-chain.

## 4. How it is wired

```
src/chain/
  deployment.json   addresses + ABIs, written by landvest-contracts/scripts/deploy.ts
  config.ts         chain id, RPC URL, addresses, known demo accounts
  wallet.ts         MetaMask (EIP-1193) plumbing, network switch, read provider, local-signer mode
  contracts.ts      ethers Contract factories + enum tables + checklist bitmask helpers
  units.ts          USD (6 dec) and token (18 dec) conversions
  errors.ts         decodes custom errors into the sentences the toasts show
  metadata.ts       off-chain listing bundle kept in localStorage, keyed by slug
  snapshot.ts       reads the whole world for one address and maps it to the store's types
  actions.ts        one signed transaction per store action (deposit, buyTokens, approveProperty, …)
src/store/chain-store.ts   connection state; sync() pushes a snapshot into the demo store
src/layouts/chain-provider.tsx   mounted in the root layout: detect, auto-reconnect, listen, poll
src/components/chain/wallet-button.tsx   the header control
```

* **Reads** go straight to the node over JSON-RPC (`readProvider()`), so the marketplace renders even
  while MetaMask points at another network. The provider re-syncs every 6 s and after each
  transaction.
* **Writes** go through the connected signer. Each action shows "confirm in MetaMask" → "waiting for
  the block" toasts, then re-syncs.
* **The demo store is the read model.** `applyChainSnapshot` replaces properties, tokenizations,
  holdings, wallet balance, KYC/KYB status, ledger, users, merchants and the review queue with the
  chain's view. Fixture properties keep their gallery, price history and timeline; every financial and
  lifecycle field comes from the chain. Screens did not change — they still read `useDemoStore`.
* **Persistence is frozen** in chain mode (`chainAwareStorage`), and `useHydrateDemoStore` skips
  rehydration, so the saved demo world survives untouched.
* **Property ids.** The UI keeps using slugs (`pprd`, `kep-coastal-villas-listing-11`); the contract
  maps slug → numeric id (`propertyIdBySlug`). Seeded slugs equal the fixture ids, which is what lets
  the existing routes work.
* **Roles.** The connected wallet's portal is derived on-chain: `ADMIN_ROLE` → admin, a KYB record →
  merchant, otherwise investor. Acting in the wrong portal is allowed but the transaction reverts and
  the toast explains why (e.g. "The connected wallet does not have the required role").

## 5. Changes made to the existing UI

* `store/demo-store.ts` — `chainMode`, `activeMerchantId`, `activeInvestorId`, `applyChainSnapshot`,
  `leaveChainMode`, storage guard.
* `hooks/use-demo-selectors.ts` — `useInvestorTransactions` filters by the active investor;
  new `useActiveMerchantId`.
* Merchant screens read `useActiveMerchantId()` instead of the fixed demo merchant.
* Action handlers branch on `useChainConnected()`: investment panel, wallet deposit/withdraw (+ faucet
  button), KYC and KYB flows, property wizard, admin decision rail, tokenization dialog, KYC / KYB
  review drawers.
* Headers render `<WalletButton />`; the root layout mounts `<ChainProvider />`.
* `ethers` v6 added as a dependency.

The project's "no network" rule now has a second, explicit exception: JSON-RPC calls to the chain,
made only from `src/chain/*`.
