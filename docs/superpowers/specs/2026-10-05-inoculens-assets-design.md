# INOCULENS ASSETS — Local-First Portfolio Tracker — Design Spec

Date: 2026-10-05
Status: Approved design (approaches → sections 1-5 + styling amendment)
Approach: A — Split static + proxied ECB

## 1. Intent & Success Criteria

**Outcome:** Private, local-first portfolio tracker named INOCULENS ASSETS.
No server storage. User tracks buys/sells per asset ticker with auto-fetched
live price plus manual fallback, mixed fiat entry currencies normalized to a
main currency via ECB historical rates locked at trade date, average entry
and P&L auto-computed with switchable average-cost / FIFO views including
tax-level detail.

**Constraints:**
- Static only, no build step, no backend, no keys, no analytics/cookies.
- Repo: `assets/` currently empty `index.html` on `main`. Split static files.
- Free public APIs only (CoinGecko, Frankfurter/ECB proxy).
- User-approved fork-model sync: last imported file wins, no merge.

**Success:**
- Add buy (qty + total + currency + date + fee + note) → normalized to main,
  FX locked, positions + P&L update.
- Sell reduces holdings, realized P&L correct under both avg and FIFO.
- Main-currency switch re-renders without rewriting history.
- Download → clear → upload restores identical state.
- Works from `file://` and any static host.

## 2. Architecture & Files

- `assets/index.html` — shell + SEO head + app mount. Title:
  `INOCULENS ASSETS — Local-First Portfolio Tracker`. Meta description,
  canonical, OG/Twitter, JSON-LD `SoftwareApplication`, semantic
  header/main, single h1. Loads `./styles.css`, `./app.js` (defer).
- `assets/styles.css` — full theme (see §7).
- `assets/app.js` — vanilla JS modules in one file, namespaced:
  `Store`, `Prices`, `Fx`, `Ledger`, `Ui`. No framework, no router.
- `assets/sitemap.xml`, `assets/robots.txt`, `assets/manifest.json`.
- `assets/tests.html` — browser-native test harness (see §6).

**Persistence:**
- `localStorage` key `inoculens.v1` autosaves on every mutation.
- Download: versioned JSON
  `{app:"inoculens-assets", version:1, exportedAt, settings, trades[], fxLocks{}}`.
- Upload: parse → validate version/shape → full replace → recompute →
  render. Any validation failure rejects entirely with reason; existing
  data untouched.

## 3. Data Model & Cost-Basis Engine

Settings: `{ mainCurrency: 'EUR', costMethod: 'average'|'fifo' }`
plus `priceOverrides: { SYM: number }`.

Trade:
```
{id, type:'buy'|'sell', symbol, qty>0, total>=0, currency,
 date:'YYYY-MM-DD', fee>=0, feeCurrency, note,
 fxLock:{pair, rate, source:'ECB-YYYY-MM-DD'|'manual', interpolated:bool},
 createdAt}
```

- `totalMain = (total converted) + (fee converted)` via `fxLock.rate`.
  Both native and normalized values stored and shown
  (e.g. `10 USDC → 9.20 EUR @ 0.9200 ECB 2026-10-01`).
- FX fetched once at entry and frozen. Weekend/holiday ECB gap uses
  previous available fixing, flagged `interpolated:true`.
- Stablecoins (USDC/USDT/DAI) treated as 1:1 USD, then ECB USD→main
  on that date, shown explicitly.
- Future dates blocked. Pre-ECB/missing dates require manual rate.

Engine (both views computed from same list, UI toggle):
- Average: `avgEntry = totalCostMain/totalQty`. Sell reduces qty and cost
  proportionally. `realized = proceedsMain - avgEntry*sellQty`.
- FIFO: oldest buy lots consumed first. Tax table per closed lot:
  `{openDate, closeDate, qty, proceeds, cost, gain, holdingDays}`.
- Per symbol: `qtyHeld, avgEntry, livePriceMain, marketValue,
  unrealized, realized, totalPL, returnPct`.
- Oversell blocked with max-sellable message. No negative holdings.

## 4. Live Price + FX Flow

- Symbol uppercased. Resolve: (1) manual override, (2) CoinGecko
  `/coins/markets?vs_currency={main}&ids={mapped}` via local
  SYMBOL→ID map (BTC→bitcoin, ETH→ethereum…), 60s in-memory cache,
  (3) manual price prompt for unknown tickers. Entry never blocked.
- Main-currency change re-fetches live prices and re-renders;
  historical `fxLock`s untouched.
- FX: `https://api.frankfurter.app/{date}?from={tradeCcy}&to={mainCcy}`
  (ECB data, CORS-friendly). Retry once → manual rate flagged
  `source:'manual'`. Only outbound GETs; no user data sent.
- Render loop: mutation → save → recompute → render. Positions table
  (top), trades table (below), settings drawer (main currency,
  cost-method toggle, export/import, overrides).

## 5. Error Handling & Edge Cases

- Price fail → banner, last/manual price used.
- FX fail → manual rate field, trade flagged.
- Bad import → full reject with reason.
- Oversell / future date / invalid numbers → inline validation, no write.
- First run: single marked demo trade with one-click clear.
- CSP `connect-src` limited to CoinGecko + Frankfurter.
  No cookies/analytics. Fonts are the only third-party fetch (see §7).

## 6. Testing

- `assets/tests.html` imports pure functions
  (`normalizeTrade, averageCost, fifoLots, fxForwardFill`) and asserts:
  mixed-currency normalization, avg example
  (1 BTC @50k + 1 @70k → avg 60k; sell 1 @80k → realized 20k avg /
  30k FIFO), oversell rejection, forward-fill flag, old-file import.
- Manual checklist: EUR buy, USDC buy with ECB lock, sell, avg/FIFO
  toggle, main-currency switch, download → clear → upload identity.

## 7. Visual Design

Glassy YouTube-dark: bg `#0f0f0f`, glass cards
`rgba(255,255,255,.06)` + `backdrop-filter:blur(14px)`,
borders `rgba(255,255,255,.08)`, text `#f1f1f1`/`#aaa`,
accent `#ff0033`. Fonts: `Inter` (UI) + `Space Grotesk`
(display/numbers) via Google Fonts `display=swap` + system fallbacks.
Responsive tables → cards on mobile. Accessible labels, focus rings,
`<table>` semantics for positions/trades.

## 8. SEO Scope (honest)

Ship fully crawlable: semantic HTML, title/meta/OG/Twitter/JSON-LD,
`sitemap.xml`, `robots.txt`, fast static, accessible tables, copy
targeting "local-first portfolio tracker / private crypto P&L".
No guarantee of #1 or SaaS-category ranking — that requires hosted
domain, indexed content, backlinks. Copy positions as private
local-first tracker, not SaaS, to match intent and avoid contradiction.

## 9. Out of Scope (YAGNI)

Merge/sync, auth, backend, push alerts, multi-portfolio, charting
library, service worker/IndexedDB, i18n beyond currency formatting.
