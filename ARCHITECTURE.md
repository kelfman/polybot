# Architecture

> **Polymarket Trading Bot — Late-Stage Convergence Strategy**

This document describes the technical architecture of the trading system.

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              POLYMARKET BOT                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │   Scanner    │────▶│   Strategy   │────▶│   Executor   │                │
│  │              │     │              │     │              │                │
│  │ Gamma API    │     │ Entry/Exit   │     │ CLOB Client  │                │
│  │ Filters      │     │ Rules        │     │ Safety Checks│                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│         │                    │                    │                         │
│         └────────────────────┼────────────────────┘                         │
│                              │                                              │
│                    ┌─────────▼─────────┐                                    │
│                    │   State Manager   │                                    │
│                    │                   │                                    │
│                    │ Positions/Balance │                                    │
│                    │ Reconciliation    │                                    │
│                    └─────────┬─────────┘                                    │
│                              │                                              │
│         ┌────────────────────┼────────────────────┐                         │
│         │                    │                    │                         │
│  ┌──────▼──────┐     ┌───────▼──────┐     ┌──────▼──────┐                  │
│  │  SQLite DB  │     │ Polymarket   │     │  Config     │                  │
│  │             │     │ APIs         │     │             │                  │
│  │ - Markets   │     │ - CLOB       │     │ config.json │                  │
│  │ - Prices    │     │ - Gamma      │     │ Zod Schema  │                  │
│  │ - Trades    │     │ - Data API   │     │             │                  │
│  └─────────────┘     └──────────────┘     └─────────────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
polymarket2/
├── config.json              # Strategy & risk parameters
├── RULES.md                 # Safety rules for AI assistants
├── data/
│   ├── polymarket.db        # SQLite database
│   └── kaggle/              # Historical data for backtesting
│
└── src/
    ├── backtest/            # Backtesting engine
    │   ├── engine.ts        # Trade simulation
    │   ├── metrics.ts       # Performance calculations
    │   ├── run.ts           # CLI entry point
    │   └── sweep.ts         # Parameter optimization
    │
    ├── classification/      # Market classification
    │   ├── index.ts         # Classification orchestrator
    │   ├── volatility.ts    # Price volatility analysis
    │   ├── convergence.ts   # LLM-based convergence prediction
    │   └── types.ts         # Type definitions
    │
    ├── config/
    │   └── index.ts         # Zod-validated configuration loader
    │
    ├── datasources/         # Data ingestion adapters
    │   ├── index.ts         # Factory & manager
    │   ├── gamma.ts         # Gamma API (live)
    │   ├── csv.ts           # CSV files
    │   ├── kaggle.ts        # Kaggle dataset
    │   ├── kaggle-ndjson.ts # Kaggle NDJSON format
    │   └── types.ts         # DataSource interface
    │
    ├── db/                  # Database layer
    │   ├── client.ts        # SQLite wrapper (better-sqlite3)
    │   ├── schema.ts        # Table definitions
    │   └── migrate.ts       # Schema migrations
    │
    ├── ingestion/           # Data pipeline
    │   ├── fetcher.ts       # Orchestrates data fetch
    │   ├── run.ts           # CLI for single source
    │   └── ingest-all.ts    # CLI for all sources
    │
    ├── public/              # Frontend assets
    │   ├── index.html       # Backtest dashboard
    │   ├── live.html        # Live trading dashboard
    │   └── app.js           # Dashboard JavaScript
    │
    ├── server/              # Express HTTP server
    │   ├── index.ts         # Server entry point
    │   ├── routes.ts        # Backtest API routes
    │   └── live-routes.ts   # Live trading API routes
    │
    ├── strategy/            # Trading strategy
    │   └── convergence.ts   # Late-stage convergence logic
    │
    └── trading/             # Live trading system
        ├── bot.ts           # Main bot orchestrator
        ├── scanner.ts       # Market opportunity finder
        ├── executor.ts      # Order placement with safety
        ├── state.ts         # Account state management
        ├── schema.ts        # Live trading DB schema
        ├── analyze.ts       # Trade history analysis
        ├── run.ts           # CLI entry point
        └── index.ts         # Exports
