import 'dotenv/config';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, type WASocket } from '@whiskeysockets/baileys';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import pino from 'pino';
import QRCode from 'qrcode';
import { useSupabaseAuthState } from './lib/supabaseAuthState';

const logger = pino({ level: 'info' });
const app = express();

// ── CORS & Middleware ─────────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  // Allow requests from any origin (or restrict to specific domains if needed)
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let sock: WASocket | null = null;
let lastQr: string | null = null;
let ready = false;
let reconnectDelay = 3_000;

async function connect(): Promise<void> {
  try {
    const { state, saveCreds } = await useSupabaseAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      syncFullHistory: false, // Don't download full history on connect
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      const { connection, qr, lastDisconnect } = u;

      if (qr) {
        lastQr = qr;
        logger.info('QR code ready — open / to scan');
      }

      if (connection === 'open') {
        ready = true;
        lastQr = null;
        reconnectDelay = 3_000; // reset backoff on successful connect
        logger.info('WhatsApp connected and ready');
      }

      if (connection === 'close') {
        ready = false;
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn({ code, nextRetryMs: reconnectDelay }, 'Connection closed');

        if (code === DisconnectReason.loggedOut) {
          logger.warn('Logged out — open / to re-pair');
          return;
        }

        // Exponential backoff capped at 60 s
        setTimeout(() => connect(), reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      }
    });

    // Handle socket errors
    sock.ev.on('call', (calls) => {
      calls.forEach((call) => {
        logger.info({ from: call.from }, 'Incoming call');
      });
    });

  } catch (err) {
    logger.error(err, 'connect() threw — retrying in 10s');
    setTimeout(() => connect(), 10_000);
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-api-key'] === process.env.WORKER_SECRET) {
    next();
  } else {
    res.sendStatus(401);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/send', auth, async (req: Request, res: Response): Promise<void> => {
  if (!ready || !sock) {
    res.status(503).json({ error: 'socket_not_ready' });
    return;
  }

  const { to, message } = req.body as { to?: string; message?: string };

  if (!to || !message) {
    res.status(400).json({ error: 'to and message are required' });
    return;
  }

  // Strip any accidental + or spaces
  const number = to.replace(/\D/g, '');

  try {
    await sock.sendMessage(`${number}@s.whatsapp.net`, { text: message });
    logger.info({ to: number }, 'Message sent');
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, 'sendMessage failed');
    res.status(500).json({ error: String(e) });
  }
});

app.get('/status', auth, (_req: Request, res: Response): void => {
  res.json({ ready, linked: ready });
});

app.get('/qr', auth, async (_req: Request, res: Response): Promise<void> => {
  if (!lastQr) {
    res.json({ qrImage: null, ready });
    return;
  }
  try {
    const qrImage = await QRCode.toDataURL(lastQr, { width: 256, margin: 2 });
    res.json({ qrImage, ready });
  } catch {
    res.json({ qrImage: null, ready });
  }
});

app.post('/logout', auth, async (_req: Request, res: Response): Promise<void> => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    ready = false;
    lastQr = null;
    // Clear persisted session from Supabase so next connect() shows a fresh QR
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    await sb.from('baileys_auth').delete().neq('id', '');
    logger.info('Logged out and session cleared');
    res.json({ ok: true });
    // Start a fresh connection — will generate a new QR immediately
    connect();
  } catch (e) {
    logger.error(e, 'logout failed');
    res.status(500).json({ error: String(e) });
  }
});

app.get('/health', (_req: Request, res: Response): void => {
  res.sendStatus(200);
});

app.get('/', (_req: Request, res: Response): void => {
  res.sendFile(path.join(__dirname, '..', 'public', 'qr.html'));
});

// ── Boot ──────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '8000', 10);
const HOST = '0.0.0.0'; // Listen on all network interfaces for Render compatibility

connect().catch((err) => {
  logger.error(err, 'Failed to connect on boot');
});

const server = app.listen(PORT, HOST, () => {
  logger.info({ port: PORT, host: HOST }, 'wa-service started');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
