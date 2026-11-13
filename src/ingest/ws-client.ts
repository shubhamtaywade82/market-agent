import WebSocket from 'ws';
import { TFS, type Logger } from '../types';

/**
 * Binance USDⓈ-M routes streams by path since the 2026 base-URL split:
 * /market carries aggTrade, markPrice, kline and forceOrder; /public carries the
 * high-frequency book streams. An unrouted connection only delivers /public data.
 */
export interface StreamPlan {
  market: string[];
  public: string[];
}

export function buildStreamPlan(symbols: string[]): StreamPlan {
  const market: string[] = [];
  const pub: string[] = [];
  for (const s of symbols.map((x) => x.toLowerCase())) {
    market.push(`${s}@aggTrade`, `${s}@markPrice@1s`, `${s}@forceOrder`);
    for (const tf of TFS) market.push(`${s}@kline_${tf}`);
    pub.push(`${s}@bookTicker`);
  }
  for (const list of [market, pub]) {
    if (list.length > 1024) throw new Error(`Too many streams for one connection: ${list.length} > 1024`);
  }
  return { market, public: pub };
}

export function streamUrl(base: string, route: 'market' | 'public', streams: string[]): string {
  return `${base.replace(/\/$/, '')}/${route}/stream?streams=${streams.join('/')}`;
}

export interface RoutedStreamOpts {
  name: string;
  url: string;
  onMessage: (raw: string) => void;
  /** Called on every successful open; reconnect=true means candles may have a gap to repair. */
  onOpen: (reconnect: boolean) => void;
  log: Logger;
  /** Force a reconnect if no frame arrives for this long. */
  idleMs?: number;
  /** Proactive rotation before Binance's 24h connection limit. */
  rotateMs?: number;
}

/** Reconnecting stream. The ws library answers server pings with pongs automatically. */
export class RoutedStream {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private opens = 0;
  private stopped = false;
  private lastMsg = 0;
  private generation = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: RoutedStreamOpts) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.terminate();
    this.ws = null;
  }

  private clearTimers(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.idleTimer = null;
    this.rotateTimer = null;
  }

  private connect(): void {
    const gen = ++this.generation;
    const { name, url, log } = this.opts;
    const idleMs = this.opts.idleMs ?? 30_000;
    const rotateMs = this.opts.rotateMs ?? 23 * 3_600_000;
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => {
      if (gen !== this.generation) return;
      const reconnect = this.opens > 0;
      this.opens += 1;
      this.attempt = 0;
      this.lastMsg = Date.now();
      log('info', 'ws_open', { name, reconnect });
      this.idleTimer = setInterval(() => {
        if (Date.now() - this.lastMsg > idleMs) {
          log('warn', 'ws_idle_reconnect', { name, idleMs });
          ws.terminate();
        }
      }, Math.max(1_000, Math.floor(idleMs / 3)));
      this.rotateTimer = setTimeout(() => {
        log('info', 'ws_rotate', { name });
        ws.terminate();
      }, rotateMs);
      this.opts.onOpen(reconnect);
    });

    ws.on('message', (data) => {
      if (gen !== this.generation) return;
      this.lastMsg = Date.now();
      this.opts.onMessage(data.toString());
    });

    ws.on('error', (err) => log('warn', 'ws_error', { name, error: err.message }));

    ws.on('close', (code) => {
      if (gen !== this.generation) return;
      this.clearTimers();
      if (this.stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt) + Math.floor(Math.random() * 250);
      this.attempt += 1;
      log('warn', 'ws_closed', { name, code, retryInMs: delay });
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }
}
