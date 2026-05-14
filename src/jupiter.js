// src/jupiter.js
// Real Jupiter v6 API integration

const fetch = require('node-fetch');
const { VersionedTransaction, Connection, PublicKey } = require('@solana/web3.js');

const JUPITER_API = process.env.JUPITER_API || 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Get a swap quote from Jupiter
 */
async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 300) {
  const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false&asLegacyTransaction=false`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter quote failed: ${res.status} — ${text}`);
  }
  return res.json();
}

/**
 * Get a serialized swap transaction from Jupiter
 */
async function getSwapTransaction(quoteResponse, userPublicKey, priorityFeeMicroLamports = 100000) {
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: priorityFeeMicroLamports,
        priorityLevel: 'high'
      }
    }
  };

  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter swap tx failed: ${res.status} — ${text}`);
  }

  const { swapTransaction } = await res.json();
  return swapTransaction;
}

/**
 * Execute a buy: SOL -> Token
 */
async function executeBuy(connection, keypair, tokenMint, solAmountLamports, slippageBps, priorityFee) {
  const quote = await getQuote(SOL_MINT, tokenMint, solAmountLamports, slippageBps);
  const swapTxBase64 = await getSwapTransaction(quote, keypair.publicKey.toString(), priorityFee);

  const txBuf = Buffer.from(swapTxBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'processed'
  });

  const confirmation = await connection.confirmTransaction({
    signature: sig,
    ...(await connection.getLatestBlockhash('confirmed'))
  }, 'confirmed');

  if (confirmation.value.err) {
    throw new Error(`Buy tx failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return { sig, quote, type: 'buy' };
}

/**
 * Execute a sell: Token -> SOL
 * Gets current token balance and sells all of it
 */
async function executeSell(connection, keypair, tokenMint, slippageBps, priorityFee) {
  const pubkey = keypair.publicKey;

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
    mint: new PublicKey(tokenMint)
  });

  if (!tokenAccounts.value.length) {
    throw new Error('No token balance to sell');
  }

  const tokenAccount = tokenAccounts.value[0];
  const rawAmount = tokenAccount.account.data.parsed.info.tokenAmount.amount;

  if (rawAmount === '0' || rawAmount === 0) {
    throw new Error('Token balance is 0, skipping sell');
  }

  const quote = await getQuote(tokenMint, SOL_MINT, rawAmount, slippageBps);
  const swapTxBase64 = await getSwapTransaction(quote, pubkey.toString(), priorityFee);

  const txBuf = Buffer.from(swapTxBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'processed'
  });

  const confirmation = await connection.confirmTransaction({
    signature: sig,
    ...(await connection.getLatestBlockhash('confirmed'))
  }, 'confirmed');

  if (confirmation.value.err) {
    throw new Error(`Sell tx failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return { sig, quote, type: 'sell' };
}

module.exports = { getQuote, getSwapTransaction, executeBuy, executeSell, SOL_MINT };
