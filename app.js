'use strict';
/* INOCULENS ASSETS — app.js
 * Vanilla JS, no framework, no build step. Organized in sections:
 * Store, Prices, Fx, Ledger, Ui. Tasks 3-6 append their sections below.
 */

// === Store ===
// Local-first persistence: localStorage + versioned export/import.
// Key: exactly 'inoculens.v1'. Export envelope: exactly
// {app:"inoculens-assets", version:1, exportedAt, settings, trades, priceOverrides}.
// Failed imports throw Error(reason) and leave stored data untouched.

var STORAGE_KEY = 'inoculens.v1';
var APP_ID = 'inoculens-assets';
var STORE_VERSION = 1;

function defaultState() {
  return {
    settings: { mainCurrency: 'EUR', costMethod: 'average' },
    trades: [],
    priceOverrides: {}
  };
}

function isValidSettings(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.mainCurrency === 'string' && v.mainCurrency.length > 0 &&
    (v.costMethod === 'average' || v.costMethod === 'fifo');
}

function loadState() {
  var fallback = defaultState();
  var raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return fallback;
  }
  if (raw === null || raw === undefined) return fallback;
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  return {
    settings: isValidSettings(parsed.settings)
      ? { mainCurrency: parsed.settings.mainCurrency, costMethod: parsed.settings.costMethod }
      : fallback.settings,
    trades: Array.isArray(parsed.trades) ? parsed.trades : [],
    priceOverrides: (parsed.priceOverrides && typeof parsed.priceOverrides === 'object' && !Array.isArray(parsed.priceOverrides))
      ? parsed.priceOverrides
      : {}
  };
}

function saveState(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    throw new Error('storage-unavailable');
  }
}

function isValidImportTrade(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (t.type !== 'buy' && t.type !== 'sell') return false;
  if (typeof t.symbol !== 'string' || t.symbol.trim().length === 0) return false;
  var qty = Number(t.qty);
  if (!isFinite(qty) || qty <= 0) return false;
  var total = Number(t.total);
  if (!isFinite(total) || total < 0) return false;
  if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return false;
  if (t.fee !== undefined && t.fee !== null) {
    var fee = Number(t.fee);
    if (!isFinite(fee) || fee < 0) return false;
  }
  return true;
}

function exportState(s) {
  var envelope = {
    app: APP_ID,
    version: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    settings: s.settings,
    trades: s.trades,
    priceOverrides: (s && s.priceOverrides && typeof s.priceOverrides === 'object') ? s.priceOverrides : {}
  };
  return JSON.stringify(envelope);
}

function importState(json) {
  var data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error('import failed: invalid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('import failed: top-level object expected');
  }
  if (data.app !== APP_ID) {
    throw new Error('import failed: unknown app');
  }
  if (data.version !== STORE_VERSION) {
    throw new Error('import failed: unsupported version');
  }
  if (!isValidSettings(data.settings)) {
    throw new Error('import failed: invalid settings');
  }
  if (!Array.isArray(data.trades)) {
    throw new Error('import failed: trades must be an array');
  }
  for (var ti = 0; ti < data.trades.length; ti++) {
    if (!isValidImportTrade(data.trades[ti])) {
      throw new Error('import failed: invalid trade at index ' + ti);
    }
  }
  var priceOverrides = {};
  if (data.priceOverrides !== undefined) {
    if (!data.priceOverrides || typeof data.priceOverrides !== 'object' || Array.isArray(data.priceOverrides)) {
      throw new Error('import failed: invalid priceOverrides');
    }
    var keys = Object.keys(data.priceOverrides);
    for (var i = 0; i < keys.length; i++) {
      var v = data.priceOverrides[keys[i]];
      if (typeof v !== 'number' || !isFinite(v)) {
        throw new Error('import failed: invalid priceOverrides');
      }
    }
    priceOverrides = data.priceOverrides;
  }
  // All validation passed — only now replace stored state (never partial).
  var next = {
    settings: { mainCurrency: data.settings.mainCurrency, costMethod: data.settings.costMethod },
    trades: data.trades,
    priceOverrides: priceOverrides
  };
  saveState(next);
  return next;
}

// Expose pure functions for tests.html via window.Inoculens.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.loadState = loadState;
  window.Inoculens.saveState = saveState;
  window.Inoculens.exportState = exportState;
  window.Inoculens.importState = importState;
  window.Inoculens.defaultState = defaultState;
}

// === Fx ===
// ECB historical FX via the Frankfurter proxy (https://api.frankfurter.app).
// fetchEcbRate(date, from, to) locks the rate at trade date with forward-fill:
// a weekend/holiday gap walks back up to FX_MAX_LOOKBACK_DAYS and returns
// interpolated:true with source:'ECB-'+actualFixingDate. Stablecoins
// (USDC/USDT/DAI) are treated as 1:1 USD, then converted via ECB USD->main.
// Each HTTP attempt is retried once on network failure; if the rate still
// cannot be locked, fetchEcbRate throws Error('fx-unavailable') so the UI
// can ask for a manual rate.

var FX_STABLES = ['USDC', 'USDT', 'DAI'];
var FX_MAX_LOOKBACK_DAYS = 5;
var FX_BASE_URL = 'https://api.frankfurter.app';

function stableToUsd(ccy) {
  if (typeof ccy !== 'string') return false;
  return FX_STABLES.indexOf(ccy.toUpperCase()) !== -1;
}

function normalizeToMain(total, fee, rate) {
  return (Number(total) + Number(fee)) * Number(rate);
}

function fxShiftDate(dateStr, deltaDays) {
  var parts = String(dateStr).split('-');
  var t = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  t += deltaDays * 86400000;
  var d = new Date(t);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// Pure forward-fill helper: newest fixing at or before `date` within the
// lookback window, or null when no fixing is available (caller throws
// Error('fx-unavailable') in that case).
function pickRate(ratesByDate, date) {
  for (var back = 0; back <= FX_MAX_LOOKBACK_DAYS; back++) {
    var d = fxShiftDate(date, -back);
    if (ratesByDate && Object.prototype.hasOwnProperty.call(ratesByDate, d)) {
      var rate = Number(ratesByDate[d]);
      if (isFinite(rate)) {
        return { rate: rate, interpolated: back > 0, date: d, source: 'ECB-' + d };
      }
    }
  }
  return null;
}

function fxFetchOnce(url, fetchImpl) {
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch);
  return f(url).then(function (res) {
    if (!res.ok) {
      var err = new Error('fx-http-' + res.status);
      err.fxStatus = res.status;
      throw err;
    }
    return res.json();
  });
}

