# Polymarket Trading Bot — Strategy 1: Late-Stage Convergence

## 1. Purpose & Philosophy

### Goal
Build a **functional trading bot for Polymarket** that exploits **systematic mispricings** rather than trying to predict outcomes better than the market.

The bot should:
- Use **simple, rule-based logic**
- Rely on **market mechanics and human behavior**
- Be **actionable** (i.e. capable of taking positions)
- Be testable via historical backtesting
- Avoid complex math, ML, or forecasting models

### Explicit Non-Goals
- Beating the market via superior prediction
- Complex probabilistic or pricing models (e.g. full Black–Scholes adaptation)
- Heavy machine learning or optimization
- Outcome-level forecasting

This project focuses on **mechanical edges**, not intelligence.

---

## 2. Core Insight

In prediction markets:

- Prices *should* converge toward **0 or 1** as expiration approaches
- In practice, convergence is often **slow or incomplete**
- This lag is caused by:
  - Liquidity decay
  - Capital constraints
  - Risk aversion (capped upside, absolute downside)
  - Trader disengagement near expiry
  - Resolution anxiety (even when resolution is clear)

**Non-convergence near expiration is often systematic, not rational.**

This creates exploitable drift.

---

## 3. Chosen Strategy: Late-Stage Convergence Harvesting

### Strategy Name
**Late-Stage Convergence Harvesting**

### High-Level Idea
As time to resolution approaches, markets with clear outcomes and clean resolution criteria tend to drift toward certainty (0 or 1).  
Markets frequently lag this convergence, creating positive expectancy trades.

---

## 4. Strategy 1 — Formal Definition

### Market Eligibility Criteria
A market is eligible if:

- Binary YES/NO market
- Resolution criteria are **clear and unambiguous**
- Resolution date is known and imminent
- No major new information is expected before resolution
- No adversarial oracle or legal interpretation risk

### Entry Conditions (YES side example)
Enter a **YES** position when all are true:

- Time to resolution: **3–14 days**
- Current YES price: **0.75 – 0.90**
- Price has been stable or slowly drifting (not spiking)
- Market category is known to converge cleanly (e.g. sports results, scheduled events)

(Symmetric logic applies for NO positions at 0.10–0.25)

### Exit Conditions
Exit the position when **any** of the following occurs:

- Price reaches ≥ **0.95**
- Resolution occurs
- A predefined stop-loss is hit (optional, conservative)

### Position Sizing
- Fixed fractional sizing per trade
- No martingale
- Assume occasional full loss is acceptable and priced in

---

## 5. Why This Strategy Works

This strategy exploits:

- Time decay of uncertainty
- Trader disengagement near expiry
- Asymmetric payoff psychology (low upside, full downside)
- Liquidity cliffs in late-stage markets

It does **not** depend on:
- Being correct about the outcome
- Superior information
- Complex modeling

It works **on average**, across many similar markets.

---

## 6. What to Avoid (Hard Constraints)

Do NOT trade this strategy if:

- Resolution wording is vague
- Legal / regulatory / oracle disputes are possible
- The market is novel with no precedent
- The event can flip suddenly (e.g. resignations, surprise announcements)

Discipline here matters more than cleverness.

---

## 7. Data Requirements

For each market, collect:

- Market ID
- Market category / type
- Resolution timestamp
- YES and NO price history (timestamped)
- Volume / liquidity metrics (if available)
- Final resolution outcome

Historical data is required for backtesting.

---

## 8. Backtesting Plan (Minimal)

### Core Metrics
Track:
- Entry time
- Entry price
- Exit time
- Exit price
- PnL
- Max drawdown
- Time held

### Key Questions to Answer
- Does price drift toward 1 (or 0) as time → 0?
- Is drift monotonic or noisy?
- What entry window has best expectancy?
- What price bands work best?

Avoid curve fitting. Prefer robustness.

---

## 9. Bot Architecture (Conceptual)

### Components
1. **Market Scanner**
   - Filters eligible markets based on rules

2. **Signal Generator**
   - Applies Strategy 1 entry/exit logic

3. **Backtester**
   - Replays historical data against rules

4. **Execution Layer** (later)
   - Places trades via Polymarket API

5. **Risk Manager**
   - Enforces sizing and exposure limits

---

## 10. Immediate Next Steps (Concrete)

1. Implement historical data ingestion
2. Classify markets by type
3. Compute time-to-resolution for all markets
4. Plot price vs time-to-resolution
5. Validate convergence behavior visually
6. Encode entry/exit rules
7. Run first backtest
8. Evaluate expectancy and variance

Only after this should automation or execution be added.

---

## 11. Guiding Principle

If a rule cannot be stated in **one sentence**, it is too complex.

This project succeeds by being **boring, repeatable, and mechanical**.

Complexity comes later — if at all.