```

---

## Core Components

### 1. Trading Bot (`src/trading/bot.ts`)

The central orchestrator that coordinates all trading operations.

**Responsibilities:**
- Initialize CLOB client connection
- Run periodic market scans
- Process trading opportunities
- Maintain state consistency
- Handle graceful shutdown

**Lifecycle:**
```
initialize() → start() → [scan loop] → stop()
                              ↓
                    runScanCycle() every 60s
                    runStateCheck() every 30s
```

**Key Safety Features:**
- Kill switch for emergency stop
- State reconciliation on startup
- Daily trade limits
- Comprehensive error logging

---

### 2. Market Scanner (`src/trading/scanner.ts`)

Finds markets qualifying for the convergence strategy.

**Qualification Criteria:**
- Binary YES/NO market
- Price in range (e.g., 0.70–0.90)
- Time to resolution in window (e.g., 1–5 days)
- Sufficient liquidity
- Low bid-ask spread

**Market Categories:**
```typescript
type MarketCategory = 
  | 'crypto'       // BTC, ETH price targets
  | 'stocks'       // AAPL, TSLA, etc.
  | 'sports'       // Match outcomes
  | 'politics'     // Elections
  | 'awards'       // Oscars, Emmys
  | 'entertainment'
  | 'other';
```

**Scoring System:**
- Base score from price/time positioning
- Liquidity bonus (up to +15 points)
- Spread penalty (up to -10 for >10%)
- Objective outcome bonus (+5 points)

---

### 3. State Manager (`src/trading/state.ts`)

Maintains accurate account state with Polymarket as source of truth.

**Design Principles:**
1. Truth lives on Polymarket — local state is just a cache
2. Always verify before acting
3. Reconcile on every major operation
4. Never trust stale data (30s threshold)

**Data Sources:**
- **CLOB API**: Orders, trading operations
- **Data API**: Positions, portfolio value (more accurate)
- **On-chain RPC**: USDC balance fallback

**Key Operations:**
```typescript
getState(forceRefresh?)     // Get account state
verifyOrder(orderId)        // Verify order exists
verifyPosition(marketId)    // Check position
hasOpenOrderForMarket(id)   // Prevent duplicates
reconcile()                 // Sync local DB with API
```

---

### 4. Order Executor (`src/trading/executor.ts`)

Places orders with comprehensive safety checks.

**Pre-flight Checks (in order):**
1. **Idempotency** — Same request returns same result
2. **No duplicate pending** — One order per market at a time
3. **No existing position/order** — Prevent overtrading
4. **Position limits** — Max positions not exceeded
5. **Exposure limits** — Max USD exposure not exceeded
6. **Sufficient balance** — Enough funds available

**Order Flow:**
```
Request → Idempotency Check → Safety Checks → DB Record
    → [Dry Run or Live] → Update Status → Return Result