function fxFetchWithRetry(url, fetchImpl) {
  return fxFetchOnce(url, fetchImpl).catch(function (e) {
    if (e && e.fxStatus === 404) throw e; // missing fixing: no point retrying the same date
    return fxFetchOnce(url, fetchImpl); // retry once; a second failure propagates to the caller
  });
}

function fetchEcbRate(date, from, to) {
  var f = (typeof from === 'string') ? from.toUpperCase() : from;
  var t = (typeof to === 'string') ? to.toUpperCase() : to;
  var effFrom = stableToUsd(f) ? 'USD' : f; // USDC->USD 1.0, then ECB USD->main
  var effTo = stableToUsd(t) ? 'USD' : t;
  if (effFrom === effTo) {
    return Promise.resolve({ rate: 1, interpolated: false, source: '1:1' });
  }
  // Hermetic async: capture window.fetch once per operation so concurrent
  // tests.html stubs (or later restores) cannot clobber retry/walkBack fetches.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch;
  function attempt(d, back) {
    var url = FX_BASE_URL + '/' + d +
      '?from=' + encodeURIComponent(effFrom) + '&to=' + encodeURIComponent(effTo);
    function walkBack() {
      if (back >= FX_MAX_LOOKBACK_DAYS) throw new Error('fx-unavailable');
      return attempt(fxShiftDate(d, -1), back + 1);
    }
    return fxFetchWithRetry(url, capturedFetch).then(
      function (data) {
        var rate = data && data.rates && data.rates[effTo];
        if (typeof rate === 'number' && isFinite(rate)) {
          return { rate: rate, interpolated: back > 0, source: 'ECB-' + d };
        }
        return walkBack(); // 200 but no fixing for this date: previous close
      },
      function (e) {
        if (e && e.fxStatus === 404) return walkBack(); // ECB holiday/weekend gap
        throw new Error('fx-unavailable'); // network failure after retry
      }
    );
  }
  return attempt(date, 0);
}

// Expose Fx on window.Inoculens for tests.html, Ledger (Task 4), Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.fetchEcbRate = fetchEcbRate;
  window.Inoculens.stableToUsd = stableToUsd;
  window.Inoculens.normalizeToMain = normalizeToMain;
  window.Inoculens.pickRate = pickRate;
}

// === Ledger ===
// Pure cost-basis engine: normalizeTrade + average-cost + FIFO + positions +
// validation. No DOM, no network, no storage. All main-currency conversion
// uses the trade's frozen fxLock.rate (Task 3). Read by Ui (Task 6) via
// computePositions / validateTrade.
//
// Fee assumption (documented): when feeCurrency !== currency and the trade
// carries no feeFxLock, the fee is converted at the trade's own fxLock.rate
// and the result is flagged feeFxAssumedSameRate:true. When feeFxLock
// ({rate}) is present it is used instead and no flag is set.

function ledgerFxRate(lock) {
  var r = lock ? Number(lock.rate) : NaN;
  return (isFinite(r) && r > 0) ? r : 1;
}

function normalizeTrade(t) {
  t = t || {};
  var rate = ledgerFxRate(t.fxLock);
  var totalMain = Number(t.total || 0) * rate;
  var fee = Number(t.fee || 0);
  var feeRate = rate;
  var feeFxAssumedSameRate = false;
  var ccy = typeof t.currency === 'string' ? t.currency.toUpperCase() : null;
  var feeCcy = typeof t.feeCurrency === 'string' ? t.feeCurrency.toUpperCase() : null;
  if (ccy && feeCcy && feeCcy !== ccy) {
    if (t.feeFxLock && isFinite(Number(t.feeFxLock.rate)) && Number(t.feeFxLock.rate) > 0) {
      feeRate = Number(t.feeFxLock.rate);
    } else if (fee !== 0) {
      feeFxAssumedSameRate = true; // same-lock fallback, flagged
    }
  }
  var out = { totalMain: totalMain, feeMain: fee * feeRate };
  if (feeFxAssumedSameRate) out.feeFxAssumedSameRate = true;
  return out;
}

function ledgerSortByDate(trades) {
  return (trades || []).slice().sort(function (a, b) {
    var da = (a && typeof a.date === 'string') ? a.date : '';
    var db = (b && typeof b.date === 'string') ? b.date : '';
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });
}

function ledgerHoldingDays(openDate, closeDate) {
  function toUtc(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
    var p = d.slice(0, 10).split('-');
    var t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isFinite(t) ? t : null;
  }
  var a = toUtc(openDate);
  var b = toUtc(closeDate);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / 86400000);
}

function computeAverage(trades) {
  var bySym = new Map();
  var list = ledgerSortByDate(trades);
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var sym = String(t.symbol || '');
    if (!sym) continue;
    if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
    var e = bySym.get(sym);
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) continue;
    var n = normalizeTrade(t);
    if (t.type === 'buy') {
      e.qty += qty;
      e.cost += n.totalMain + n.feeMain;
    } else if (t.type === 'sell') {
      if (e.qty <= 0) continue; // no inventory: ignore, never negative
      var sellQty = Math.min(qty, e.qty);
      var avg = e.qty > 0 ? e.cost / e.qty : 0;
      var proceeds = n.totalMain - n.feeMain;
      if (qty > e.qty && qty > 0) proceeds = proceeds * (sellQty / qty);
      e.realized += proceeds - avg * sellQty;
      e.cost -= avg * sellQty;
      e.qty -= sellQty;
      if (e.qty === 0) e.cost = 0; // kill float dust
    }
  }
  bySym.forEach(function (e) {
    e.avgEntry = e.qty > 0 ? e.cost / e.qty : 0;
  });
  return bySym;
}

