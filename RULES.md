# ⚠️ MANDATORY RULES FOR AI ASSISTANTS ⚠️

**This file contains critical rules that ALL AI assistants MUST follow when working on this codebase.**

---

## Rule 1: NO PARAMETER CHANGES WITHOUT APPROVAL

**NEVER change any trading parameters without explicit user approval.**

### Before changing ANY parameter:
1. State exactly what you want to change
2. Explain why
3. **WAIT for explicit user approval**
4. Only then make the change

---

## Rule 2: VERIFY BOT STATE MATCHES REALITY

---

## Rule 3: NO "QUICK FIXES" OR WORKAROUNDS

If something isn't working:
1. Stop and diagnose the root cause
2. Explain the issue to the user
3. Propose a proper fix
4. **Do NOT implement hacky workarounds**

Previous "quick fixes" caused:
- Duplicate orders
- False resolution detection
- Incorrect P&L tracking
- State desync

---


## History of Issues

- Bot placed duplicate orders due to fake market IDs
- Bot incorrectly marked active positions as "resolved"
- State tracking got out of sync with Polymarket reality
- Position counting failed due to status field mismatch

**Always be cautious with this codebase.**