```

---

### 5. Convergence Strategy (`src/strategy/convergence.ts`)

Implements the late-stage convergence harvesting logic.

**Entry Conditions:**
- Price in configured range (e.g., 0.70–0.90 for YES)
- Time to resolution in window (e.g., 1–5 days)
- Market is eligible (binary, has resolution date)

**Exit Conditions:**
- Target price reached (e.g., ≥0.92)
- Market resolved
- Stop-loss triggered (optional)
- Hold to resolution mode

**P&L Calculation:**
```typescript
shares = sizeUsd / entryPrice
exitValue = shares * exitPrice
pnl = exitValue - sizeUsd
```

---

### 6. Backtest Engine (`src/backtest/engine.ts`)

Simulates the strategy against historical data.

**Phases:**
1. **Classification** — Analyze volatility and convergence for all markets
2. **Simulation** — Replay price history, apply entry/exit rules
3. **Metrics** — Calculate win rate, P&L, drawdown, Sharpe ratio

**Features:**
- Progress callbacks for UI updates
- Dry-run mode (don't persist results)
- Volatility filtering
- Category breakdown analysis

---

### 7. Classification System (`src/classification/`)

Classifies markets for performance analysis.

**Volatility Analysis** (`volatility.ts`):
- Calculates daily price swings
- Classifies as `low`, `medium`, or `high`
- Configurable thresholds

**Convergence Prediction** (`convergence.ts`):
- LLM-based analysis (optional)
- Classifies as `natural`, `uncertain`, or `unknown`
- Caching for API efficiency

---

### 8. Data Sources (`src/datasources/`)

Pluggable adapters for market data.

| Source | Use Case | Live Data |
|--------|----------|-----------|
| `gamma` | Live Polymarket API | ✓ |
| `csv` | Local CSV files | ✗ |
| `kaggle` | Kaggle dataset (CSV) | ✗ |
| `kaggle-ndjson` | Kaggle dataset (NDJSON) | ✗ |

**Manager Features:**
- Primary/fallback configuration
- Automatic failover
- Batch operations

---

## Data Layer

### SQLite Database (`data/polymarket.db`)

Uses `better-sqlite3` with WAL mode for concurrent access.

**Core Tables:**

```sql
-- Market metadata
markets (
  id TEXT PRIMARY KEY,
  question TEXT,
  category TEXT,
  resolution_date TEXT,
  outcome TEXT,           -- 'YES', 'NO', or NULL
  is_binary INTEGER,
  volume_usd REAL,
  liquidity_usd REAL
)

-- Historical prices
price_history (
  market_id TEXT,
  timestamp TEXT,
  yes_price REAL,
  no_price REAL,
  volume REAL
)

-- Backtest results
backtest_trades (...)
backtest_runs (...)
```

**Live Trading Tables** (separate schema in `trading/schema.ts`):

```sql
-- Bot execution runs
bot_runs (run_id, mode, status, trades_placed, ...)

-- Live trade records
live_trades (market_id, entry_price, exit_price, pnl, ...)

-- Order tracking with idempotency
order_tracking (idempotency_key, order_id, status, ...)

-- Periodic state snapshots
state_snapshots (balance, exposure, positions, ...)
```

---

## Configuration

### `config.json` Structure

```json
{
  "strategy": {
    "name": "late-stage-convergence",
    "entryPriceMin": 0.70,
    "entryPriceMax": 0.90,
    "exitPriceTarget": 0.92,
    "timeToResolutionDaysMin": 1,
    "timeToResolutionDaysMax": 5,
    "holdToResolution": true,
    "maxVolatility": "low"
  },
  "classification": {
    "volatility": {
      "enabled": true,
      "highVolatilityThreshold": 30,
      "swingCountThreshold": 3
    },
    "llmConvergence": {
      "enabled": false,
      "provider": "openai",
      "model": "gpt-4o-mini"
    }
  },
  "risk": {
    "positionSizeUsd": 10,
    "maxPositions": 5,
    "maxExposureUsd": 50,
    "stopLossPercent": null
  },
  "dataSource": {
    "primary": "kaggle-ndjson",
    "fallback": "kaggle"
  }
}
```

**Validation:**
- All config is validated with Zod schemas
- Logical constraints enforced (e.g., min < max)
- Cached after first load

---

## External APIs

### Polymarket CLOB API

```
Host: https://clob.polymarket.com
Auth: API Key + Secret + Passphrase + Wallet
```

**Used for:**
- Placing/canceling orders
- Fetching open orders
- Getting orderbook data
- Balance/allowance queries

### Polymarket Gamma API

```
Host: https://gamma-api.polymarket.com
Auth: None (public)
```

**Used for:**
- Fetching active markets
- Market metadata
- Price data

### Polymarket Data API

```
Host: https://data-api.polymarket.com
Auth: None (public)
```

**Used for:**
- Accurate position data
- Portfolio value
- Historical trades

---

## Server & Dashboard

### Express Server (`src/server/`)

```
Port: 3000 (configurable via PORT env)

Routes:
  GET  /              → Backtest dashboard
  GET  /live          → Live trading dashboard
  GET  /api/...       → Backtest API
  GET  /api/live/...  → Live trading API
