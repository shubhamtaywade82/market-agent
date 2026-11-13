import { z } from 'zod';
import { TFS, type MarketEvent, type Tf } from '../types';

const num = z.coerce.number().finite();
const px = num.positive();

const aggTrade = z.object({ e: z.literal('aggTrade'), s: z.string(), a: num, p: px, q: num.nonnegative(), T: num, m: z.boolean() });
const kline = z.object({
  e: z.literal('kline'),
  E: num,
  s: z.string(),
  k: z.object({ t: num, i: z.string(), o: px, c: px, h: px, l: px, v: num, q: num, Q: num, x: z.boolean() }),
});
const markPrice = z.object({ e: z.literal('markPriceUpdate'), E: num, s: z.string(), p: px, i: px, r: num, T: num });
const bookTicker = z.object({ e: z.literal('bookTicker'), E: num, s: z.string(), b: px, B: num, a: px, A: num });
const forceOrder = z.object({
  e: z.literal('forceOrder'),
  o: z.object({ s: z.string(), S: z.enum(['BUY', 'SELL']), q: num, p: px, ap: num, z: num, T: num }),
});

export type ParseResult =
  | { ok: true; event: MarketEvent }
  | { ok: false; ignored: true }
  | { ok: false; ignored: false; reason: string };

const IGNORED: ParseResult = { ok: false, ignored: true };

function isTf(v: string): v is Tf {
  return (TFS as readonly string[]).includes(v);
}

/** Parses one WebSocket text frame (combined-stream wrapper or raw payload). Never throws. */
export function parseFrame(raw: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, ignored: false, reason: 'invalid_json' };
  }
  if (obj === null || typeof obj !== 'object') return { ok: false, ignored: false, reason: 'not_object' };
  const outer = obj as Record<string, unknown>;
  const d = (outer.data !== undefined ? outer.data : outer) as Record<string, unknown>;
  if (d === null || typeof d !== 'object') return { ok: false, ignored: false, reason: 'no_data' };

  try {
    switch (d.e) {
      case 'aggTrade': {
        const v = aggTrade.parse(d);
        return { ok: true, event: { type: 'aggTrade', symbol: v.s, id: v.a, price: v.p, qty: v.q, ts: v.T, buyerIsMaker: v.m } };
      }
      case 'kline': {
        const v = kline.parse(d);
        if (!isTf(v.k.i)) return IGNORED;
        if (v.k.h < v.k.l) return { ok: false, ignored: false, reason: 'kline_high_below_low' };
        return {
          ok: true,
          event: {
            type: 'kline',
            symbol: v.s,
            tf: v.k.i,
            ts: v.E,
            candle: { t: v.k.t, o: v.k.o, h: v.k.h, l: v.k.l, c: v.k.c, v: v.k.v, q: v.k.q, tbq: v.k.Q, x: v.k.x },
          },
        };
      }
      case 'markPriceUpdate': {
        const v = markPrice.parse(d);
        return { ok: true, event: { type: 'markPrice', symbol: v.s, mark: v.p, index: v.i, funding: v.r, nextFundingTs: v.T, ts: v.E } };
      }
      case 'bookTicker': {
        const v = bookTicker.parse(d);
        if (v.b > v.a) return { ok: false, ignored: false, reason: 'crossed_book' };
        return { ok: true, event: { type: 'bookTicker', symbol: v.s, bid: v.b, bidQty: v.B, ask: v.a, askQty: v.A, ts: v.E } };
      }
      case 'forceOrder': {
        const v = forceOrder.parse(d).o;
        const price = v.ap > 0 ? v.ap : v.p;
        const qty = v.z > 0 ? v.z : v.q;
        return { ok: true, event: { type: 'liquidation', symbol: v.s, side: v.S, price, qty, ts: v.T } };
      }
      default:
        return IGNORED; // subscription acks and streams we do not consume
    }
  } catch (err) {
    const reason = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}:${i.code}`).join(',') : String(err);
    return { ok: false, ignored: false, reason: `${String(d.e)}:${reason}` };
  }
}
