# INOCULENS ASSETS — Accounts (multi-account per ticker) — Design Spec

Date: 2026-10-06
Status: Approved design (approach A, sections 1-3)
Approach: A — stacked account cards, one positions block per account

## 1. Intent & Success Criteria

**Outcome:** Portfolios are organized into accounts. Each account binds one
ticker (many accounts may share a ticker, e.g. BTC cold wallet vs BTC
trading stack). Trades belong to an account; the trade form no longer asks
for a symbol per trade — it uses the account (default or card context).
The app displays all accounts stacked, each with its own positions block,
subtotals, and trade list.

**Constraints:**
- Greenfield: app unlaunched, no migration of live data. New storage key,
  tolerant v1 file import only.
- Ledger engine (`computeAverage`/`computeFifo`/`computePositions`) unchanged:
  per-account P&L runs on filtered trades.
- Vanilla static, no build, no backend. Existing test suite must stay green.

**Success:**
- Create account (name + ticker) → it appears as a card; set default.
- Add trade from topbar (default account) or card (that account); symbol
  locked to the account ticker.
- Each card shows correct P&L for its trades; grand totals equal the
  all-trades computation.
- Export → clear → import restores accounts, trades, default identical.

## 2. Data Model & Store

Account: `{ id, name, ticker, createdAt }`. Name defaults to ticker,
renameable. Identity is `id`; duplicate names allowed.

Trade gains required `accountId`.

Settings gains `defaultAccountId` (topbar/global Add-trade target;
falls back to first account; none → Add-trade shows a hint).

`localStorage` key: `inoculens.v2`.
Export envelope: `{app:"inoculens-assets", version:2, exportedAt,
settings, accounts, trades}`.
Import v2: full validate (settings, accounts[], trades[] with accountId
referencing a listed account), atomic reject otherwise.
Import v1 (legacy file): trades grouped into auto-created per-symbol
accounts; settings mapped; default = first account. ~10 lines, no legacy
runtime paths.

First run (no accounts): empty state with "Create your first account"
(name + ticker inputs). Demo button creates `Demo BTC` account + sample
trade. Old `defaultState()` demo trade (account-less) removed.

## 3. UI Layout (account cards)

Top bar: grand totals (all accounts) left; main-currency select,
Average/FIFO segmented toggle (unchanged, global); `+ Add trade`
(default account), new `+ Account` button, Settings gear.

Overview summary cards stay as grand totals across all accounts.

Per-account card (stacked vertically):
- Header: name (inline rename), ticker + live price, subtotal line
  (value · P&L), per-card `+ Trade`, rename, delete buttons.
- Body: positions row (qty, avg entry, live, value, unrealized, realized,
  total, return — one row; `—` semantics for unknown live preserved),
  then that account's trades (date, side, qty, native/normalized totals +
  rate badge, fee, note, delete). Empty account → muted line, no tables.
- Delete account: confirm; blocked while trades remain (message to delete
  or move trades first — no move UI in this spec; delete trades first).

Trade dialog: first field is Account select (defaults to default account,
or the originating card's account; user-changeable). Symbol shown locked
(read-only) to the account ticker. Manual rate/price, fee, note unchanged.
Submit validates (incl. oversell within that account's holdings) and closes.

Global trades table removed; trades live inside their account card only.
Settings dialog keeps overrides/backup/data (no currency/cost — those are
topbar). Banner, CSP, fonts, theme unchanged.

## 4. Testing & Edge Cases

tests.html Accounts section:
- Filtered per-account `computePositions` equals today's symbol-grouped
  math; sum of per-account realized + known unrealized equals all-trades
  run (grand totals identity).
- v1 import → per-symbol accounts; v2 export → clear → import identity
  (accounts, trades, default).
- Import rejects trade with missing/unknown `accountId`, existing data
  untouched.
- DOM: dialog opens with account preselected + symbol locked; per-card
  trade list renders; last-trade delete empties gracefully; unknown live
  keeps `—` (no fictitious loss) per card.
- Default fallback: deleting default → first remaining; none → Add-trade
  hint, no crash. Empty state offers create + demo only.

## 5. Out of Scope (YAGNI)

Moving trades between accounts, account archiving/hiding, per-account cost
method or currency, account-level notes/tags, closed-account filtering,
charting.
