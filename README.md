# Volume Bot — Solana Market Maker

Smithii-style Solana volume bot. Generates real buy/sell transactions via Jupiter v6 using ephemeral wallets, with a live web dashboard and WebSocket log feed.

---

## Stack

- **Backend**: Node.js, Express, `ws` WebSocket server
- **Blockchain**: `@solana/web3.js` v1, Jupiter v6 Swap API
- **Frontend**: Vanilla HTML/CSS/JS (served by Express, no build step)
- **Deploy**: Railway (recommended) or any Node host

---

## File Structure

```
volume-bot/
├── src/
│   ├── server.js      ← Express + WebSocket server (entry point)
│   ├── bot.js         ← Core volume generation engine
│   ├── jupiter.js     ← Jupiter v6 quote + swap integration
│   └── wallets.js     ← Ephemeral wallet generation + SOL distribution
├── public/
│   └── index.html     ← Smithii-style frontend dashboard
├── .env.example       ← Copy to .env and fill in
├── .gitignore
├── package.json
└── README.md
```

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd volume-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PRIVATE_KEY=your_main_wallet_private_key_base58
RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
NETWORK=mainnet-beta
PORT=3001
PRIORITY_FEE=100000
SLIPPAGE_BPS=300
```

> **Use a private RPC** (Helius, QuickNode, Alchemy) for production — public endpoints will rate-limit and timeout.

### 3. Fund your main wallet

| Package  | Makers | SOL needed (approx) |
|----------|--------|---------------------|
| Micro    | 20     | ~2 SOL              |
| Pump     | 50     | ~5 SOL              |
| Trending | 100    | ~10 SOL             |
| Moon     | 200    | ~25 SOL             |

### 4. Run

```bash
npm start
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

### 5. Use the dashboard

1. Paste your token's contract address in the Token Address field
2. Adjust sliders (makers count, SOL per trade)
3. Pick a package
4. Toggle advanced options as needed
5. Click **Start Bot**

---

## How It Works

1. **Distribute** — Bot generates N ephemeral keypairs and sends SOL from your main wallet to each
2. **Buy** — Each ephemeral wallet swaps SOL → token via Jupiter v6
3. **Sell** — Same wallet immediately swaps all tokens back → SOL
4. **Reclaim** — After the loop, remaining SOL is swept back to your main wallet
5. **Broadcast** — Every event streams to the frontend via WebSocket in real time

---

## Deploy to Railway

1. Push to GitHub
2. New Railway project → Deploy from GitHub repo
3. Add environment variables in Railway dashboard (same as `.env`)
4. Railway auto-runs `npm start`

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | ✅ | Base58 private key of your main wallet |
| `RPC_ENDPOINT` | ✅ | Solana HTTP RPC URL |
| `RPC_WS_ENDPOINT` | Optional | Solana WS RPC URL |
| `NETWORK` | Optional | `mainnet-beta` or `devnet` |
| `PORT` | Optional | Server port (default: 3001) |
| `JUPITER_API` | Optional | Jupiter v6 API base URL |
| `PRIORITY_FEE` | Optional | Priority fee in microlamports |
| `SLIPPAGE_BPS` | Optional | Max slippage in bps (default: 300 = 3%) |
| `GAS_RESERVE_SOL` | Optional | SOL to leave in each wallet for gas (default: 0.01) |

---

## Disclaimer

For educational and testing purposes. Use responsibly and in accordance with applicable laws.
