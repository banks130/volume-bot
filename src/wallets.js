// src/wallets.js
// Ephemeral maker wallet management

const {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58 = require('bs58');

const GAS_RESERVE = parseFloat(process.env.GAS_RESERVE_SOL || '0.01') * LAMPORTS_PER_SOL;

function loadMainWallet() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY not set in environment');

  let secretKey;
  try {
    secretKey = bs58.decode(pk);
  } catch {
    try {
      secretKey = Uint8Array.from(JSON.parse(pk));
    } catch {
      throw new Error('PRIVATE_KEY must be base58 or JSON array format');
    }
  }

  return Keypair.fromSecretKey(secretKey);
}

function generateEphemeralWallets(count) {
  return Array.from({ length: count }, () => Keypair.generate());
}

async function distributeSol(connection, mainWallet, recipients, solPerWalletLamports, broadcast) {
  broadcast('info', `Distributing SOL to ${recipients.length} maker wallets...`);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const batchSize = 10;
  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: mainWallet.publicKey });

    for (const wallet of batch) {
      tx.add(SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: wallet.publicKey,
        lamports: solPerWalletLamports
      }));
    }

    tx.sign(mainWallet);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

    broadcast('success', `Funded wallets ${i + 1}–${Math.min(i + batchSize, recipients.length)} ✓`);
  }
}

async function reclaimSol(connection, mainWallet, wallets, broadcast) {
  broadcast('info', `Reclaiming SOL from ${wallets.length} wallets...`);
  let totalReclaimed = 0;

  for (const wallet of wallets) {
    try {
      const balance = await connection.getBalance(wallet.publicKey);
      const rentExempt = 890880;
      const reclaimable = balance - rentExempt - 5000;

      if (reclaimable <= 0) continue;

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey });
      tx.add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: mainWallet.publicKey,
        lamports: reclaimable
      }));
      tx.sign(wallet);

      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      totalReclaimed += reclaimable;
    } catch (e) {
      // Wallet may be empty, skip
    }
  }

  broadcast('success', `Reclaimed ${(totalReclaimed / LAMPORTS_PER_SOL).toFixed(4)} SOL from maker wallets`);
  return totalReclaimed;
}

async function getBalance(connection, pubkey) {
  const bal = await connection.getBalance(new PublicKey(pubkey));
  return bal / LAMPORTS_PER_SOL;
}

module.exports = {
  loadMainWallet,
  generateEphemeralWallets,
  distributeSol,
  reclaimSol,
  getBalance,
  GAS_RESERVE
};
