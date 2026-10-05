# INOCULENS ASSETS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build split-static local-first portfolio tracker with locked ECB rates and switchable average/FIFO P&L.

**Architecture:** Vanilla static (index.html + styles.css + app.js), no build. Store persists to localStorage + versioned JSON file; Fx locks ECB rates at trade date via Frankfurter; Ledger computes both cost bases from one trade list; Prices fetches CoinGecko with manual fallback; Ui renders positions/trades/settings.

**Tech Stack:** Vanilla HTML/CSS/JS (ES2020), Google Fonts (Inter + Space Grotesk), CoinGecko free markets API, Frankfurter ECB proxy API, browser localStorage, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-inoculens-assets-design.md`

## Global Constraints

- No backend, no keys, no analytics, no cookies.
- No build step; works from `file://` and any static host.
- `localStorage` key is exactly `inoculens.v1`.
- Export shape is exactly `{app:"inoculens-assets", version:1, exportedAt, settings, trades}`.
- Failed import must reject entirely and leave existing data untouched.
- `fxLock` is frozen at entry; later FX moves never rewrite history.
- Oversell is blocked; no negative holdings.
- Future trade dates are blocked.
- CSP `connect-src` limited to CoinGecko + Frankfurter (+ Google Fonts).
- Title is exactly `INOCULENS ASSETS — Local-First Portfolio Tracker`.

## Review Focus

- Weekend/holiday trade date with no ECB fixing → expect previous available fixing used and `interpolated:true` shown.
- Unknown ticker (e.g. `XYZ123`) with no CoinGecko mapping → expect manual price prompt, entry never blocked.
- Sell qty exceeding held qty → expect blocked with max-sellable message, no state change.
- Corrupt import file (bad JSON / wrong version / missing trades[]) → expect full reject with reason, existing data untouched.
- USDC buy normalized to EUR → expect `USDC→USD 1.0 + ECB USD/EUR(date)` path shown, native + normalized both visible.

---

### Task 1: Shell + SEO + glassy theme

**Files:**
- Create: `assets/index.html` (overwrite empty file)
- Create: `assets/styles.css`
- Create: `assets/manifest.json`
- Create: `assets/robots.txt`
- Create: `assets/sitemap.xml`

**Interfaces:**
- Consumes: nothing.
- Produces: DOM mounts `#positions`, `#trades`, `#settings`, `#banner`; `app.js` loaded via `<script src="./app.js" defer>`; CSS tokens `--bg --glass --border --text --muted --accent`.

- [ ] **Step 1: Write shell with failing load check**

In `assets/index.html`, include head (title exact, meta description, canonical placeholder, OG/Twitter, JSON-LD SoftwareApplication `INOCULENS ASSETS`, fonts preconnect + Inter/Space Grotesk `display=swap`, link `styles.css`), body with `header.brand`, `div#banner`, `main` with `section#positions`, `section#trades`, `aside#settings`, script tag; verify `styles.css` link 404s until Task 1 code exists.

- [ ] **Step 2: Verify shell renders mounts**

Run: `python3 -m http.server 8000 --directory assets` then open `http://localhost:8000/` and confirm header + empty mounts render (unstyled is OK at this step).
Expected: PASS (mounts present).

- [ ] **Step 3: Implement `styles.css` glassy YouTube-dark**

Tokens: `--bg:#0f0f0f; --glass:rgba(255,255,255,.06); --border:rgba(255,255,255,.08); --text:#f1f1f1; --muted:#aaa; --accent:#ff0033`. Glass cards `backdrop-filter:blur(14px)`, responsive tables→cards under 720px, focus rings, banner/error styles. No framework.

- [ ] **Step 4: Add `manifest.json`, `robots.txt`, `sitemap.xml`**

manifest name `INOCULENS ASSETS`, display standalone, theme `#0f0f0f`. robots allow `/`. sitemap single URL placeholder (domain filled at deploy; must not break `file://`).

- [ ] **Step 5: Commit**

```bash
git add assets/index.html assets/styles.css assets/manifest.json assets/robots.txt assets/sitemap.xml
git commit -m "feat: add INOCULENS ASSETS shell, SEO head, and glassy theme"
```

### Task 2: Store (localStorage + export/import)

**Files:**
- Create: `assets/app.js` (skeleton + Store section)
- Test: `assets/tests.html` (create harness skeleton; grows in later tasks)