function computeFifo(trades) {
  var queues = new Map(); // sym -> [{qty, unitCost, date}]
  var acc = new Map(); // sym -> {realized, lots}
  var list = ledgerSortByDate(trades);
  function state(sym) {
    if (!acc.has(sym)) acc.set(sym, { realized: 0, lots: [] });
    if (!queues.has(sym)) queues.set(sym, []);
    return acc.get(sym);
  }
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var sym = String(t.symbol || '');
    if (!sym) continue;
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) continue;
    var n = normalizeTrade(t);
    var st = state(sym);
    var q = queues.get(sym);
    if (t.type === 'buy') {
      q.push({ qty: qty, unitCost: (n.totalMain + n.feeMain) / qty, date: t.date });
    } else if (t.type === 'sell') {
      if (q.length === 0) continue; // no inventory: ignore, never negative
      var proceedsTotal = n.totalMain - n.feeMain;
      var unitProceeds = qty > 0 ? proceedsTotal / qty : 0;
      var sellQty = Math.min(qty, q.reduce(function (s, l) { return s + l.qty; }, 0));
      // Scale proceeds when the sell is clamped (oversell ignored, no negative).
      if (qty > sellQty && qty > 0) unitProceeds = (proceedsTotal * (sellQty / qty)) / (sellQty || 1);
      var left = sellQty;
      while (left > 0 && q.length > 0) {
        var lot = q[0];
        var take = Math.min(lot.qty, left);
        var proceeds = take * unitProceeds;
        var cost = take * lot.unitCost;
        st.lots.push({
          openDate: lot.date,
          closeDate: t.date,
          qty: take,
          proceeds: proceeds,
          cost: cost,
          gain: proceeds - cost,
          holdingDays: ledgerHoldingDays(lot.date, t.date)
        });
        st.realized += proceeds - cost;
        lot.qty -= take;
        left -= take;
        if (lot.qty <= 0) q.shift();
      }
    }
  }
  var out = new Map();
  acc.forEach(function (st, sym) {
    var q = queues.get(sym) || [];
    var qty = 0;
    var cost = 0;
    for (var k = 0; k < q.length; k++) { qty += q[k].qty; cost += q[k].qty * q[k].unitCost; }
    out.set(sym, {
      qty: qty,
      avgEntry: qty > 0 ? cost / qty : 0,
      realized: st.realized,
      lots: st.lots
    });
  });
  // Symbols with buys only are in queues but maybe not acc; ensure presence.
  queues.forEach(function (q, sym) {
    if (out.has(sym)) return;
    var qty = 0;
    var cost = 0;
    for (var k = 0; k < q.length; k++) { qty += q[k].qty; cost += q[k].qty * q[k].unitCost; }
    out.set(sym, { qty: qty, avgEntry: qty > 0 ? cost / qty : 0, realized: 0, lots: [] });
  });
  return out;
}

function computePositions(trades, live, method) {
  var engine = method === 'fifo' ? computeFifo(trades) : computeAverage(trades);
  var buyCost = {}; // sym -> lifetime buy cost (denominator for returnPct)
  (trades || []).forEach(function (t) {
    if (!t || t.type !== 'buy') return;
    var sym = String(t.symbol || '');
    if (!sym) return;
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) return;
    var n = normalizeTrade(t);
    buyCost[sym] = (buyCost[sym] || 0) + n.totalMain + n.feeMain;
  });
  var rows = [];
  engine.forEach(function (v, sym) {
    var lp = live ? Number(live[sym]) : NaN;
    var livePrice = isFinite(lp) ? lp : 0;
    var qtyHeld = v.qty || 0;
    var avgEntry = v.avgEntry || 0;
    var marketValue = qtyHeld * livePrice;
    var unrealized = marketValue - avgEntry * qtyHeld;
    var realized = v.realized || 0;
    var totalPL = unrealized + realized;
    var denom = buyCost[sym] || 0;
    rows.push({
      symbol: sym,
      qtyHeld: qtyHeld,
      avgEntry: avgEntry,
      livePrice: livePrice,
      marketValue: marketValue,
      unrealized: unrealized,
      realized: realized,
      totalPL: totalPL,
      returnPct: denom > 0 ? (totalPL / denom) * 100 : 0
    });
  });
  rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  return rows;
}

function validateTrade(t, heldQty) {
  t = t || {};
  var qty = Number(t.qty);
  if (!isFinite(qty) || qty <= 0) return 'qty must be > 0';
  if (t.total !== undefined && t.total !== null) {
    var total = Number(t.total);
    if (!isFinite(total) || total < 0) return 'total must be >= 0';
  }
  if (t.fee !== undefined && t.fee !== null) {
    var fee = Number(t.fee);
    if (!isFinite(fee) || fee < 0) return 'fee must be >= 0';
  }
  if (t.type !== undefined && t.type !== 'buy' && t.type !== 'sell') {
    return 'type must be buy or sell';
  }
  if (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) {
    var now = new Date();
    var m = now.getMonth() + 1;
    var d = now.getDate();
    var today = now.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
    if (t.date.slice(0, 10) > today) return 'date cannot be in the future';
  }
  if (t.type === 'sell' && typeof heldQty === 'number' && isFinite(heldQty)) {
    if (qty > heldQty) return 'oversell: max sellable is ' + heldQty;
  }
  return null;
}

// Expose Ledger on window.Inoculens for tests.html and Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.normalizeTrade = normalizeTrade;
  window.Inoculens.computeAverage = computeAverage;
  window.Inoculens.computeFifo = computeFifo;
  window.Inoculens.computePositions = computePositions;
  window.Inoculens.validateTrade = validateTrade;
}

// === Prices ===
// Live crypto prices via CoinGecko simple/price with manual fallback.
// Resolution order per symbol: (1) manual override from live
// loadState().priceOverrides (wins, no network), (2) CoinGecko
// simple/price for mapped symbols with a 60s in-memory cache,
// (3) null for unknown tickers or failed fetches (last cached price
// is returned when available). Never throws to the UI — failures
// resolve to cached-or-null. Read by Ui (Task 6) via refreshAllPrices.

var SYMBOL_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  XLM: 'stellar',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  TRX: 'tron',
  NEAR: 'near',
  ARB: 'arbitrum',
  OP: 'optimism',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai'
};

var PRICE_CACHE_TTL_MS = 60000;
var priceCache = {}; // key "SYM:VS" (uppercased) -> {price, at}

function priceCacheKey(symbol, vs) {
  return String(symbol).toUpperCase() + ':' + String(vs).toUpperCase();
}

function priceOverrideFor(symbol) {
  var sym = String(symbol).toUpperCase();
  var ov = null;
  try {
    var st = loadState();
    ov = st ? st.priceOverrides : null;
  } catch (e) {
    ov = null;
  }
  if (!ov || typeof ov !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(ov, sym)) {
    var v = Number(ov[sym]);
    if (isFinite(v)) return v;
  }
  // Tolerate differently-cased keys without touching stored data.
  var keys = Object.keys(ov);
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).toUpperCase() === sym) {
      var w = Number(ov[keys[i]]);
      if (isFinite(w)) return w;
    }
  }
  return null;
}

function priceDefaultVs(vs) {
  if (typeof vs === 'string' && vs.length > 0) return vs;
  try {
    var st = loadState();
    if (st && st.settings && typeof st.settings.mainCurrency === 'string' && st.settings.mainCurrency.length > 0) {
      return st.settings.mainCurrency;
    }
  } catch (e) { /* fall through */ }
  return 'EUR';
}

