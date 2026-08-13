# Robinhood Chain — Wallet Consolidator / Disperser

A static, client-side tool for two common wallet-management tasks on Robinhood Chain:

- **Consolidate**: sweep the balance of many wallets into one destination address.
- **Spread**: send from one funding wallet out to many recipient addresses.

## Security model

- **No backend.** Everything runs in your browser. There is nothing to deploy server-side beyond static file hosting.
- **Keys never leave the browser.** Private keys are parsed locally into `ethers.Wallet` objects, held in memory for the current tab only, and the input field is cleared immediately after loading. Nothing is written to `localStorage`, `sessionStorage`, cookies, or IndexedDB, and no key material is ever sent in a network request — only signed, already-final transactions go out, straight to the RPC endpoint you configure.
- **Vendored, hash-pinned dependency.** `ethers.js` is vendored locally (not loaded from a CDN) and loaded with a Subresource Integrity hash, so a tampered or swapped copy would fail to execute.
- **Locked-down CSP.** `script-src 'self'` blocks any injected external script. `connect-src` is scoped to the specific Robinhood Chain RPC/explorer hosts this app talks to, not left open to arbitrary origins.

### If you use "Custom RPC"
The default CSP only allow-lists Robinhood Chain's own mainnet/testnet RPC + explorer hosts. If you point the app at a different custom RPC endpoint, the browser's CSP will block the request unless you also add that host to `connect-src` in both `public/index.html` (meta tag) and `vercel.json`, then redeploy. This is intentionally not left wide-open by default — see the audit note below.

### Still your responsibility
- Use burner/test wallets, especially the first few times you run this.
- Double-check destination/recipient addresses before sending — transactions are irreversible.
- If you fork/redeploy this, verify your deployed build actually matches this source (e.g. pin to a commit, diff before trusting a hosted instance with real keys).

## Usage

```bash
npm run dev      # serve public/ locally for testing
npm run deploy    # deploy to Vercel
```

Or open `public/index.html` directly / host `public/` as a static site anywhere.

**Consolidate**: paste private keys (one per line) → Load wallets → set destination address and gas buffer → Sweep. Each wallet's balance minus network fee and buffer is sent; wallets with too little balance are skipped automatically.

**Spread**: paste the funding wallet's private key → Load wallet → paste `address,amount` lines → Parse list → Send to all recipients. Transactions are sent sequentially with manually incremented nonces.

## Project structure

```
public/
  index.html          UI + CSP + SRI-pinned ethers.js
  app.js              wallet loading, balance checks, consolidate/spread logic
  vendor/ethers.umd.min.js   vendored ethers v6 (hash-pinned)
vercel.json            deployment + security headers
```
