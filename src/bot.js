// src/bot.js
// Volume bot core engine

const { Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { executeBuy, executeSell } = require('./jupiter');
const { loadMainWallet, generateEphemeralWallets, distributeSol, reclaimSol, getBalance } = require('./wallets');

const PACKAGES = {
  micro:    { makersBase: 20,  solPerWallet: 0.05 },
  pump:     { makersBase: 50,  solPerWallet: 0.08 },
  trending: { makersBase: 100, solPerWallet: 0.1  },
  moon:     { makersBase: 200, solPerWallet: 0.12 }
};

class VolumeBot {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.running = false;
    this.stopRequested = false;

    this.stats = {
      makersSent: 0,
      solSpent: 0,
      wallVolume: 0,
      phaseVolume: 0,
      totalVolume: 0
    };

    this.connection = null;
    this.mainWallet = null;
    this.ephemeralWallets = [];
    this.currentConfig = null;
  }

  log(msg, level = '') {
    this.broadcast('log', msg, { level });
    console.log(`[BOT] ${msg}`);
  }

  emitStats() {
    this.broadcast('volume', null, {
      wallVolume: this.stats.wallVolume,
      phaseVolume: this.stats.phaseVolume,
      totalVolume: this.stats.totalVolume,
      solSpent: this.stats.solSpent
    });
  }

  emitProgress(sent, total) {
    this.broadcast('progress', null, { sent, total });
  }

  emitTx(txType, sig, amount) {
    this.broadcast('tx', null, { txType, sig, amount });
  }

  async start(config) {
    if (this.running) {
      throw new Error('Bot already running');
    }

    this.currentConfig = config;
    this.running = true;
    this.stopRequested = false;

    this.stats = { makersSent: 0, solSpent: 0, wallVolume: 0, phaseVolume: 0, totalVolume: 0 };

    this.log('Initializing bot engine...', 'info');

    try {
      this.connection = new Connection(
        process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
        { commitment: 'confirmed', wsEndpoint: process.env.RPC_WS_ENDPOINT }
      );

      this.mainWallet = loadMainWallet();
      const mainBalance = await getBalance(this.connection, this.mainWallet.publicKey);
      this.log(`Main wallet: ${this.mainWallet.publicKey.toString()}`, 'info');
      this.log(`Main wallet balance: ${mainBalance.toFixed(4)} SOL`, 'info');

      const pkg = PACKAGES[config.package] || PACKAGES.pump;
      const makersCount = config.makers || pkg.makersBase;
      const solPerWallet = config.solPerTrade || pkg.solPerWallet;
      const solPerWalletLamports = Math.floor(solPerWallet * LAMPORTS_PER_SOL);
      const slippageBps = parseInt(process.env.SLIPPAGE_BPS || '300');
      const priorityFee = parseInt(process.env.PRIORITY_FEE || '100000');

      const tokenMint = config.tokenAddress;
      if (!tokenMint) throw new Error('tokenAddress is required');

      this.log(`Token: ${tokenMint}`, 'info');
      this.log(`Package: ${config.package} | Makers: ${makersCount} | SOL/wallet: ${solPerWallet}`, 'info');

      const totalNeeded = (makersCount * solPerWalletLamports) / LAMPORTS_PER_SOL;
      this.log(`Estimated SOL needed: ${totalNeeded.toFixed(3)} SOL`, 'info');

      if (mainBalance < totalNeeded + 0.05) {
        throw new Error(`Insufficient balance. Need ~${(totalNeeded + 0.05).toFixed(3)} SOL, have ${mainBalance.toFixed(4)} SOL`);
      }

      this.log(`Generating ${makersCount} ephemeral maker wallets...`, 'info');
      this.ephemeralWallets = generateEphemeralWallets(makersCount);

      await distributeSol(
        this.connection,
        this.mainWallet,
        this.ephemeralWallets,
        solPerWalletLamports,
        (level, msg) => this.log(msg, level)
      );

      this.log('SOL distribution complete. Starting volume generation...', 'success');
      this.broadcast('status', null, { running: true });

      await this.runVolumeLoop(tokenMint, makersCount, slippageBps, priorityFee, config);

    } catch (err) {
      this.log(`Bot error: ${err.message}`, 'error');
      console.error(err);
    } finally {
      await this.cleanup();
    }
  }

  async runVolumeLoop(tokenMint, makersCount, slippageBps, priorityFee, config) {
    const randomDelay = config.randomDelay !== false;
    let wallVolumeAccum = 0;

    for (let i = 0; i < this.ephemeralWallets.length; i++) {
      if (this.stopRequested) {
        this.log('Stop requested — ending volume loop', 'warn');
        break;
      }

      const wallet = this.ephemeralWallets[i];
      const walletLabel = `Wallet ${i + 1}/${makersCount}`;

      try {
        const balance = await getBalance(this.connection, wallet.publicKey);
        const solLamports = Math.floor(balance * LAMPORTS_PER_SOL * 0.85);

        if (solLamports <= 10000) {
          this.log(`${walletLabel}: balance too low, skipping`, 'warn');
          this.emitProgress(i + 1, makersCount);
          continue;
        }

        this.log(`${walletLabel}: BUY ${(solLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL → token`, 'info');

        const buyResult = await executeBuy(
          this.connection,
          wallet,
          tokenMint,
          solLamports,
          slippageBps,
          priorityFee
        );

        const buyAmountSol = solLamports / LAMPORTS_PER_SOL;
        wallVolumeAccum += buyAmountSol * 2;

        this.stats.makersSent++;
        this.stats.solSpent += buyAmountSol;
        this.stats.phaseVolume += buyAmountSol;
        this.stats.wallVolume = wallVolumeAccum;

        this.log(`${walletLabel}: BUY confirmed ✓ sig: ${buyResult.sig.slice(0, 16)}...`, 'success');
        this.emitTx('buy', buyResult.sig, `${buyAmountSol.toFixed(4)} SOL`);
        this.emitStats();
        this.emitProgress(this.stats.makersSent, makersCount);

        const buySellDelay = randomDelay ? 800 + Math.random() * 2400 : 1000;
        await sleep(buySellDelay);

        if (this.stopRequested) {
          this.log('Stop requested before sell, will reclaim tokens', 'warn');
          break;
        }

        this.log(`${walletLabel}: SELL tokens → SOL`, 'info');

        const sellResult = await executeSell(
          this.connection,
          wallet,
          tokenMint,
          slippageBps,
          priorityFee
        );

        this.stats.makersSent++;
        this.log(`${walletLabel}: SELL confirmed ✓ sig: ${sellResult.sig.slice(0, 16)}...`, 'success');
        this.emitTx('sell', sellResult.sig, `→ SOL`);
        this.emitStats();

        if (i < this.ephemeralWallets.length - 1) {
          const nextDelay = randomDelay ? 1200 + Math.random() * 3000 : 2000;
          await sleep(nextDelay);
        }

      } catch (err) {
        this.log(`${walletLabel}: Error — ${err.message}`, 'error');
        await sleep(1500);
      }

      this.emitProgress(i + 1, makersCount);
    }

    this.stats.totalVolume += this.stats.phaseVolume;
    this.emitStats();
    this.log(`Volume phase complete. Total volume: ${this.stats.totalVolume.toFixed(3)} SOL`, 'success');
  }

  async cleanup() {
    this.log('Cleaning up — reclaiming SOL from maker wallets...', 'info');

    if (this.ephemeralWallets.length && this.mainWallet && this.connection) {
      try {
        await reclaimSol(
          this.connection,
          this.mainWallet,
          this.ephemeralWallets,
          (level, msg) => this.log(msg, level)
        );
      } catch (e) {
        this.log(`Reclaim error: ${e.message}`, 'warn');
      }
    }

    this.running = false;
    this.stopRequested = false;
    this.ephemeralWallets = [];
    this.broadcast('status', null, { running: false });
    this.log('Bot stopped.', 'info');
  }

  async stop() {
    if (!this.running) return;
    this.stopRequested = true;
    this.log('Stop signal received — finishing current operation...', 'warn');
  }

  getStats() {
    return { ...this.stats };
  }

  isRunning() {
    return this.running;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = VolumeBot;