function fetchLivePrice(symbol, vs) {
  var sym = String(symbol || '').toUpperCase();
  var cur = priceDefaultVs(vs);
  var curLow = String(cur).toLowerCase();
  // (1) Manual override wins — no network.
  var override = priceOverrideFor(sym);
  if (override !== null) return Promise.resolve(override);
  // (3a) Unknown ticker: null immediately, never throws, no network.
  var id = SYMBOL_MAP[sym];
  if (!id) return Promise.resolve(null);
  // (2) Fresh cache (60s) avoids network.
  var key = priceCacheKey(sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  if (cached && (now - cached.at) < PRICE_CACHE_TTL_MS && isFinite(Number(cached.price))) {
    return Promise.resolve(Number(cached.price));
  }
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(id) + '&vs_currencies=' + encodeURIComponent(curLow);
  // Hermetic async: capture fetch at call time so a later stub restore
  // cannot clobber this operation's continuation.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch;
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var p = data && data[id] && data[id][curLow];
    p = Number(p);
    if (isFinite(p)) {
      priceCache[key] = { price: p, at: Date.now() };
      return p;
    }
    if (cached && isFinite(Number(cached.price))) return Number(cached.price);
    return null;
  }).then(null, function () {
    // Network error / 429 / bad payload: last cached or null, never throw.
    if (cached && isFinite(Number(cached.price))) return Number(cached.price);
    return null;
  });
}

function refreshAllPrices(symbols, vs) {
  var cur = priceDefaultVs(vs);
  var seen = {};
  var uniq = [];
  (symbols || []).forEach(function (s) {
    var sym = String(s || '').toUpperCase();
    if (!sym || seen[sym]) return;
    seen[sym] = true;
    uniq.push(sym);
  });
  var out = {};
  var jobs = uniq.map(function (sym) {
    return fetchLivePrice(sym, cur).then(function (p) {
      out[sym] = p;
    });
  });
  return Promise.all(jobs).then(function () { return out; });
}

// Expose Prices on window.Inoculens for tests.html and Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.SYMBOL_MAP = SYMBOL_MAP;
  window.Inoculens.PRICE_CACHE_TTL_MS = PRICE_CACHE_TTL_MS;
  window.Inoculens.priceCache = priceCache;
  window.Inoculens.fetchLivePrice = fetchLivePrice;
  window.Inoculens.refreshAllPrices = refreshAllPrices;
}

// === Ui ===
// DOM boot + render loop (Task 6; top-bar + dialogs redesign). Binds the
// sticky top bar, positions/trades tables, trade + settings dialogs,
// import/export and banner to Store/Fx/Ledger/Prices. Render loop: every
// mutation does saveState -> recompute (computePositions) -> render(). A
// main-currency switch re-fetches live prices only; frozen trade fxLocks
// are never rewritten. Money is formatted with Intl.NumberFormat in the
// current mainCurrency. Every positions/trades <td> carries a data-label
// so the mobile card layout (styles.css) can label rows. init() boots on
// DOMContentLoaded; render()/refreshPrices() are the recompute+render
// entry points (also used by tests.html).

var uiBooted = false;
var livePrices = {}; // SYM (uppercased) -> number|null, latest known live price
var moneyFmtCache = {};

function todayStr() {
  // Local calendar date (user-facing default + date max), matching the
  // local-based download filename. Pure FX calendar math (fxShiftDate,
  // ledgerHoldingDays) intentionally stays on UTC date arithmetic.
  var n = new Date();
  var m = n.getMonth() + 1;
  var d = n.getDate();
  return n.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

function uid() {
  return 't' + Date.now().toString(36) + Math.floor(Math.random() * 0xffffff).toString(36);
}

function uiVal(id, fb) {
  var el = document.getElementById(id);
  return el ? el.value : fb;
}

function uiSetVal(id, v) {
  var el = document.getElementById(id);
  if (el) el.value = v;
}

function moneyFmt(currency) {
  var code = String(currency || 'EUR').toUpperCase();
  if (!moneyFmtCache[code]) {
    try {
      moneyFmtCache[code] = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    } catch (e) {
      moneyFmtCache[code] = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' });
    }
  }
  return moneyFmtCache[code];
}

function fmtMoney(n, currency) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  try {
    return moneyFmt(currency).format(v);
  } catch (e) {
    return String(Math.round(v * 100) / 100);
  }
}

function fmtQty(n) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(v);
}

function fmtPct(n) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  return (Math.round(v * 100) / 100) + '%';
}

function showBanner(msg) {
  var b = document.getElementById('banner');
  if (!b) return;
  b.textContent = String(msg);
  b.classList.add('error');
  b.hidden = false;
}

function clearBanner() {
  var b = document.getElementById('banner');
  if (!b) return;
  b.textContent = '';
  b.classList.remove('error');
  b.hidden = true;
}

// Guarded persistence for UI mutations: saveState throws
// Error('storage-unavailable') on private-mode/quota failure. Every UI
// mutation must go through here so no storage failure bricks the UI
// uncaught — the failure surfaces via the existing banner path.
function saveStateGuarded(s) {
  try {
    saveState(s);
    return true;
  } catch (e) {
    if (e && e.message === 'storage-unavailable') {
      showBanner('Storage unavailable — change was not saved (private mode or quota exceeded).');
      return false;
    }
    throw e;
  }
}

function heldQtyFor(trades, symbol) {
  var sym = String(symbol || '').toUpperCase();
  var held = 0;
  (trades || []).forEach(function (t) {
    if (!t || String(t.symbol || '').toUpperCase() !== sym) return;
    var q = Number(t.qty);
    if (!isFinite(q) || q <= 0) return;
    if (t.type === 'buy') held += q;
    else if (t.type === 'sell') held -= q;
  });
  return held < 0 ? 0 : held;
}