**Interfaces:**
- Consumes: DOM mounts from Task 1 (not needed for pure functions).
- Produces:
  - `loadState() -> State`
  - `saveState(s: State) -> void`
  - `exportState(s: State) -> string` (JSON string of `{app,version,exportedAt,settings,trades}`)
  - `importState(json: string) -> State` (throws `Error(reason)` on bad shape; never partial)

`State = { settings:{mainCurrency:string, costMethod:'average'|'fifo'}, trades: Trade[], priceOverrides: Record<string,number> }`

- [ ] **Step 1: Write failing Store tests in `assets/tests.html`**

```js
// round-trip
let s = {settings:{mainCurrency:'EUR',costMethod:'average'}, trades:[], priceOverrides:{}};
saveState(s); assert(JSON.stringify(loadState())===JSON.stringify(s));
// export shape
let out = JSON.parse(exportState(s)); assert(out.app==="inoculens-assets" && out.version===1 && Array.isArray(out.trades));
// corrupt import rejects
let before = loadState();
try { importState('not-json'); assert(false); } catch(e){ assert(true); }
assert(JSON.stringify(loadState())===JSON.stringify(before));
try { importState(JSON.stringify({app:'x',version:99})); assert(false); } catch(e){ assert(true); }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: serve `assets/` and open `http://localhost:8000/tests.html`.
Expected: FAIL (`saveState is not defined` / red list).

- [ ] **Step 3: Implement Store in `assets/app.js`**

`loadState` reads `localStorage['inoculens.v1']`, falls back to `{settings:{mainCurrency:'EUR',costMethod:'average'},trades:[],priceOverrides:{}}`. `saveState` writes. `exportState` stringifies versioned envelope. `importState` parses, validates `app/version/trades[]/settings`, throws on any mismatch, writes + returns on success only. Expose on `window.Inoculens` for tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: reopen `http://localhost:8000/tests.html`.
Expected: PASS (Store section green).

- [ ] **Step 5: Commit**

```bash
git add assets/app.js assets/tests.html
git commit -m "feat: add localStorage store with versioned export/import"
```

### Task 3: Fx (ECB lock via Frankfurter)

**Files:**
- Modify: `assets/app.js` (Fx section)
- Modify: `assets/tests.html` (Fx tests)

**Interfaces:**
- Consumes: `loadState/saveState` (for nothing yet; Fx is pure + fetch).
- Produces:
  - `fetchEcbRate(date:'YYYY-MM-DD', from:string, to:string) -> Promise<{rate:number, interpolated:boolean, source:string}>`
  - `stableToUsd(ccy:string) -> boolean` (true for USDC/USDT/DAI)
  - `normalizeToMain(total:number, fee:number, rate:number) -> number`

- [ ] **Step 1: Write failing Fx tests**

```js
assert(normalizeToMain(10, 0, 0.92) === 9.2);
// forward-fill unit (pure helper): given {date, ratesByDate} returns previous fixing + interpolated flag
let r = pickRate({'2026-09-30':0.9}, '2026-10-01'); assert(r.rate===0.9 && r.interpolated===true);
// stablecoin path flag
assert(stableToUsd('USDC')===true && stableToUsd('EUR')===false);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: open `http://localhost:8000/tests.html`.
Expected: FAIL (`normalizeToMain is not defined`).

- [ ] **Step 3: Implement Fx in `assets/app.js`**

`fetchEcbRate` GETs `https://api.frankfurter.app/{date}?from={from}&to={to}`; if `from===to` return 1. Stablecoins map to USD first (`USDC→USD 1.0`), then ECB USD→main. On missing-date response, walk back up to 5 days, set `interpolated:true`, `source:'ECB-'+actualDate`. Retry once, then throw `Error('fx-unavailable')` so UI can ask manual rate. Same-currency returns `{rate:1, interpolated:false, source:'1:1'}` without network.

- [ ] **Step 4: Run tests to verify they pass**

