# market-agent

Data-only market context, LLM intent and learning loop for Binance USDⓈ-M perpetuals.
Paper execution only. No credentials, no order placement.

## Run

```
npm install
npm test                 # 97 tests
ollama pull openbmb/minicpm5-2b
npm start                # live data + sized paper positions, journals in ./data (opens UI on :3800)
npm run tui              # live React + Ink terminal cockpit
npm run learn            # optional: the runner already does this every LEARN_INTERVAL_H
```

Open `http://localhost:3800` in any browser to view the real-time Web Cockpit (live mark prices, regimes, risk desk metrics, event stream, and kill switch). If the browser is closed, the runner continues headless with zero overhead.

`touch data/KILL` cancels resting entries, flattens every position and blocks new ones until the file is removed.

## Flow

```
Binance WS (/market, /public) -> parseFrame -> MarketState (idempotent reducer)
                                                   |
                         closed candles only -> buildContext (5 timeframes, flow, liquidations, regime)
                                                   |
        15m close or regime change -> decide (Ollama, schema-locked, fail-closed)
                                                   |
                    resolvePlan (prices from live state, mandatory stop, risk gates)
                                                   |
        RiskDesk.approve (tier sizing, day stop, cooldown, drawdown throttle/halt, exposure caps)
                                                   |
     PaperExecutor FSM: IDLE -> ENTRY_PENDING -> OPEN -> IDLE, trail ratchet on each 15m close
                                                   |
                 journal-<harness>.jsonl -> bucketStats -> reason codes -> one bounded mutation
                                                   |
                     CANDIDATE harness -> forward paper trades -> promotionGate
```

## Running against paper_exchange

With `PX_URL` set, orders go to a [paper_exchange](https://github.com/shubhamtaywade82/paper_exchange)
server instead of the in-memory fill model. The exchange owns orders, positions, fills, fees
and the stop; this process keeps only the plan and trail state in `data/exec-<harness>.json`.

```
PX_URL=http://localhost:3100 PAPER_EXCHANGE_API_KEY=<key> EQUITY_USD=<equity> npm start
```

- One account per harness: `<PX_ACCOUNT_PREFIX>-<harness id>`, created through `POST /api/account/reset` if missing (the server allows that in development only).
- Entry: `bounded` limit order with a client id derived from the intent, so a retry never doubles it.
- Stop: a `stop_loss` protection placed when the fill is seen, moved by creating the new one before cancelling the old. A position that cannot be protected within 10 seconds is flattened.
- Exit accounting: price and charges are read from the `TRADE` rows of `/api/ledger`.
- Restart: resting orders and open positions resume; a position the exchange holds that this process does not know blocks entries on that symbol.
- `PX_FEED=push` (default): this process posts quotes to `/api/market_events` and marks to `/api/mark_prices` every second. `PX_FEED=autonomous`: the exchange runs its own Binance feed (`PAPER_EXCHANGE_ENABLE_BINANCE=true`).

## Desk rules

| Rule | Default | Effect |
|---|---|---|
| Tier sizing | PROVEN 1x, PROBATION 0.5x, BENCHED 0 | Risk follows evidence per regime and setup. |
| Daily loss | 3 risk units | No new entries until the next UTC day. |
| Loss streak | 3 in a row | 4 hour cooldown. |
| Drawdown throttle | 5 risk units from peak | All risk halved. |
| Drawdown halt | 10 risk units from peak | Halted across restarts until `desk-<id>.json` is reset by hand. |
| Exposure | 2 positions, 2 risk units | A stop at breakeven frees its risk. |

Demotion is immediate because it only removes risk. Promotion needs a positive bootstrap
interval over the bucket's last 60 trades. A benched bucket gets one half-size probe after
14 days.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `EQUITY_USD` | none, required | Sizing basis. |
| `RISK_PCT` | `0.005` | Base risk per trade before desk scaling. |
| `DESK_*` | see Desk rules | `DESK_DAILY_LOSS_R`, `DESK_THROTTLE_DD_R`, `DESK_MAX_DD_R`, `DESK_MAX_CONSEC_LOSSES`, `DESK_COOLDOWN_MIN`, `DESK_MAX_POSITIONS`, `DESK_MAX_OPEN_RISK`. |
| `LEARN_INTERVAL_H` | `24` | 0 disables in-process learning. |
| `PX_URL`, `PAPER_EXCHANGE_API_KEY`, `PX_ACCOUNT_PREFIX`, `PX_FEED` | unset | See Running against paper_exchange. |
| `SYMBOLS` | `SOLUSDT,ETHUSDT,XRPUSDT` | |
| `LEVERAGE` | `5` | Hard-capped at 10. Only used by the liquidation-buffer gate. |
| `LIQ_BUFFER_FRAC` | `0.5` | Stop distance must be below this / leverage. |
| `MAKER_BPS` / `TAKER_BPS` | `2` / `5` | Placeholders. Set to your execution venue's fees. |
| `SLIPPAGE_BPS` | `2` | Applied to stop exits. |
| `CASCADE_LIQ_USD_5M_<SYMBOL>` | unset | Cascade regime is disabled per symbol until set. |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / `openbmb/minicpm5-2b` | |
| `OLLAMA_THINK` | unset | `true`/`false` is sent as Ollama's `think` flag. |
| `OLLAMA_TIMEOUT_MS` | `20000` | A late decision is discarded, never retried. |
| `DATA_DIR` | `./data` | Journals and `harnesses.json`. |

The process refuses to start if an exchange key or secret is present in the environment.

## Not modelled

- Funding accrual in paper R.
- Without `PX_URL`, open paper positions are in memory and a restart drops them.
- Order book depth beyond top of book (no `@depth` stream yet).
- Tick, step and minimum quantity come from Binance `exchangeInfo`; a different execution venue needs its own.
- Harness defaults in `src/config.ts` are starting values, not calibrated ones.
