// src/server.js
// Express REST API + WebSocket broadcast server

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const VolumeBot = require('./bot');

const PORT = parseInt(process.env.PORT || '3000');
const NETWORK = process.env.NETWORK || 'mainnet-beta';

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Set();

function broadcast(type, message, extra = {}) {
  const payload = JSON.stringify({ type, message, ...extra });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

const bot = new VolumeBot(broadcast);

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);

  ws.send(JSON.stringify({ type: 'status', running: bot.isRunning() }));
  ws.send(JSON.stringify({ type: 'network', network: NETWORK }));

  if (bot.isRunning()) {
    const stats = bot.getStats();
    ws.send(JSON.stringify({
      type: 'volume',
      data: {
        wallVolume: stats.wallVolume,
        phaseVolume: stats.phaseVolume,
        totalVolume: stats.totalVolume,
        solSpent: stats.solSpent
      }
    }));
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    clients.delete(ws);
  });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    running: bot.isRunning(),
    network: NETWORK,
    stats: bot.getStats()
  });
});

// POST /api/start — start the bot
app.post('/api/start', async (req, res) => {
  if (bot.isRunning()) {
    return res.status(409).json({ success: false, message: 'Bot is already running' });
  }

  const { package: pkg, makers, solPerTrade, tokenAddress, randomDelay, autoRebalance, targetPrice } = req.body;

  if (!tokenAddress) {
    return res.status(400).json({ success: false, message: 'tokenAddress is required' });
  }

  const config = {
    package:       pkg || 'pump',
    makers:        parseInt(makers) || 50,
    solPerTrade:   parseFloat(solPerTrade) || 0.08,
    tokenAddress,
    randomDelay:   randomDelay !== false,
    autoRebalance: !!autoRebalance,
    targetPrice:   !!targetPrice
  };

  res.json({ success: true, message: 'Bot starting...', config });

  bot.start(config).catch(err => {
    console.error('[SERVER] Bot uncaught error:', err);
    broadcast('log', `Fatal error: ${err.message}`, { level: 'error' });
  });
});

// POST /api/stop — stop the bot
app.post('/api/stop', async (req, res) => {
  if (!bot.isRunning()) {
    return res.json({ success: false, message: 'Bot is not running' });
  }

  await bot.stop();
  res.json({ success: true, message: 'Stop signal sent' });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), network: NETWORK });
});

// Catch-all: serve frontend for any unknown route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

server.listen(PORT, () => {
  console.log(`\nVolume Bot Server running on http://localhost:${PORT}`);
  console.log(`WebSocket listening on ws://localhost:${PORT}`);
  console.log(`Network: ${NETWORK}`);
  console.log(`\n  Open http://localhost:${PORT} in your browser\n`);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  if (bot.isRunning()) {
    await bot.stop();
    await new Promise(r => setTimeout(r, 4000));
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (bot.isRunning()) {
    await bot.stop();
    await new Promise(r => setTimeout(r, 4000));
  }
  process.exit(0);
});