Run: reopen tests page (network tests mocked/stubbed; pure asserts green).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/app.js assets/tests.html
git commit -m "feat: add ECB FX lock with forward-fill and stablecoin path"
```

### Task 4: Ledger (normalize + average + FIFO)

**Files:**
- Modify: `assets/app.js` (Ledger section)
- Modify: `assets/tests.html` (Ledger tests)

**Interfaces:**
- Consumes: `normalizeToMain` from Task 3.
- Produces:
  - `normalizeTrade(t: Trade) -> {totalMain:number, feeMain:number}`
  - `computeAverage(trades: Trade[]) -> Map<symbol,{qty,cost,avgEntry,realized}>`
  - `computeFifo(trades: Trade[]) -> Map<symbol,{qty,avgEntry,realized,lots:[{openDate,closeDate,qty,proceeds,cost,gain,holdingDays}]}>`
  - `computePositions(trades, live:Record<string,number>, method) -> [{symbol,qtyHeld,avgEntry,livePrice,marketValue,unrealized,realized,totalPL,returnPct}]`
  - `validateTrade(t, heldQty:number) -> string|null` (error message or null)

- [ ] **Step 1: Write failing Ledger tests**

```js
// spec example: buy 1@50k, buy 1@70k (EUR, rate 1), sell 1@80k
let tr = [
 {id:'a',type:'buy',symbol:'BTC',qty:1,total:50000,currency:'EUR',date:'2026-01-01',fee:0,feeCurrency:'EUR',fxLock:{pair:'EUR/EUR',rate:1,source:'1:1'}},
 {id:'b',type:'buy',symbol:'BTC',qty:1,total:70000,currency:'EUR',date:'2026-02-01',fee:0,feeCurrency:'EUR',fxLock:{pair:'EUR/EUR',rate:1,source:'1:1'}},
 {id:'c',type:'sell',symbol:'BTC',qty:1,total:80000,currency:'EUR',date:'2026-03-01',fee:0,feeCurrency:'EUR',fxLock:{pair:'EUR/EUR',rate:1,source:'1:1'}},
];
let avg = computeAverage(tr).get('BTC'); assert(avg.avgEntry===60000 && avg.realized===20000 && avg.qty===1);
let fifo = computeFifo(tr).get('BTC'); assert(fifo.realized===30000 && fifo.lots[0].gain===30000);
assert(validateTrade({type:'sell',symbol:'BTC',qty:5}, 1) !== null); // oversell
assert(validateTrade({type:'sell',symbol:'BTC',qty:1}, 1) === null);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: open `http://localhost:8000/tests.html`.
Expected: FAIL (`computeAverage is not defined`).

- [ ] **Step 3: Implement Ledger in `assets/app.js`**

`normalizeTrade` = `(total+fee-in-trade-ccy)*fxLock.rate` (fee converted at same lock; if `feeCurrency!==currency`, fee converted via its own lock if present else same rate and flagged). `computeAverage` accumulates cost/qty buys, proportional relief on sells. `computeFifo` keeps queue of buy lots, consumes oldest, records per-lot gain + holdingDays. `validateTrade` blocks qty<=0, total<0, future date, oversell. No DOM here.

- [ ] **Step 4: Run tests to verify they pass**

Run: reopen tests page.
Expected: PASS (avg 60k / realized 20k avg / 30k FIFO).

- [ ] **Step 5: Commit**

```bash
git add assets/app.js assets/tests.html
git commit -m "feat: add ledger with average-cost and FIFO engines"
```

### Task 5: Prices (CoinGecko + manual + main-currency)

**Files:**
- Modify: `assets/app.js` (Prices section)
- Modify: `assets/tests.html` (Prices tests: pure mapping/cache only, no network asserts)

**Interfaces:**
- Consumes: live `State.priceOverrides` (read internally, no extra param) + `State.settings.mainCurrency` as default `vs`.
- Produces:
  - `SYMBOL_MAP: Record<string,string>` (BTC→bitcoin, ETH→ethereum, SOL→solana, …)
  - `fetchLivePrice(symbol:string, vs:string) -> Promise<number|null>` (reads current `loadState().priceOverrides` first; 60s cache; override wins)
  - `refreshAllPrices(symbols:string[], vs:string) -> Promise<Record<string,number|null>>`

- [ ] **Step 1: Write failing Prices tests**

```js
assert(SYMBOL_MAP['BTC']==='bitcoin');
// override short-circuits network
priceOverrides['BTC']=67000; assert(await fetchLivePrice('BTC','EUR')===67000); delete priceOverrides['BTC'];
assert((await fetchLivePrice('XYZ123','EUR'))===null); // unknown → null, never throws
```

- [ ] **Step 2: Run tests to verify they fail**

Run: open `http://localhost:8000/tests.html`.
Expected: FAIL (`SYMBOL_MAP is not defined`).

- [ ] **Step 3: Implement Prices in `assets/app.js`**

