import fs from 'fs-extra';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import config from './config.js';
import store from './lib/store.js';
import { runPreflight } from './lib/preflight.js';
import { maybeGreetNewUser } from './lib/channelInvite.js';
import { extractText, isStatusJid, normalizePhone } from './lib/utils.js';

// === Zero-Crash Global Error Protection ===
process.on('unhandledRejection', (reason) => {
  console.error('[Global] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Global] Uncaught Exception:', err);
});

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const plugins = [];
const commandMap = new Map();

let presenceInterval = null;
let pairingRequested = false;
let isStarting = false;
let reconnectAttempts = 0;
let dashboardStarted = false;

const botRuntimeState = {
  status: 'BOOTING', // BOOTING | PAIRING_REQUIRED | QR_READY | CONNECTED | RECONNECTING | LOGGED_OUT
  authMode: config.authMode === 'qr' ? 'qr' : 'pairing',
  pairingCode: null,
  qrText: null,
  qrDataUrl: null,
  lastError: null,
  startedAt: Date.now(),
};

async function loadPlugins() {
  plugins.length = 0;
  commandMap.clear();
  const pluginsDir = path.resolve('./plugins');
  const files = (await fs.readdir(pluginsDir)).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const modUrl = pathToFileURL(path.join(pluginsDir, file)).href;
    const mod = (await import(modUrl)).default;
    if (!mod) continue;
    plugins.push(mod);
    if (Array.isArray(mod.commands)) {
      for (const cmd of mod.commands) {
        commandMap.set(cmd.toLowerCase(), mod);
      }
    }
  }
  console.log(`[Plugins] Loaded ${plugins.length} modules (${commandMap.size} commands).`);
}