function uniqueSymbols(trades) {
  var seen = {};
  var out = [];
  (trades || []).forEach(function (t) {
    var s = String((t && t.symbol) || '').toUpperCase();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}

// --- Positions table ---
// Columns: symbol, qty, avgEntry, live, value, unrealized, realized, total, return%.
var POSITION_COLUMNS = ['Symbol', 'Qty', 'Avg entry', 'Live', 'Value', 'Unrealized', 'Realized', 'Total P&L', 'Return %'];

function posCell(label, text, num, raw) {
  var td = document.createElement('td');
  td.setAttribute('data-label', label);
  if (num) td.className = 'num';
  td.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    td.setAttribute('data-value', String(Number(raw)));
  }
  return td;
}

function buildPositions() {
  var host = document.getElementById('positions');
  if (!host || host.querySelector('table')) return;
  var table = document.createElement('table');
  var thead = document.createElement('thead');
  var hr = document.createElement('tr');
  POSITION_COLUMNS.forEach(function (c, i) {
    var th = document.createElement('th');
    th.textContent = c;
    if (i > 0) th.className = 'num';
    th.setAttribute('scope', 'col');
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  table.appendChild(document.createElement('tbody'));
  host.appendChild(table);
}

// --- Summary cards + top-bar totals ---
// Portfolio-level rollups rendered into the sticky top bar (#tb-totals)
// and the overview cards (#summary-cards): value, unrealized, realized,
// return vs remaining cost basis.

function renderSummaryCards(st, rows) {
  var main = st.settings.mainCurrency;
  var mv = 0;
  var un = 0;
  var rz = 0;
  var pl = 0;
  rows.forEach(function (p) { mv += p.marketValue; un += p.unrealized; rz += p.realized; pl += p.totalPL; });
  var tb = document.getElementById('tb-totals');
  if (tb) {
    tb.textContent = rows.length
      ? ('Portfolio value ' + fmtMoney(mv, main) + ' · total P&L ' + fmtMoney(pl, main) +
        ' (' + st.settings.costMethod + ', ' + main + ')')
      : '';
  }
  var host = document.getElementById('summary-cards');
  if (!host) return;
  host.innerHTML = '';
  if (!rows.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No positions yet — add your first trade.';
    host.appendChild(p);
    return;
  }
  var cost = mv - un;
  var ret = cost > 0 ? (pl / cost) * 100 : 0;
  [['Value', fmtMoney(mv, main), mv],
   ['Unrealized', fmtMoney(un, main), un],
   ['Realized', fmtMoney(rz, main), rz],
   ['Return', fmtPct(ret), ret]].forEach(function (c) {
    var d = document.createElement('div');
    d.className = 'card';
    var l = document.createElement('span');
    l.className = 'card-label';
    l.textContent = c[0];
    var v = document.createElement('span');
    v.className = 'card-value num';
    v.textContent = c[1];
    v.setAttribute('data-value', String(c[2]));
    d.appendChild(l);
    d.appendChild(v);
    host.appendChild(d);
  });
}

function renderPositions(st) {
  var host = document.getElementById('positions');
  if (!host) return;
  var tbody = host.querySelector('tbody');
  if (!tbody) return;
  var main = st.settings.mainCurrency;
  var rows = computePositions(st.trades, livePrices, st.settings.costMethod);
  tbody.innerHTML = '';
  if (!rows.length) {
    var er = document.createElement('tr');
    var ec = document.createElement('td');
    ec.colSpan = POSITION_COLUMNS.length;
    ec.className = 'muted';
    ec.setAttribute('data-label', 'Info');
    ec.textContent = 'No positions yet — add your first trade below.';
    er.appendChild(ec);
    tbody.appendChild(er);
  }
  rows.forEach(function (p) {
    var tr = document.createElement('tr');
    var symLabel = (p.qtyHeld === 0) ? (p.symbol + ' (Closed)') : p.symbol;
    tr.appendChild(posCell('Symbol', symLabel, false, null));
    tr.appendChild(posCell('Qty', fmtQty(p.qtyHeld), true, p.qtyHeld));
    tr.appendChild(posCell('Avg entry', fmtMoney(p.avgEntry, main), true, p.avgEntry));
    tr.appendChild(posCell('Live',
      (isFinite(p.livePrice) && p.livePrice > 0) ? fmtMoney(p.livePrice, main) : '—', true, p.livePrice));
    tr.appendChild(posCell('Value', fmtMoney(p.marketValue, main), true, p.marketValue));
    tr.appendChild(posCell('Unrealized', fmtMoney(p.unrealized, main), true, p.unrealized));
    tr.appendChild(posCell('Realized', fmtMoney(p.realized, main), true, p.realized));
    tr.appendChild(posCell('Total P&L', fmtMoney(p.totalPL, main), true, p.totalPL));
    tr.appendChild(posCell('Return %', fmtPct(p.returnPct), true, p.returnPct));
    tbody.appendChild(tr);
  });
  renderSummaryCards(st, rows);
}

// --- Trades table ---
// Columns: date, side, symbol, qty, native total, normalized total + rate
// badge, fee, note, delete.
var TRADE_COLUMNS = ['Date', 'Side', 'Symbol', 'Qty', 'Native total', 'Normalized total', 'Fee', 'Note', ''];

function fxBadgeText(t) {
  var lock = t ? t.fxLock : null;
  if (!lock) return 'legacy rate';
  var r = Number(lock.rate);
  var bits = String(lock.source || 'rate');
  if (isFinite(r)) bits += ' @ ' + r;
  if (lock.interpolated) bits += ' (prev close)';
  if (t && stableToUsd(t.currency)) {
    return String(t.currency).toUpperCase() + '→USD 1.0 · ' + bits;
  }
  return bits;
}

function buildTradesTable() {
  var host = document.getElementById('trades');
  if (!host || host.querySelector('table')) return;
  var table = document.createElement('table');
  var thead = document.createElement('thead');
  var hr = document.createElement('tr');
  TRADE_COLUMNS.forEach(function (c, i) {
    var th = document.createElement('th');
    th.textContent = c;
    if (i >= 3 && i <= 6) th.className = 'num';
    th.setAttribute('scope', 'col');
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  var tbody = document.createElement('tbody');
  tbody.addEventListener('click', function (e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-del]') : null;
    if (!btn) return;
    deleteTrade(btn.getAttribute('data-del'));
  });
  table.appendChild(tbody);
  host.appendChild(table);
}

function renderTrades(st) {
  var host = document.getElementById('trades');
  if (!host) return;
  var tbody = host.querySelector('table tbody');
  if (!tbody) return;
  var main = st.settings.mainCurrency;
  var list = ledgerSortByDate(st.trades).reverse(); // newest first
  tbody.innerHTML = '';
  if (!list.length) {
    var er = document.createElement('tr');
    var ec = document.createElement('td');
    ec.colSpan = TRADE_COLUMNS.length;
    ec.className = 'muted';
    ec.setAttribute('data-label', 'Info');
    ec.textContent = 'No trades yet.';
    er.appendChild(ec);
    tbody.appendChild(er);
    return;
  }
  list.forEach(function (t) {
    var n = normalizeTrade(t);
    var tr = document.createElement('tr');
    tr.appendChild(posCell('Date', t.date || '', false, null));
    tr.appendChild(posCell('Side', t.type === 'sell' ? 'Sell' : 'Buy', false, null));
    tr.appendChild(posCell('Symbol', String(t.symbol || '').toUpperCase(), false, null));
    tr.appendChild(posCell('Qty', fmtQty(t.qty), true, t.qty));
    tr.appendChild(posCell('Native total',
      fmtQty(t.total) + ' ' + String(t.currency || '').toUpperCase(), true, t.total));
    var normTd = posCell('Normalized total', '', true, n.totalMain + n.feeMain);
    normTd.textContent = fmtMoney(n.totalMain + n.feeMain, main);
    var badge = document.createElement('small');
    badge.className = 'muted';
    badge.textContent = ' ' + fxBadgeText(t);
    normTd.appendChild(badge);
    tr.appendChild(normTd);
    var feeTxt = (Number(t.fee) > 0)
      ? (fmtQty(t.fee) + ' ' + String(t.feeCurrency || t.currency || '').toUpperCase())
      : '—';
    if (n.feeFxAssumedSameRate) feeTxt += ' *';
    var feeTd = posCell('Fee', feeTxt, true, t.fee);
    if (n.feeFxAssumedSameRate) feeTd.title = 'Fee converted at the trade FX rate (*)';
    tr.appendChild(feeTd);
    tr.appendChild(posCell('Note', t.note ? String(t.note) : '—', false, null));
    var actTd = document.createElement('td');
    actTd.setAttribute('data-label', 'Action');
    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.setAttribute('data-del', t.id || '');
    del.setAttribute('aria-label', 'Delete trade ' + String(t.symbol || '') + ' ' + String(t.date || ''));
    actTd.appendChild(del);
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  });
}

function deleteTrade(id) {
  if (!id) return;
  var st = loadState();
  var kept = (st.trades || []).filter(function (t) { return !t || t.id !== id; });
  if (kept.length === (st.trades || []).length) return; // unknown id: no write
  st.trades = kept;
  if (!saveStateGuarded(st)) return;
  render(); // cached live prices stay; no refetch needed on delete
}

// --- Trade form ---
var TRADE_CCY_OPTIONS = ['EUR', 'USD', 'GBP', 'CHF', 'USDC', 'USDT', 'DAI'];

function ccyOptions(selected, includeCustom) {
  var base = TRADE_CCY_OPTIONS.map(function (c) {
    return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + '</option>';
  }).join('');
  if (includeCustom === false) return base; // e.g. fee select: no dead Other… option
  return base + '<option value="CUSTOM"' + (selected === 'CUSTOM' ? ' selected' : '') + '>Other…</option>';
}

function ensureCustomFeeOption(code) {
  var feeccy = document.getElementById('t-feeccy');
  if (!feeccy) return;
  var prev = feeccy.querySelector('[data-custom-fee]');
  if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
  if (typeof code === 'string' && /^[A-Z]{2,10}$/.test(code)) {
    var opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code;
    opt.setAttribute('data-custom-fee', '1');
    feeccy.appendChild(opt);
    feeccy.value = code;
  }
}

function buildTradeForm() {
  var host = document.getElementById('trade-dialog-body');
  if (!host || document.getElementById('trade-form')) return;
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<form id="trade-form">' +
    '<label for="t-side">Side</label>' +
    '<select id="t-side"><option value="buy">Buy</option><option value="sell">Sell</option></select>' +
    '<label for="t-symbol">Symbol</label>' +
    '<input id="t-symbol" autocomplete="off" spellcheck="false" placeholder="BTC">' +
    '<label for="t-qty">Quantity</label>' +
    '<input id="t-qty" inputmode="decimal" placeholder="1">' +
    '<label for="t-total">Total (native currency)</label>' +
    '<input id="t-total" inputmode="decimal" placeholder="50000">' +
    '<label for="t-currency">Currency</label>' +
    '<select id="t-currency">' + ccyOptions('EUR') + '</select>' +
    '<label for="t-custom-ccy" id="t-custom-ccy-label" hidden>Custom currency code</label>' +
    '<input id="t-custom-ccy" autocomplete="off" spellcheck="false" placeholder="Code, e.g. JPY" hidden>' +
    '<label for="t-date">Date</label>' +
    '<input id="t-date" type="date">' +
    '<label for="t-fee">Fee</label>' +
    '<input id="t-fee" inputmode="decimal" placeholder="0">' +
    '<label for="t-feeccy">Fee currency</label>' +
    '<select id="t-feeccy">' + ccyOptions('EUR', false) + '</select>' +
    '<label for="t-note">Note</label>' +
    '<input id="t-note" autocomplete="off" placeholder="optional">' +
    '<details><summary>Manual FX rate (fallback when ECB is unavailable)</summary>' +
    '<label for="t-manual-rate">Manual rate to main currency</label>' +
    '<input id="t-manual-rate" inputmode="decimal" placeholder="e.g. 0.92">' +
    '</details>' +
    '<details><summary>Manual live price (override)</summary>' +
    '<label for="t-manual-price">Manual live price in main currency</label>' +
    '<input id="t-manual-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '</details>' +
    '<p id="t-error" class="banner-error" role="alert" hidden></p>' +
    '<button class="primary" type="submit">Add trade</button>' +
    '</form>';
  host.appendChild(wrap);
  var form = document.getElementById('trade-form');
  form.addEventListener('submit', onTradeSubmit);
  var ccy = document.getElementById('t-currency');
  var custom = document.getElementById('t-custom-ccy');
  var feeccy = document.getElementById('t-feeccy');
  ccy.addEventListener('change', function () {
    var needCustom = (ccy.value === 'CUSTOM');
    custom.hidden = !needCustom;
    var clabel = document.getElementById('t-custom-ccy-label');
    if (clabel) clabel.hidden = !needCustom;
    if (!needCustom && feeccy) {
      ensureCustomFeeOption('');
      feeccy.value = ccy.value; // fee usually in trade currency
    } else {
      ensureCustomFeeOption(String(custom.value || '').trim().toUpperCase());
    }
  });
  custom.addEventListener('input', function () {
    if (ccy.value === 'CUSTOM') ensureCustomFeeOption(String(custom.value || '').trim().toUpperCase());
  });
}

function tradeFormError(msg) {
  var p = document.getElementById('t-error');
  if (!p) return;
  if (!msg) {
    p.textContent = '';
    p.hidden = true;
    return;
  }
  p.textContent = String(msg);
  p.hidden = false;
}

function onTradeSubmit(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  tradeFormError(null);
  var main = loadState().settings.mainCurrency;
  var side = uiVal('t-side', 'buy') === 'sell' ? 'sell' : 'buy';
  var symbol = uiVal('t-symbol', '').trim().toUpperCase();
  var qty = Number(uiVal('t-qty', ''));
  var total = Number(uiVal('t-total', ''));
  var ccySel = uiVal('t-currency', 'EUR');
  var currency = (ccySel === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySel).toUpperCase());
  var date = uiVal('t-date', '') || todayStr();
  var feeRaw = uiVal('t-fee', '').trim();
  var fee = (feeRaw === '') ? 0 : Number(feeRaw);
  var feeCcyRaw = uiVal('t-feeccy', '');
  var feeCurrency = feeCcyRaw ? String(feeCcyRaw).toUpperCase() : currency;
  if (!feeCurrency || feeCurrency === 'CUSTOM') feeCurrency = currency; // harden: CUSTOM literal never persists
  var note = uiVal('t-note', '').trim();
  var manualRateRaw = uiVal('t-manual-rate', '').trim();
  var manualPriceRaw = uiVal('t-manual-price', '').trim();
  if (!symbol) { tradeFormError('Symbol is required (e.g. BTC).'); return; }
  if (!/^[A-Z0-9._-]{1,12}$/.test(symbol)) { tradeFormError('Symbol looks invalid — letters/numbers, up to 12 chars.'); return; }
  if (!isFinite(qty) || qty <= 0) { tradeFormError('Quantity must be > 0.'); return; }
  if (!isFinite(total) || total < 0) { tradeFormError('Total must be >= 0.'); return; }
  if (!/^[A-Z]{2,10}$/.test(currency)) { tradeFormError('Currency code invalid — pick one or enter a 2–10 letter code.'); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { tradeFormError('Date must be YYYY-MM-DD.'); return; }
  if (!isFinite(fee) || fee < 0) { tradeFormError('Fee must be >= 0.'); return; }
  var manualRate = (manualRateRaw === '') ? null : Number(manualRateRaw);
  if (manualRate !== null && (!isFinite(manualRate) || manualRate <= 0)) { tradeFormError('Manual rate must be > 0.'); return; }
  var manualPrice = (manualPriceRaw === '') ? null : Number(manualPriceRaw);
  if (manualPrice !== null && (!isFinite(manualPrice) || manualPrice <= 0)) { tradeFormError('Manual price must be > 0.'); return; }
  var from = currency;
  // proceed() re-reads state so a slow ECB fetch cannot clobber newer writes.
  function proceed(lock) {
    var st = loadState();
    if (manualPrice !== null) {
      st.priceOverrides = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
      st.priceOverrides[symbol] = manualPrice;
    }
    var trade = {
      id: uid(),
      type: side,
      symbol: symbol,
      qty: qty,
      total: total,
      currency: from,
      date: date,
      fee: fee,
      feeCurrency: feeCurrency,
      note: note,
      fxLock: lock,
      createdAt: new Date().toISOString()
    };
    var err = validateTrade(trade, heldQtyFor(st.trades, symbol));
    if (err) { tradeFormError(err); return; }
    st.trades.push(trade);
    if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); return; }
    uiSetVal('t-qty', '');
    uiSetVal('t-total', '');
    uiSetVal('t-note', '');
    uiSetVal('t-manual-rate', '');
    uiSetVal('t-manual-price', '');
    var d = document.getElementById('t-date');
    if (d) d.value = todayStr();
    tradeFormError(null);
    refreshPrices(); // recompute + render when fresh prices land (renders sync too)
    render();
    closeDialog('trade-dialog');
  }
  if (from === String(main).toUpperCase()) {
    proceed({ pair: from + '/' + main, rate: 1, source: '1:1', interpolated: false });
    return;
  }
  if (manualRate !== null) {
    proceed({ pair: from + '/' + main, rate: manualRate, source: 'manual', interpolated: false });
    return;
  }
  fetchEcbRate(date, from, main).then(function (r) {
    proceed({ pair: from + '/' + main, rate: r.rate, source: r.source, interpolated: !!r.interpolated });
  }, function () {
    showBanner('FX rate unavailable for ' + from + ' → ' + main + ' on ' + date + ' — open “Manual FX rate” and enter a rate to save this trade.');
    tradeFormError('ECB rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.');
  });
}

// --- Top bar + dialogs ---
// Sticky top panel: totals, main currency, cost toggle, Add trade +
// Settings buttons. The trade form and settings live in modal <dialog>s
// so the page never scrolls through them. Dialog content keeps the same
// element IDs, so tests.html and existing handlers keep working.

var dialogOpener = null;

function openDialog(id) {
  var dlg = document.getElementById(id);
  if (!dlg) return;
  dialogOpener = document.activeElement;
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
  var first = dlg.querySelector('input, select, button:not([data-close])');
  if (first && typeof first.focus === 'function') {
    try { first.focus(); } catch (e) { /* ignore */ }
  }
}

function closeDialog(id) {
  var dlg = typeof id === 'string' ? document.getElementById(id) : id;
  if (!dlg) return;
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  else dlg.removeAttribute('open');
}

function returnFocus() {
  if (dialogOpener && typeof dialogOpener.focus === 'function') {
    try { dialogOpener.focus(); } catch (e) { /* ignore */ }
  }
  dialogOpener = null;
}

function wireDialog(id) {
  var dlg = document.getElementById(id);
  if (!dlg || dlg.getAttribute('data-wired')) return;
  dlg.setAttribute('data-wired', '1');
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) closeDialog(dlg); // backdrop click
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeDialog(dlg);
  });
  dlg.addEventListener('close', returnFocus);
}