In-memory `priceCache {key:{price,at}}` 60s. Override wins. Unknown symbol (no map entry) returns null immediately. Otherwise GET `https://api.coingecko.com/api/v3/simple/price?ids={id}&vs_currencies={vs}`; on error/429 return last cached or null, never throw to UI. `refreshAllPrices` dedupes symbols, uppercases.

- [ ] **Step 4: Run tests to verify they pass**

Run: reopen tests page.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/app.js assets/tests.html
git commit -m "feat: add CoinGecko live prices with manual fallback"
```

### Task 6: UI (positions + trades + settings + import/export)

**Files:**
- Modify: `assets/app.js` (Ui section + boot/wiring)
- Modify: `assets/index.html` (only if mounts missing attributes; no restyle)

**Interfaces:**
- Consumes: all prior interfaces (`loadState/saveState/exportState/importState`, `fetchEcbRate`, `computePositions/validateTrade`, `refreshAllPrices`).
- Produces: boot `init()` on DOMContentLoaded; behaviors: add/edit/delete trade, main-currency select, cost-method toggle, download/upload buttons, manual price/rate fields, banner errors.

- [ ] **Step 1: Write UI checklist test (DOM assertions in tests.html)**

```js
// helpers defined in tests.html: seedForUi() loads the Task-4 fixture via saveState();
// setCostMethod(m) = saveState({...loadState(), settings:{...loadState().settings, costMethod:m}}) + render();
// uiShows(s) = document.body.textContent.includes(s)
// given seeded state with 1 EUR buy, positions table shows 1 row with avg + market value columns
seedForUi(); init(); assert(document.querySelector('#positions tbody tr')!==null);
// cost toggle switches realized number (avg 20k vs fifo 30k from Task 4 fixture)
setCostMethod('fifo'); assert(uiShows('30')); setCostMethod('average'); assert(uiShows('20'));
```

(Keep DOM test minimal; full matrix is manual below.)

- [ ] **Step 2: Run checklist to verify it fails**

Run: open `http://localhost:8000/tests.html`.
Expected: FAIL (`init is not defined` / no rows).

- [ ] **Step 3: Implement Ui + wiring**

Trade form fields: side buy/sell, symbol, qty, total, currency select (EUR/USD/GBP/CHF/USDC/USDT + custom), date (default today), fee + feeCurrency, note, manual-rate + manual-price collapsibles. On submit: resolve rate (`fetchEcbRate` or manual), build `fxLock`, `validateTrade`, push, `saveState`, `recompute+render`. Positions table columns: symbol, qty, avgEntry, live, value, unrealized, realized, total, return%. Trades table: date, side, symbol, qty, native total, normalized total + rate badge, fee, note, delete. Settings drawer: mainCurrency select (EUR/USD/GBP/CHF), cost toggle, override editor, download (Blob `inoculens-YYYYMMDD.json`), upload (`<input type=file>` → `importState`), clear-with-confirm, demo-trade + clear. Banner for price/fx failures. `recompute→render` after every mutation; main-currency switch re-fetches prices only.

- [ ] **Step 4: Manual verify + UI checklist green**

Run: serve, open app, do: EUR buy → USDC buy (check lock badge) → sell → toggle avg/FIFO → switch main to USD → download → clear → upload → identical. Reopen tests page.
Expected: PASS + manual matrix done.

- [ ] **Step 5: Commit**

```bash
git add assets/app.js assets/index.html
git commit -m "feat: add portfolio UI with positions, trades, and settings"
```

### Task 7: Polish + verify (a11y, SEO, tests green)

**Files:**
- Modify: any of `assets/index.html`, `assets/styles.css`, `assets/app.js` (small fixes only)
- Test: `assets/tests.html` (final)

**Interfaces:**
- Consumes: everything.
- Produces: all `tests.html` green, no console errors, Lighthouse-friendly static.

- [ ] **Step 1: Run full suite and record failures**

Run: open `http://localhost:8000/tests.html` + `http://localhost:8000/` with console open; test `file://` open too.
Expected: list any red/failures (ideally none).

- [ ] **Step 2: Fix small issues only (no new features)**

Labels/alt, focus states, number formatting (`Intl.NumberFormat` per mainCurrency), empty states, CSP meta `connect-src 'self' api.coingecko.com api.frankfurter.app fonts.googleapis.com fonts.gstatic.com`.

- [ ] **Step 3: Final verification**

Run: both pages, download→clear→upload identity, mobile 390px check.
Expected: PASS all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: polish a11y, formatting, and verification"
```