async function resolvePairingPhoneNumber() {
  let phone = normalizePhone(config.pairingPhoneNumber);
  if ((!phone || phone === '94771234567') && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        '\n📱 Enter WhatsApp number for 8-digit Pairing Code (country code + number, e.g. 94771234567): '
      );
      phone = normalizePhone(answer);
    } finally {
      rl.close();
    }
  }
  return phone;
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function startWebDashboard() {
  if (dashboardStarted || !config.dashboard?.enabled) return;
  dashboardStarted = true;
  const port = Number(process.env.PORT || config.dashboard?.port || 3000);

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: botRuntimeState.status,
          authMode: botRuntimeState.authMode,
          bot: config.botName,
          plugins: plugins.length,
          uptimeSec: Math.floor(process.uptime()),
        })
      );
      return;
    }

    if (req.url === '/api/auth') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: botRuntimeState.status,
          authMode: botRuntimeState.authMode,
          pairingCode: botRuntimeState.pairingCode,
          qrText: botRuntimeState.qrText,
          qrDataUrl: botRuntimeState.qrDataUrl,
          botName: config.botName,
          channelUrl: config.channelInvite.channelUrl,
        })
      );
      return;
    }

    let authHtml = `<div class="hint">Status: <b>${escapeHtml(botRuntimeState.status)}</b> (Auto-refreshing every 4s...)</div>`;

    if (botRuntimeState.status === 'CONNECTED') {
      authHtml = `<div class="connected-box">✅ WhatsApp Multi-Device Connected & Active</div>`;
    } else if (botRuntimeState.authMode === 'qr' && botRuntimeState.qrDataUrl) {
      authHtml = `<div class="code-box">
        <div class="label">SCAN WHATSAPP QR CODE</div>
        <img class="qr-img" src="${botRuntimeState.qrDataUrl}" alt="WhatsApp Login QR Code" />
        <p class="hint">Open WhatsApp → Linked Devices → Link a Device → Scan this QR code</p>
      </div>`;
    } else if (botRuntimeState.pairingCode) {
      authHtml = `<div class="code-box">
        <div class="label">8-DIGIT WHATSAPP PAIRING CODE</div>
        <div class="code">${escapeHtml(botRuntimeState.pairingCode)}</div>
        <p class="hint">Open WhatsApp → Linked Devices → Link a Device → Link with phone number instead</p>
      </div>`;
    }

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="refresh" content="4" />
  <title>${escapeHtml(config.botName)} • Auth & Status</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0b141a;color:#e9edef;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:460px;width:100%;background:#111b21;border:1px solid #2e424d;border-radius:20px;padding:24px;box-shadow:0 16px 40px rgba(0,0,0,.4)}
    .badge{display:inline-block;padding:4px 10px;border-radius:99px;background:#0a3d22;color:#25d366;font-size:12px;font-weight:700;margin-bottom:10px}
    h1{margin:0 0 8px;font-size:22px}
    .code-box{background:#0b141a;border:1px solid #25d366;border-radius:14px;padding:18px;text-align:center;margin:16px 0}
    .label{font-size:11px;letter-spacing:1px;color:#25d366;font-weight:700}
    .code{font-size:32px;font-weight:800;letter-spacing:4px;margin:10px 0;font-family:monospace;color:#fff}
    .qr-img{width:230px;height:230px;border-radius:12px;background:#fff;padding:10px;margin:12px auto;display:block}
    .connected-box{background:#0a3d22;border:1px solid #25d366;border-radius:12px;padding:14px;text-align:center;font-weight:700;margin:16px 0}
    .hint{font-size:13px;color:#99a9b2;line-height:1.5}
    .meta{font-size:12px;color:#99a9b2;margin-top:16px;border-top:1px solid #2e424d;padding-top:12px}
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">${escapeHtml(botRuntimeState.status)} • ${escapeHtml(botRuntimeState.authMode.toUpperCase())}</span>
    <h1>${escapeHtml(config.botName)}</h1>
    ${authHtml}
    <div class="meta">Plugins: ${plugins.length} • Commands: ${commandMap.size} • Uptime: ${Math.floor(process.uptime())}s</div>
  </div>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  server.on('error', (err) => {
    console.warn(`[Dashboard] Could not bind port ${port}: ${err.message}`);
  });

  server.listen(port, () => {
    console.log(`[Dashboard] Live QR / Pairing & Health UI running at http://localhost:${port}`);
  });
}

function scheduleReconnect(delayMs) {
  setTimeout(() => {
    startBot().catch((err) => {
      console.error('[Reconnect] Failed:', err.message);
    });
  }, delayMs);
}

async function startBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    await store.init();
    await fs.ensureDir(config.authDir);

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }

    const useQrMode = config.authMode === 'qr';
    botRuntimeState.authMode = useQrMode ? 'qr' : 'pairing';

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      getMessage: async (key) => {
        const stored = store.getMessage(key.remoteJid, key.id);
        return stored?.message || undefined;
      },
      markOnlineOnConnect: config.automation.alwaysOnline,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    // === 8-Digit Pairing Code Flow (when authMode === 'pairing') ===
    if (!useQrMode && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      setTimeout(async () => {
        try {
          const phone = await resolvePairingPhoneNumber();
          if (!phone || phone.length < 8) {
            botRuntimeState.status = 'PAIRING_REQUIRED';
            botRuntimeState.lastError = 'Invalid PAIRING_NUMBER';
            console.error('[Pairing] Set PAIRING_NUMBER in .env (e.g. 94771234567) or run "npm run setup".');
            return;
          }
          const rawCode = await sock.requestPairingCode(phone);
          const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
          botRuntimeState.status = 'PAIRING_REQUIRED';
          botRuntimeState.pairingCode = formattedCode;
          botRuntimeState.qrText = null;
          botRuntimeState.qrDataUrl = null;

          console.log('\n╔══════════════════════════════════════════════╗');
          console.log(`║  🔑 WHATSAPP 8-DIGIT PAIRING CODE: ${formattedCode}  ║`);
          console.log('╚══════════════════════════════════════════════╝');
          console.log('👉 Open WhatsApp → Linked Devices → Link a Device → Link with phone number instead\n');
        } catch (err) {
          pairingRequested = false;
          botRuntimeState.lastError = err.message;
          console.error('[Pairing] Failed to request pairing code:', err.message);
        }
      }, 2500);
    }

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      // === QR Code Flow (when authMode === 'qr') ===
      if (qr && useQrMode) {
        botRuntimeState.status = 'QR_READY';
        botRuntimeState.qrText = qr;
        botRuntimeState.pairingCode = null;
        try {
          botRuntimeState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
        } catch {
          botRuntimeState.qrDataUrl = null;
        }
        console.log('\n📷 [QR Auth] Scan the QR Code below (or open http://localhost:' + (process.env.PORT || config.dashboard?.port || 3000) + '):\n');
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === 'open') {
        pairingRequested = false;
        reconnectAttempts = 0;
        botRuntimeState.status = 'CONNECTED';
        botRuntimeState.pairingCode = null;
        botRuntimeState.qrText = null;
        botRuntimeState.qrDataUrl = null;
        botRuntimeState.lastError = null;
        console.log(`✅ [${config.botName}] Connected & Multi-Device Ready!`);

        if (config.automation.alwaysOnline) {
          await sock.sendPresenceUpdate('available').catch(() => {});
          if (presenceInterval) clearInterval(presenceInterval);
          presenceInterval = setInterval(() => {
            if (config.automation.alwaysOnline) {
              sock.sendPresenceUpdate('available').catch(() => {});
            }
          }, 55000);
        }
      }

      if (connection === 'close') {
        if (presenceInterval) clearInterval(presenceInterval);
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

        if (isLoggedOut) {
          botRuntimeState.status = 'LOGGED_OUT';
          console.error('[Auth] Session logged out. Delete auth folder and run "npm start" to pair again.');
          return;
        }

        if (isReplaced) {
          botRuntimeState.status = 'RECONNECTING';
          console.warn('[Connection] Replaced by another session. Retrying in 15s...');
          scheduleReconnect(15000);
          return;
        }

        reconnectAttempts += 1;
        const backoff = Math.min(30000, 3000 * reconnectAttempts);
        botRuntimeState.status = 'RECONNECTING';
        console.warn(`[Connection] Closed (code: ${statusCode ?? 'unknown'}). Reconnecting in ${backoff / 1000}s...`);
        scheduleReconnect(backoff);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const remoteJid = msg.key?.remoteJid || '';
          if (remoteJid.endsWith('@newsletter')) continue;

          if (isStatusJid(remoteJid)) {
            for (const plugin of plugins) {
              if (plugin.onStatus) await plugin.onStatus({ sock, msg });
            }
            continue;
          }

          store.saveMessage(msg);

          const text = extractText(msg);

          let handledPassively = false;
          for (const plugin of plugins) {
            if (plugin.onPassiveMessage) {
              const consumed = await plugin.onPassiveMessage({ sock, msg, text });
              if (consumed) handledPassively = true;
            }
          }

          if (!msg.key?.fromMe) {
            await maybeGreetNewUser(sock, msg);
          }

          if (text.startsWith(config.prefix)) {
            const body = text.slice(config.prefix.length).trim();
            const [rawCmd, ...args] = body.split(/\s+/);
            const command = (rawCmd || '').toLowerCase();
            const handler = commandMap.get(command);
            if (handler?.onCommand) {
              await handler.onCommand({ sock, msg, command, args, text });
              continue;
            }
          }

          if (msg.key?.fromMe || handledPassively) continue;

          for (const plugin of plugins) {
            if (plugin.onMessage) {
              const handled = await plugin.onMessage({ sock, msg, text });
              if (handled) break;
            }
          }
        } catch (err) {
          console.error('[MessageHandler] Error:', err.message);
        }
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const plugin of plugins) {
        if (plugin.onMessageUpdate) {
          await plugin.onMessageUpdate({ sock, updates }).catch(() => {});
        }
      }
    });

    sock.ev.on('group-participants.update', async (event) => {
      for (const plugin of plugins) {
        if (plugin.onGroupParticipantsUpdate) {
          await plugin.onGroupParticipantsUpdate({ sock, event }).catch(() => {});
        }
      }
    });

    sock.ev.on('call', async (calls) => {
      for (const plugin of plugins) {
        if (plugin.onCall) {
          await plugin.onCall({ sock, calls }).catch(() => {});
        }
      }
    });
  } catch (err) {
    botRuntimeState.lastError = err.message;
    console.error('[Boot] Socket startup error:', err.message);
    scheduleReconnect(5000);
  } finally {
    isStarting = false;
  }
}

(async () => {
  await runPreflight();
  await loadPlugins();
  startWebDashboard();
  await startBot();
})();