function buildTopbar() {
  wireDialog('trade-dialog');
  wireDialog('settings-dialog');
  var main = document.getElementById('tb-main');
  if (main && !main.getAttribute('data-wired')) {
    main.setAttribute('data-wired', '1');
    main.addEventListener('change', function (e) {
      var st = loadState();
      st.settings.mainCurrency = e.target.value;
      if (!saveStateGuarded(st)) return;
      clearBanner();
      refreshPrices(); // re-fetch in the new currency; fxLocks untouched
    });
  }
  var methods = [['tb-avg', 'average'], ['tb-fifo', 'fifo']];
  methods.forEach(function (pair) {
    var b = document.getElementById(pair[0]);
    if (!b || b.getAttribute('data-wired')) return;
    b.setAttribute('data-wired', '1');
    b.addEventListener('click', function () {
      var st = loadState();
      st.settings.costMethod = pair[1];
      if (!saveStateGuarded(st)) return;
      render(); // no refetch: cost view needs no new prices
    });
  });
  var add = document.getElementById('tb-add');
  if (add && !add.getAttribute('data-wired')) {
    add.setAttribute('data-wired', '1');
    add.addEventListener('click', function () { openDialog('trade-dialog'); });
  }
  var gear = document.getElementById('tb-settings');
  if (gear && !gear.getAttribute('data-wired')) {
    gear.setAttribute('data-wired', '1');
    gear.addEventListener('click', function () { openDialog('settings-dialog'); });
  }
}

