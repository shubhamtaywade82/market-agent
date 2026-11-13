import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface UiSymbolState {
  symbol: string;
  mark: number;
  regime: string;
  stale: string[];
  updatedAt: number;
  bid?: number;
  ask?: number;
  spreadBps?: number;
  imbalance?: number;
  funding?: number;
}

export interface UiDeskState {
  harness: string;
  status: string;
  mode: string;
  dayR: number;
  cumR: number;
  peakR: number;
  consecLosses: number;
  cooldownUntil: number;
  halted: boolean;
  exposure: { positions: number; riskUnits: number };
}

export interface UiEvent {
  t: string;
  level: string;
  msg: string;
  [key: string]: unknown;
}

export interface UiSnapshot {
  symbols: Record<string, UiSymbolState>;
  desk: UiDeskState | null;
  positions: Array<Record<string, unknown>>;
  events: UiEvent[];
  killed: boolean;
}

export interface UiServerInstance {
  publish(event: UiEvent): void;
  close(): Promise<void>;
  port: number;
}

export function createUiServer(
  port: number,
  dataDir: string,
  onListening?: (boundPort: number) => void
): UiServerInstance {
  const clients = new Set<ServerResponse>();
  const killFile = join(dataDir, 'KILL');
  const symbols: Record<string, UiSymbolState> = {};
  const events: UiEvent[] = [];
  let desk: UiDeskState | null = null;
  const positions: Array<Record<string, unknown>> = [];
  let currentPort = port;
  let attempts = 0;

  const updateSnapshot = (ev: UiEvent): void => {
    if (ev.msg !== 'tick') {
      events.push(ev);
      if (events.length > 80) events.shift();
    }
    if ((ev.msg === 'heartbeat' || ev.msg === 'tick') && typeof ev.symbol === 'string') {
      symbols[ev.symbol] = {
        symbol: ev.symbol,
        mark: Number(ev.mark) || 0,
        regime: String(ev.regime || 'UNKNOWN'),
        stale: Array.isArray(ev.stale) ? (ev.stale as string[]) : [],
        updatedAt: Date.now(),
        ...(typeof ev.bid === 'number' ? { bid: ev.bid } : {}),
        ...(typeof ev.ask === 'number' ? { ask: ev.ask } : {}),
        ...(typeof ev.spreadBps === 'number' ? { spreadBps: ev.spreadBps } : {}),
        ...(typeof ev.imbalance === 'number' ? { imbalance: ev.imbalance } : {}),
        ...(typeof ev.funding === 'number' ? { funding: ev.funding } : {}),
      };
    } else if (ev.msg === 'desk' && typeof ev.mode === 'string') {
      desk = ev as unknown as UiDeskState;
    }
  };

  const getSnapshot = (): UiSnapshot => ({
    symbols,
    desk,
    positions,
    events,
    killed: existsSync(killFile),
  });

  const handleSse = (res: ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', data: getSnapshot() })}\n\n`);
    clients.add(res);
    res.on('close', () => clients.delete(res));
  };

  const handleKill = (res: ServerResponse): void => {
    const isKilled = existsSync(killFile);
    if (isKilled) unlinkSync(killFile);
    else writeFileSync(killFile, 'KILLED BY UI\n');
    const newState = !isKilled;
    const payload = JSON.stringify({ type: 'kill', killed: newState });
    for (const c of clients) c.write(`data: ${payload}\n\n`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  const handleStatic = (res: ServerResponse): void => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const htmlPath = join(dir, 'dashboard.html');
    try {
      const html = readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Dashboard HTML not found.');
    }
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url?.split('?')[0] || '/';
    if (url === '/api/stream' && req.method === 'GET') {
      handleSse(res);
    } else if (url === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(getSnapshot()));
    } else if (url === '/api/kill' && req.method === 'POST') {
      handleKill(res);
    } else if (url === '/' && req.method === 'GET') {
      handleStatic(res);
    } else {
      res.writeHead(404).end();
    }
  });

  const urlFile = join(dataDir, 'ui-url.txt');
  server.on('listening', () => {
    try {
      writeFileSync(urlFile, `http://127.0.0.1:${currentPort}\n`);
    } catch {
      // Ignore if dataDir does not exist yet
    }
    onListening?.(currentPort);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    // If port is occupied, try next port up to 5 times before falling back silently
    if (err.code === 'EADDRINUSE' && attempts < 5) {
      attempts++;
      currentPort++;
      server.listen(currentPort, '0.0.0.0');
    }
  });

  server.listen(currentPort, '0.0.0.0');

  return {
    get port() {
      return currentPort;
    },
    publish(ev: UiEvent): void {
      updateSnapshot(ev);
      // Zero-cost when no clients are connected:
      if (clients.size === 0) return;
      const msg = `data: ${JSON.stringify({ type: 'event', event: ev })}\n\n`;
      for (const client of clients) client.write(msg);
    },
    async close(): Promise<void> {
      try {
        unlinkSync(urlFile);
      } catch { /* ignore if already unlinked */ }
      for (const c of clients) c.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
