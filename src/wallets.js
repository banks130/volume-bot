// src/wallets.js
// Ephemeral maker wallet management

const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const bs58 = require('bs58');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadMainWallet() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY not set in .env');

  let secretKey;

  try {
    secretKey = bs58.decode(pk.trim());
  } catch (_) {}

  if (!secretKey) {
    try {
      secretKey = Uint8Array.from(JSON.parse(pk));
    } catch (_) {}
  }

  if (!secretKey || secretKey.length !== 64) {
    throw new Error('PRIVATE_KEY must be base58 string or JSON uint8 array of length 64');
  }

  return Keypair.fromSecretKey(secretKey);
}

function generateEphemeralWallets(count) {
  return Array.from({ length: count }, () => Keypair.generate());
}

async function distributeSol(connection, mainWallet, recipients, solPerWalletLamports, broadcast) {
  broadcast('info', `Distributing SOL to ${recipients.length} maker wallets (${(solPerWalletLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL each)...`);

  const BATCH_SIZE = 10;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(recipients.length / BATCH_SIZE);

    let success = false;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

        const tx = new Transaction({
          recentBlockhash: blockhash,
          feePayer: mainWallet.publicKey
        });

        for (const wallet of batch) {
          tx.add(SystemProgram.transfer({
            fromPubkey: mainWallet.publicKey,
            toPubkey: wallet.publicKey,
            lamports: solPerWalletLamports
          }));
        }

        tx.sign(mainWallet);

        const sig = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 2
        });

        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed'
        );

        broadcast('success', `Batch ${batchNum}/${totalBatches} funded ✓ (wallets ${i + 1}–${Math.min(i + BATCH_SIZE, recipients.length)})`);
        success = true;
        break;

      } catch (err) {
        lastErr = err;
        broadcast('warn', `Batch ${batchNum} attempt ${attempt} failed: ${err.message.slice(0, 80)}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }

    if (!success) {
      throw new Error(`Failed to fund batch ${batchNum} after 3 attempts: ${lastErr?.message}`);
    }

    if (i + BATCH_SIZE < recipients.length) {
      await sleep(500);
    }
  }

  broadcast('success', `All ${recipients.length} wallets funded ✓`);
}

async function reclaimSol(connection, mainWallet, wallets, broadcast) {
  broadcast('info', `Reclaiming SOL from ${wallets.length} ephemeral wallets...`);

  let totalReclaimed = 0;
  let skipped = 0;

  for (const wallet of wallets) {
    try {
      const balance = await connection.getBalance(wallet.publicKey, 'confirmed');

      const FEE_BUFFER = 10000;
      const MIN_BALANCE = 890880 + FEE_BUFFER;
      const reclaimable = balance - MIN_BALANCE;

      if (reclaimable <= 0) {
        skipped++;
        continue;
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: wallet.publicKey
      });

      tx.add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: mainWallet.publicKey,
        lamports: reclaimable
      }));

      tx.sign(wallet);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2
      });

      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      totalReclaimed += reclaimable;

    } catch (e) {
      skipped++;
    }
  }

  const reclaimedSol = (totalReclaimed / LAMPORTS_PER_SOL).toFixed(4);
  broadcast('success', `Reclaimed ${reclaimedSol} SOL (${skipped} wallets had insufficient balance)`);
  return totalReclaimed;
}

async function getBalance(connection, pubkeyOrString) {
  const pk = typeof pubkeyOrString === 'string'
    ? new PublicKey(pubkeyOrString)
    : pubkeyOrString;
  const bal = await connection.getBalance(pk, 'confirmed');
  return bal / LAMPORTS_PER_SOL;
}

module.exports = {
  loadMainWallet,
  generateEphemeralWallets,
  distributeSol,
  reclaimSol,
  getBalance
};