// --- Settings dialog ---
// Override editor, download/upload, clear-with-confirm, demo trade. Main
// currency + cost method live in the sticky top bar (buildTopbar). A
// main-currency switch re-fetches prices only; trade fxLocks are never
// rewritten.

function buildSettings() {
  var host = document.getElementById('settings-dialog-body');
  if (!host || document.getElementById('o-add')) return;
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<h3>Manual price overrides</h3>' +
    '<label for="o-symbol">Symbol</label>' +
    '<input id="o-symbol" autocomplete="off" spellcheck="false" placeholder="BTC">' +
    '<label for="o-price">Price (main currency)</label>' +
    '<input id="o-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '<button id="o-add" type="button">Save override</button>' +
    '<ul id="o-list"></ul>' +
    '<h3>Backup</h3>' +
    '<button id="s-download" type="button">Download backup</button>' +
    '<label for="s-upload">Restore from file</label>' +
    '<input id="s-upload" type="file" accept="application/json,.json">' +
    '<h3>Data</h3>' +
    '<button id="s-demo" type="button">Load demo trade</button>' +
    '<button id="s-clear" type="button">Clear all data</button>';
  host.appendChild(wrap);
  document.getElementById('o-add').addEventListener('click', function () {
    var sym = uiVal('o-symbol', '').trim().toUpperCase();
    var price = Number(uiVal('o-price', ''));
    if (!sym) { showBanner('Override needs a symbol (e.g. BTC).'); return; }
    if (!isFinite(price) || price <= 0) { showBanner('Override price must be > 0.'); return; }
    var st = loadState();
    st.priceOverrides = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    st.priceOverrides[sym] = price;
    if (!saveStateGuarded(st)) return;
    uiSetVal('o-symbol', '');
    uiSetVal('o-price', '');
    clearBanner();
    refreshPrices(); // override wins over network; recompute + render
  });
  document.getElementById('o-list').addEventListener('click', function (e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-override-del]') : null;
    if (!btn) return;
    var st = loadState();
    if (st.priceOverrides && Object.prototype.hasOwnProperty.call(st.priceOverrides, btn.getAttribute('data-override-del'))) {
      delete st.priceOverrides[btn.getAttribute('data-override-del')];
      if (!saveStateGuarded(st)) return;
    }
    refreshPrices();
  });
  document.getElementById('s-download').addEventListener('click', downloadBackup);
  document.getElementById('s-upload').addEventListener('change', function (e) {
    var input = e.target;
    var f = input && input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        importState(String(reader.result));
      } catch (err) {
        showBanner('Import failed: ' + (err && err.message ? err.message : err));
        input.value = '';
        return;
      }
      input.value = '';
      clearBanner();
      refreshPrices();
      closeDialog('settings-dialog');
    };
    reader.onerror = function () {
      showBanner('Import failed: could not read file.');
      input.value = '';
    };
    reader.readAsText(f);
  });
  document.getElementById('s-demo').addEventListener('click', addDemoTrade);
  document.getElementById('s-clear').addEventListener('click', clearAllData);
}