```

### API Endpoints

**Backtest API** (`/api`):
- `GET /stats` — Database statistics
- `GET /config` — Current configuration
- `POST /backtest` — Run backtest
- `GET /runs` — List backtest runs
- `GET /runs/:id/trades` — Get trades for run

**Live Trading API** (`/api/live`):
- `GET /status` — Bot status
- `POST /start` — Start bot
- `POST /stop` — Stop bot
- `GET /positions` — Current positions
- `GET /trades` — Trade history

---

## NPM Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `tsx watch src/server/index.ts` | Dashboard with hot reload |
| `start` | `tsx src/server/index.ts` | Production dashboard |
| `backtest` | `tsx src/backtest/run.ts` | Run backtest |
| `sweep` | `tsx src/backtest/sweep.ts` | Parameter optimization |
| `ingest` | `tsx src/ingestion/run.ts` | Fetch market data |
| `trade` | `tsx src/trading/run.ts` | Paper trading mode |
| `trade:live` | `tsx src/trading/run.ts --live` | **Real orders!** |
| `analyze` | `tsx src/trading/analyze.ts` | Trade analysis |

---

## Environment Variables

```bash
# Required for live trading
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_PROXY_ADDRESS=0x...

# Optional
PORT=3000
```

---

## Data Flow

### Backtest Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Kaggle     │────▶│  Ingestion  │────▶│  SQLite DB  │
│  Dataset    │     │  Pipeline   │     │  (markets,  │
└─────────────┘     └─────────────┘     │   prices)   │
                                        └──────┬──────┘
                                               │
                    ┌─────────────┐     ┌──────▼──────┐
                    │  Dashboard  │◀────│  Backtest   │
                    │  (HTML/JS)  │     │  Engine     │
                    └─────────────┘     └─────────────┘
```

### Live Trading Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Gamma API  │────▶│   Scanner   │────▶│  Strategy   │
│  (markets)  │     │  (filter)   │     │  (qualify)  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
┌─────────────┐     ┌─────────────┐     ┌──────▼──────┐
│  CLOB API   │◀────│  Executor   │◀────│    Bot      │
│  (orders)   │     │  (safety)   │     │ (orchestrate)│
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────▼──────┐
                    │ State Mgr   │
                    │ (reconcile) │
                    └─────────────┘
```

---

## Key Design Decisions

### 1. Single Strategy Focus
The system is built specifically for the Late-Stage Convergence strategy. This keeps complexity low and allows deep optimization of one approach.

### 2. Source of Truth
Polymarket APIs are always the source of truth. Local state is a cache that must be regularly reconciled.

### 3. Safety First
Multiple layers of safety checks prevent common trading errors:
- Idempotency keys prevent duplicate orders
- Position/exposure limits are enforced
- State verification before every action
- Kill switch for emergencies

### 4. Classification vs Filtering
Markets are classified (volatility, category) for analysis purposes, not filtered. This allows tracking performance across different market types.

### 5. Paper Mode by Default
The bot runs in paper mode unless explicitly started with `--live`. This prevents accidental real trades.

### 6. Synchronous Database
Using `better-sqlite3` (synchronous) instead of async drivers for simpler code and atomic transactions.

---

## Error Handling

**Bot-level:**
- Errors are logged with timestamps
- Last 100 errors kept in memory
- Scan/state check cycles continue on error
- Kill switch on critical failures

**Order-level:**
- All order attempts recorded in `order_tracking`
- Failed orders logged with error messages
- Pending orders tracked to prevent duplicates

**Reconciliation:**
- Discrepancies logged on startup
- Local DB updated to match Polymarket
- Manual review flagged for unknown states

---

## Future Considerations

1. **Multi-strategy support** — Abstract strategy interface
2. **Position management** — Exit price optimization
3. **Alert system** — Webhook/email notifications
4. **Historical analysis** — More granular backtesting
5. **Rate limiting** — API call management
6. **Monitoring** — Prometheus metrics, health checks