function syncTopbar(st) {
  var main = document.getElementById('tb-main');
  if (main) main.value = st.settings.mainCurrency;
  var avg = document.getElementById('tb-avg');
  var fifo = document.getElementById('tb-fifo');
  var isFifo = st.settings.costMethod === 'fifo';
  if (avg) avg.setAttribute('aria-pressed', isFifo ? 'false' : 'true');
  if (fifo) fifo.setAttribute('aria-pressed', isFifo ? 'true' : 'false');
  var list = document.getElementById('o-list');
  if (list) {
    list.innerHTML = '';
    var ov = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    Object.keys(ov).sort().forEach(function (sym) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      label.textContent = sym + ' — ' + fmtMoney(ov[sym], st.settings.mainCurrency) + ' ';
      li.appendChild(label);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Remove';
      rm.setAttribute('data-override-del', sym);
      rm.setAttribute('aria-label', 'Remove override for ' + sym);
      li.appendChild(rm);
      list.appendChild(li);
    });
  }
}

function downloadBackup() {
  var json = exportState(loadState());
  var blob = new Blob([json], { type: 'application/json' });
  var n = new Date();
  function p(x) { return (x < 10 ? '0' : '') + x; }
  var name = 'inoculens-' + n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate()) + '.json';
  var urls = window.URL || window.webkitURL;
  var url = urls.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { urls.revokeObjectURL(url); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

function addDemoTrade() {
  var st = loadState();
  if ((st.trades || []).length) {
    showBanner('Demo trade skipped — clear your data first to load it.');
    return;
  }
  var m = st.settings.mainCurrency;
  st.trades.push({
    id: uid(),
    type: 'buy',
    symbol: 'BTC',
    qty: 1,
    total: 50000,
    currency: m,
    date: '2026-01-01',
    fee: 0,
    feeCurrency: m,
    note: 'demo trade — remove with “Clear all data”',
    fxLock: { pair: m + '/' + m, rate: 1, source: '1:1', interpolated: false },
    createdAt: new Date().toISOString()
  });
  if (!saveStateGuarded(st)) return;
  clearBanner();
  refreshPrices();
}

function clearAllData() {
  if (typeof window.confirm === 'function' &&
      !window.confirm('Delete all trades, overrides and settings? This cannot be undone.')) {
    return;
  }
  livePrices = {};
  if (!saveStateGuarded(defaultState())) return;
  clearBanner();
  render();
}

// --- Render loop ---

function refreshPrices() {
  var st = loadState();
  var syms = uniqueSymbols(st.trades);
  if (!syms.length) {
    render();
    return Promise.resolve({});
  }
  return refreshAllPrices(syms, st.settings.mainCurrency).then(function (out) {
    Object.keys(out).forEach(function (k) { livePrices[k] = out[k]; });
    var missing = syms.filter(function (s) { return !isFinite(Number(livePrices[s])); });
    if (missing.length) {
      showBanner('Live price unavailable for ' + missing.join(', ') + ' — showing last/manual price.');
    } else {
      clearBanner();
    }
    render();
    return out;
  });
}

function render() {
  var st;
  try {
    st = loadState();
  } catch (e) {
    st = defaultState();
  }
  if (!st || !st.settings) st = defaultState();
  renderPositions(st);
  renderTrades(st);
  syncTopbar(st);
}

function init() {
  if (uiBooted) {
    render();
    return;
  }
  if (!document.getElementById('positions') || !document.getElementById('trades')) return;
  buildTopbar();
  buildPositions();
  buildTradeForm();
  buildTradesTable();
  buildSettings();
  var d = document.getElementById('t-date');
  if (d && !d.value) d.value = todayStr();
  uiBooted = true;
  render();
  refreshPrices();
}

// Expose Ui on window.Inoculens for tests.html; init/render are also bare
// globals (classic script top-level functions) for the DOM checklist.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.init = init;
  window.Inoculens.render = render;
  window.Inoculens.refreshPrices = refreshPrices;
  window.Inoculens.getLivePrices = function () { return livePrices; };
  window.Inoculens.fxBadgeText = fxBadgeText;
  window.Inoculens.TRADE_CCY_OPTIONS = TRADE_CCY_OPTIONS;
  window.Inoculens.ensureCustomFeeOption = ensureCustomFeeOption;
  window.Inoculens.saveStateGuarded = saveStateGuarded;
  window.Inoculens.isValidImportTrade = isValidImportTrade;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', init);
  }
}
