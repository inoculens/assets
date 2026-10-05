'use strict';
/* INOCULENS ASSETS — app.js
 * Vanilla JS, no framework, no build step. Organized in sections:
 * Store, Prices, Fx, Ledger, Ui. Tasks 3-6 append their sections below.
 */

// === Store ===
// Local-first persistence: localStorage + versioned export/import.
// Key: exactly 'inoculens.v2' (v1 is never read at runtime; v1 files import
// via the grouping branch in importState). Export envelope: exactly
// {app:"inoculens-assets", version:2, exportedAt, settings, accounts, trades, priceOverrides}.
// Failed imports throw Error(reason) and leave stored data untouched.

var STORAGE_KEY = 'inoculens.v2';
var APP_ID = 'inoculens-assets';
var STORE_VERSION = 2;

function defaultState() {
  return {
    settings: { mainCurrency: 'EUR', costMethod: 'average', defaultAccountId: null },
    accounts: [],
    trades: [],
    priceOverrides: {}
  };
}

function isValidSettings(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.mainCurrency === 'string' && v.mainCurrency.length > 0 &&
    (v.costMethod === 'average' || v.costMethod === 'fifo');
}

function isValidAccount(a) {
  return !!a && typeof a === 'object' && !Array.isArray(a) &&
    typeof a.id === 'string' && a.id.length > 0 &&
    typeof a.name === 'string' &&
    typeof a.ticker === 'string' && a.ticker.length > 0;
}

function normalizeAccount(a) {
  return {
    id: a.id,
    name: a.name,
    ticker: a.ticker,
    createdAt: (typeof a.createdAt === 'string' && a.createdAt.length > 0)
      ? a.createdAt
      : new Date().toISOString()
  };
}

function normalizeDefaultAccountId(v) {
  if (v === null || v === undefined) return null;
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

function normalizeSettings(s, fallback) {
  var fb = fallback || { mainCurrency: 'EUR', costMethod: 'average', defaultAccountId: null };
  if (!isValidSettings(s)) {
    return { mainCurrency: fb.mainCurrency, costMethod: fb.costMethod, defaultAccountId: normalizeDefaultAccountId(fb.defaultAccountId) };
  }
  return {
    mainCurrency: s.mainCurrency,
    costMethod: s.costMethod,
    defaultAccountId: normalizeDefaultAccountId(s.defaultAccountId)
  };
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
    settings: normalizeSettings(parsed.settings, fallback.settings),
    accounts: Array.isArray(parsed.accounts)
      ? parsed.accounts.filter(isValidAccount).map(normalizeAccount)
      : [],
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

function isValidImportTrade(t, accountIds) {
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
  // Strict v2 membership: when the account roster is supplied, the trade
  // must name one of its accounts. Legacy v1 callers omit it (their trades
  // gain accountIds during grouping instead).
  if (accountIds !== undefined) {
    if (!Array.isArray(accountIds)) return false;
    if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
    if (accountIds.indexOf(t.accountId) === -1) return false;
  }
  return true;
}

function isValidPriceOverrides(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  var keys = Object.keys(v);
  for (var i = 0; i < keys.length; i++) {
    var n = Number(v[keys[i]]);
    if (typeof v[keys[i]] !== 'number' || !isFinite(n)) return false;
  }
  return true;
}

function exportState(s) {
  var st = s || {};
  var envelope = {
    app: APP_ID,
    version: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    settings: normalizeSettings(st.settings, defaultState().settings),
    accounts: Array.isArray(st.accounts)
      ? st.accounts.filter(isValidAccount).map(normalizeAccount)
      : [],
    trades: Array.isArray(st.trades) ? st.trades : [],
    priceOverrides: (st.priceOverrides && typeof st.priceOverrides === 'object' && !Array.isArray(st.priceOverrides))
      ? st.priceOverrides
      : {}
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
  if (data.version === 1) {
    return importStateV1(data);
  }
  if (data.version !== STORE_VERSION) {
    throw new Error('import failed: unsupported version');
  }
  if (!isValidSettings(data.settings)) {
    throw new Error('import failed: invalid settings');
  }
  if (!Array.isArray(data.accounts)) {
    throw new Error('import failed: accounts must be an array');
  }
  for (var ai = 0; ai < data.accounts.length; ai++) {
    if (!isValidAccount(data.accounts[ai])) {
      throw new Error('import failed: invalid account at index ' + ai);
    }
  }
  var accountIds = data.accounts.map(function (a) { return a.id; });
  var seenIds = {};
  for (var di = 0; di < accountIds.length; di++) {
    if (Object.prototype.hasOwnProperty.call(seenIds, accountIds[di])) {
      throw new Error('import failed: duplicate account id ' + accountIds[di]);
    }
    seenIds[accountIds[di]] = true;
  }
  if (!Array.isArray(data.trades)) {
    throw new Error('import failed: trades must be an array');
  }
  for (var ti = 0; ti < data.trades.length; ti++) {
    if (!isValidImportTrade(data.trades[ti], accountIds)) {
      throw new Error('import failed: invalid trade at index ' + ti);
    }
  }
  var priceOverrides = {};
  if (data.priceOverrides !== undefined) {
    if (!isValidPriceOverrides(data.priceOverrides)) {
      throw new Error('import failed: invalid priceOverrides');
    }
    priceOverrides = data.priceOverrides;
  }
  // All validation passed — only now replace stored state (never partial).
  var next = {
    settings: normalizeSettings(data.settings, defaultState().settings),
    accounts: data.accounts.map(normalizeAccount),
    trades: data.trades,
    priceOverrides: priceOverrides
  };
  saveState(next);
  return next;
}

// Legacy v1 file import: group v1 trades (account-less) into auto-created
// per-symbol accounts. No legacy runtime paths — v1 is never read from
// localStorage, only accepted here.
function importStateV1(data) {
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
    if (!isValidPriceOverrides(data.priceOverrides)) {
      throw new Error('import failed: invalid priceOverrides');
    }
    priceOverrides = data.priceOverrides;
  }
  var accounts = [];
  var bySymbol = {};
  var trades = data.trades.map(function (t) {
    var sym = String(t.symbol).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(bySymbol, sym)) {
      var acc = { id: uid(), name: sym, ticker: sym, createdAt: new Date().toISOString() };
      bySymbol[sym] = acc;
      accounts.push(acc);
    }
    var copy = {};
    for (var k in t) {
      if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k];
    }
    copy.accountId = bySymbol[sym].id;
    return copy;
  });
  // Membership holds by construction; re-check via the extended validator
  // so a grouping bug can never silently persist a dangling trade.
  var accountIds = accounts.map(function (a) { return a.id; });
  for (var vi = 0; vi < trades.length; vi++) {
    if (!isValidImportTrade(trades[vi], accountIds)) {
      throw new Error('import failed: invalid trade at index ' + vi);
    }
  }
  var next = {
    settings: {
      mainCurrency: data.settings.mainCurrency,
      costMethod: data.settings.costMethod,
      defaultAccountId: accounts.length ? accounts[0].id : null
    },
    accounts: accounts,
    trades: trades,
    priceOverrides: priceOverrides
  };
  saveState(next);
  return next;
}

function accountById(st, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  var list = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

function defaultAccount(st) {
  var list = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  if (!list.length) return null;
  var want = (st && st.settings) ? st.settings.defaultAccountId : null;
  var hit = (typeof want === 'string' && want.length > 0) ? accountById(st, want) : null;
  return hit || list[0];
}

// Expose pure functions for tests.html via window.Inoculens.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.loadState = loadState;
  window.Inoculens.saveState = saveState;
  window.Inoculens.exportState = exportState;
  window.Inoculens.importState = importState;
  window.Inoculens.defaultState = defaultState;
  window.Inoculens.accountById = accountById;
  window.Inoculens.defaultAccount = defaultAccount;
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
    // Unknown live price stays unknown (null) — never coerced to 0, which
    // fabricated a full loss (value 0, unrealized -cost, return -100%).
    var raw = live ? live[sym] : undefined;
    var num = Number(raw);
    var known = isFinite(num) && num > 0;
    var livePrice = known ? num : null;
    var qtyHeld = v.qty || 0;
    var avgEntry = v.avgEntry || 0;
    var marketValue = known ? qtyHeld * num : (qtyHeld === 0 ? 0 : null);
    var unrealized = marketValue === null ? null : marketValue - avgEntry * qtyHeld;
    var realized = v.realized || 0;
    var totalPL = unrealized === null ? realized : unrealized + realized;
    var denom = buyCost[sym] || 0;
    var returnPct = denom > 0
      ? (unrealized === null ? (qtyHeld === 0 ? (realized / denom) * 100 : null) : (totalPL / denom) * 100)
      : 0;
    rows.push({
      symbol: sym,
      qtyHeld: qtyHeld,
      avgEntry: avgEntry,
      livePrice: livePrice,
      marketValue: marketValue,
      unrealized: unrealized,
      realized: realized,
      totalPL: totalPL,
      returnPct: returnPct
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

var APP_VERSION = '2026-10-06.6';

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
  // null/undefined/'' (unknown values) carry no data-value; 0 is a real value.
  if (raw !== null && raw !== undefined && raw !== '' && isFinite(Number(raw))) {
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

function statCard(label, text, raw) {
  var d = document.createElement('div');
  d.className = 'card';
  var l = document.createElement('span');
  l.className = 'card-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'card-value num';
  v.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    v.setAttribute('data-value', String(Number(raw)));
  }
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

function renderSummaryCards(st, rows) {
  var main = st.settings.mainCurrency;
  var mv = 0;
  var un = 0;
  var rz = 0;
  var pl = 0;
  var mvKnown = false;
  var unKnown = false;
  var costKnown = 0; // remaining cost basis of positions with known prices
  rows.forEach(function (p) {
    rz += p.realized;
    pl += p.totalPL;
    if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
    if (p.unrealized !== null) { un += p.unrealized; unKnown = true; }
    if (p.marketValue !== null && p.unrealized !== null) costKnown += p.marketValue - p.unrealized;
  });
  var tb = document.getElementById('tb-totals');
  if (tb) {
    tb.textContent = rows.length
      ? ('Portfolio value ' + (mvKnown ? fmtMoney(mv, main) : '—') + ' · total P&L ' + fmtMoney(pl, main) +
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
  var ret = costKnown > 0 ? ((un + rz) / costKnown) * 100 : null;
  [['Value', mvKnown ? fmtMoney(mv, main) : '—', mvKnown ? mv : null],
   ['Unrealized', unKnown ? fmtMoney(un, main) : '—', unKnown ? un : null],
   ['Realized', fmtMoney(rz, main), rz],
   ['Return', ret !== null ? fmtPct(ret) : '—', ret]].forEach(function (c) {
    var cardEl = statCard(c[0], c[1], c[2]);
    if (c[0] !== 'Value') {
      var sc = plClass(c[2]);
      if (sc) cardEl.querySelector('.card-value').classList.add(sc);
    }
    host.appendChild(cardEl);
  });
  var hv = document.getElementById('hero-value');
  if (hv) hv.textContent = rows.length ? (mvKnown ? fmtMoney(mv, main) : '—') : '—';
  var hp = document.getElementById('hero-pl');
  if (hp) {
    if (!rows.length) {
      hp.textContent = '';
      hp.className = 'hero-pl';
    } else {
      hp.textContent = fmtMoney(pl, main);
      hp.className = 'hero-pl pill ' + plClass(pl);
    }
  }
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
      (p.livePrice !== null) ? fmtMoney(p.livePrice, main) : '—', true, p.livePrice));
    tr.appendChild(posCell('Value',
      (p.marketValue !== null) ? fmtMoney(p.marketValue, main) : '—', true, p.marketValue));
    tr.appendChild(posCell('Unrealized',
      (p.unrealized !== null) ? fmtMoney(p.unrealized, main) : '—', true, p.unrealized));
    tr.appendChild(posCell('Realized', fmtMoney(p.realized, main), true, p.realized));
    tr.appendChild(posCell('Total P&L', fmtMoney(p.totalPL, main), true, p.totalPL));
    tr.appendChild(posCell('Return %',
      (p.returnPct !== null) ? fmtPct(p.returnPct) : '—', true, p.returnPct));
    tbody.appendChild(tr);
  });
  renderSummaryCards(st, rows);
}

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

function deleteTrade(id) {
  if (!id) return;
  var st = loadState();
  var kept = (st.trades || []).filter(function (t) { return !t || t.id !== id; });
  if (kept.length === (st.trades || []).length) return; // unknown id: no write
  st.trades = kept;
  if (!saveStateGuarded(st)) return;
  render(); // cached live prices stay; no refetch needed on delete
}

// --- Accounts UI (Task 2: stacked cards + CRUD + empty state) ---
// Per-card + Trade buttons carry data-account-trade="<id>", wired below to
// openPrefillTrade (Task 3).

function accountTrades(st, accountId) {
  // Single-arg form accountTrades(accountId) reads live state (test helper).
  if (typeof st === 'string' && accountId === undefined) {
    return accountTrades(loadState(), st);
  }
  return ((st && st.trades) || []).filter(function (t) { return t && t.accountId === accountId; });
}

function createAccount(name, ticker) {
  var st = loadState();
  var tk = String(ticker || '').trim().toUpperCase();
  var nm = String(name || '').trim();
  if (!tk) { showBanner('Ticker is required (e.g. BTC).'); return null; }
  if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) { showBanner('Ticker looks invalid — letters/numbers, up to 12 chars.'); return null; }
  if (!nm) nm = tk; // name defaults to ticker
  var first = !Array.isArray(st.accounts) || st.accounts.length === 0;
  var acc = { id: uid(), name: nm, ticker: tk, createdAt: new Date().toISOString() };
  st.accounts.push(acc);
  if (first) st.settings.defaultAccountId = acc.id; // set default if first
  if (!saveStateGuarded(st)) return null;
  clearBanner();
  render();
  return acc;
}

function openAccountDialog() {
  buildAccountDialog();
  openDialog('account-dialog');
  return null;
}

function renameAccount(id, name) {
  if (!id) return;
  var st = loadState();
  var acc = accountById(st, id);
  if (!acc) return;
  var nm = String(name === undefined || name === null ? '' : name).trim();
  if (!nm) { showBanner('Account name cannot be empty.'); return; }
  acc.name = nm;
  if (!saveStateGuarded(st)) return;
  clearBanner();
  render();
}

function setDefaultAccount(id) {
  if (!id) return;
  var st = loadState();
  if (!accountById(st, id)) return;
  st.settings.defaultAccountId = id;
  if (!saveStateGuarded(st)) return;
  render();
}

function deleteAccount(id) {
  if (!id) return;
  var st = loadState();
  var acc = accountById(st, id);
  if (!acc) return; // unknown id: no write, no dialog
  if (typeof window.confirm === 'function' &&
      !window.confirm('Delete account "' + acc.name + '" (' + acc.ticker + ')? This cannot be undone.')) {
    return;
  }
  var remaining = accountTrades(st, id);
  if (remaining.length) {
    showBanner('Delete its trades first — an account with trades cannot be deleted.');
    render();
    return;
  }
  st.accounts = (st.accounts || []).filter(function (a) { return !a || a.id !== id; });
  if (st.settings.defaultAccountId === id) {
    st.settings.defaultAccountId = st.accounts.length ? st.accounts[0].id : null;
  }
  if (!saveStateGuarded(st)) return;
  clearBanner();
  render();
}

function buildAccountCreateRow() {
  var row = document.createElement('div');
  row.className = 'account-create-row';
  var fn = document.createElement('div');
  fn.className = 'fld';
  var ln = document.createElement('label');
  ln.setAttribute('for', 'acct-name');
  ln.textContent = 'Account name';
  var inName = document.createElement('input');
  inName.id = 'acct-name';
  inName.setAttribute('autocomplete', 'off');
  inName.setAttribute('spellcheck', 'false');
  inName.setAttribute('placeholder', 'e.g. Cold wallet');
  fn.appendChild(ln);
  fn.appendChild(inName);
  var ft = document.createElement('div');
  ft.className = 'fld';
  var lt = document.createElement('label');
  lt.setAttribute('for', 'acct-ticker');
  lt.textContent = 'Ticker';
  var inTick = document.createElement('input');
  inTick.id = 'acct-ticker';
  inTick.setAttribute('autocomplete', 'off');
  inTick.setAttribute('spellcheck', 'false');
  inTick.setAttribute('placeholder', 'BTC');
  ft.appendChild(lt);
  ft.appendChild(inTick);
  var create = document.createElement('button');
  create.type = 'button';
  create.id = 'acct-create';
  create.className = 'primary';
  create.textContent = 'Create account';
  var demo = document.createElement('button');
  demo.type = 'button';
  demo.id = 'acct-demo';
  demo.textContent = 'Load demo';
  row.appendChild(fn);
  row.appendChild(ft);
  row.appendChild(create);
  row.appendChild(demo);
  return row;
}

// gain/loss tint for P&L figures (Revolut-style): '' for zero/unknown.
function plClass(n) {
  var v = Number(n);
  if (!isFinite(v) || v === 0) return '';
  return v > 0 ? 'gain' : 'loss';
}

function moneyCell(label, n, main) {
  var td = posCell(label, (n !== null && n !== undefined) ? fmtMoney(n, main) : '—', true, n);
  if (n !== null && n !== undefined) {
    var sc = plClass(n);
    if (sc) td.classList.add(sc); // plClass('' ) for zero/NaN: add('') would throw
  }
  return td;
}

function positionRow(p, main) {
  var tr = document.createElement('tr');
  var symLabel = (p.qtyHeld === 0) ? (p.symbol + ' (Closed)') : p.symbol;
  tr.appendChild(posCell('Symbol', symLabel, false, null));
  tr.appendChild(posCell('Qty', fmtQty(p.qtyHeld), true, p.qtyHeld));
  tr.appendChild(posCell('Avg entry', fmtMoney(p.avgEntry, main), true, p.avgEntry));
  tr.appendChild(posCell('Live', (p.livePrice !== null) ? fmtMoney(p.livePrice, main) : '—', true, p.livePrice));
  tr.appendChild(posCell('Value', (p.marketValue !== null) ? fmtMoney(p.marketValue, main) : '—', true, p.marketValue));
  tr.appendChild(moneyCell('Unrealized', p.unrealized, main));
  tr.appendChild(moneyCell('Realized', p.realized, main));
  tr.appendChild(moneyCell('Total P&L', p.totalPL, main));
  var retTd = posCell('Return %', (p.returnPct !== null) ? fmtPct(p.returnPct) : '—', true, p.returnPct);
  if (p.returnPct !== null) {
    var rsc = plClass(p.returnPct);
    if (rsc) retTd.classList.add(rsc);
  }
  tr.appendChild(retTd);
  return tr;
}

function positionTable(rows, main) {
  if (!rows || !rows.length) return null;
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
  var tbody = document.createElement('tbody');
  rows.forEach(function (p) { tbody.appendChild(positionRow(p, main)); });
  table.appendChild(tbody);
  return table;
}

function tradeRow(t, main) {
  var n = normalizeTrade(t);
  var tr = document.createElement('tr');
  tr.appendChild(posCell('Date', t.date || '', false, null));
  tr.appendChild(posCell('Side', t.type === 'sell' ? 'Sell' : 'Buy', false, null));
  tr.appendChild(posCell('Qty', fmtQty(t.qty), true, t.qty));
  tr.appendChild(posCell('Native total',
    fmtQty(t.total) + ' ' + String(t.currency || '').toUpperCase(), true, t.total));
  var normTd = posCell('Normalized total', '', true, n.totalMain + n.feeMain);
  normTd.textContent = fmtMoney(n.totalMain + n.feeMain, main);
  var badgeEl = document.createElement('small');
  badgeEl.className = 'muted';
  badgeEl.textContent = ' ' + fxBadgeText(t);
  normTd.appendChild(badgeEl);
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
  del.addEventListener('click', function () { deleteTrade(del.getAttribute('data-del')); });
  actTd.appendChild(del);
  tr.appendChild(actTd);
  return tr;
}

function tradesTable(atrades, main) {
  var table = document.createElement('table');
  var thead = document.createElement('thead');
  var thtr = document.createElement('tr');
  ['Date', 'Side', 'Qty', 'Native total', 'Normalized total', 'Fee', 'Note', ''].forEach(function (c, i) {
    var th = document.createElement('th');
    th.textContent = c;
    if (i >= 2 && i <= 5) th.className = 'num';
    th.setAttribute('scope', 'col');
    thtr.appendChild(th);
  });
  thead.appendChild(thtr);
  table.appendChild(thead);
  var tbody = document.createElement('tbody');
  ledgerSortByDate(atrades).reverse().forEach(function (t) { tbody.appendChild(tradeRow(t, main)); });
  table.appendChild(tbody);
  return table;
}

function renderAccounts(st) {
  var host = document.getElementById('accounts');
  if (!host) return;
  var method = st.settings.costMethod;
  var main = st.settings.mainCurrency;
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  // AGGREGATE-BEATS-GLOBAL: grand totals are the SUM of the per-account
  // computePositions runs (same method), never a separate global all-trades
  // engine run. Each account's run is computed once here and reused for its
  // card below, so cards and totals agree by construction.
  var perAcctRows = accounts.map(function (acc) {
    return computePositions(accountTrades(st, acc.id), livePrices, method);
  });
  var grandRows = [];
  perAcctRows.forEach(function (rows) {
    rows.forEach(function (r) { grandRows.push(r); });
  });
  renderSummaryCards(st, grandRows);
  host.innerHTML = '';
  if (!accounts.length) {
    var empty = document.createElement('div');
    empty.className = 'account-empty';
    var h = document.createElement('h2');
    h.textContent = 'Accounts';
    empty.appendChild(h);
    var p = document.createElement('p');
    p.textContent = 'Create your first account to get started.';
    empty.appendChild(p);
    empty.appendChild(buildAccountCreateRow());
    var hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Trades belong to an account — create one to enable Add trade.';
    empty.appendChild(hint);
    host.appendChild(empty);
    return;
  }
  var h2 = document.createElement('h2');
  h2.textContent = 'Accounts';
  h2.className = 'section-title';
  host.appendChild(h2);
  var def = defaultAccount(st);
  accounts.forEach(function (acc, ai) {
    var card = document.createElement('article');
    card.className = 'account-card';
    card.setAttribute('data-account', acc.id);
    card.setAttribute('data-account-nav', acc.id);
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', 'Open ' + acc.name + ', ' + String(acc.ticker).toUpperCase());
    var avatar = document.createElement('span');
    avatar.className = 'acct-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = String(acc.ticker || '?').charAt(0).toUpperCase();
    card.appendChild(avatar);
    var mid = document.createElement('span');
    mid.className = 'acct-mid';
    var nameEl = document.createElement('span');
    nameEl.className = 'account-name';
    nameEl.textContent = acc.name;
    mid.appendChild(nameEl);
    var tickEl = document.createElement('span');
    tickEl.className = 'account-ticker';
    tickEl.textContent = String(acc.ticker).toUpperCase() + ((def && def.id === acc.id) ? ' · Default' : '');
    mid.appendChild(tickEl);
    card.appendChild(mid);
    var atrades = accountTrades(st, acc.id);
    var rows = perAcctRows[ai]; // computed once above; totals aggregate these same runs
    var pl = 0;
    var mv = 0;
    var mvKnown = false;
    rows.forEach(function (r) {
      pl += r.totalPL;
      if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
    });
    var figs = document.createElement('span');
    figs.className = 'acct-figs';
    var valv = document.createElement('span');
    valv.className = 'acct-value';
    valv.textContent = mvKnown ? fmtMoney(mv, main) : (atrades.length ? '—' : 'New');
    figs.appendChild(valv);
    var plv = document.createElement('span');
    plv.className = 'acct-pl ' + plClass(pl);
    plv.textContent = fmtMoney(pl, main);
    if (isFinite(Number(pl))) plv.setAttribute('data-value', String(Number(pl)));
    figs.appendChild(plv);
    card.appendChild(figs);
    var tradeBtn = document.createElement('button');
    tradeBtn.type = 'button';
    tradeBtn.className = 'quiet';
    tradeBtn.textContent = '+ Trade';
    tradeBtn.setAttribute('data-account-trade', acc.id);
    tradeBtn.setAttribute('aria-label', 'Add trade to ' + acc.name);
    card.appendChild(tradeBtn);
    var chev = document.createElement('span');
    chev.className = 'acct-chev';
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '›';
    card.appendChild(chev);
    host.appendChild(card);
  });
}

function startInlineRename(accId, headEl, nameEl) {
  var st = loadState();
  var acc = accountById(st, accId);
  if (!acc || !headEl || !nameEl) return;
  if (headEl.querySelector('[data-rename-input]')) return;
  var input = document.createElement('input');
  input.setAttribute('data-rename-input', '1');
  input.value = acc.name;
  input.setAttribute('aria-label', 'New name for ' + acc.name);
  headEl.insertBefore(input, nameEl);
  headEl.removeChild(nameEl);
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    renameAccount(accId, input.value);
  }
  function cancel() {
    if (done) return;
    done = true;
    render();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

// --- Account detail view (list → detail navigation) ---
// Home shows minimal folder cards; clicking one routes to #/account/<id>
// and this renders the full account page: header, figures, positions and
// trades tables, and a ··· menu (trade / default / rename / delete).
// Tables reuse positionTable + tradesTable, so cells (data-value,
// data-label, gain/loss) match everywhere. Unknown account id routes home.

function accountDetailId() {
  var h = String((typeof location !== 'undefined' && location.hash) || '');
  var m = /^#\/account\/([^\/?#]+)/.exec(h);
  return m ? decodeURIComponent(m[1]) : null;
}

function renderAccountDetail(st, id) {
  var host = document.getElementById('account-detail');
  if (!host) return;
  var acc = accountById(st, id);
  if (!acc) {
    if (typeof location !== 'undefined' && String(location.hash || '') !== '#/') location.hash = '#/';
    return;
  }
  var main = st.settings.mainCurrency;
  var method = st.settings.costMethod;
  var rows = computePositions(accountTrades(st, acc.id), livePrices, method);
  var atrades = accountTrades(st, acc.id);
  host.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'account-head detail-head';
  var nameEl = document.createElement('h1');
  nameEl.className = 'account-name detail-name';
  nameEl.textContent = acc.name;
  head.appendChild(nameEl);
  var chip = document.createElement('span');
  chip.className = 'ticker-chip';
  var lv = livePrices[String(acc.ticker || '').toUpperCase()];
  var lvNum = Number(lv);
  chip.textContent = String(acc.ticker).toUpperCase() + ((isFinite(lvNum) && lvNum > 0) ? ' · ' + fmtMoney(lvNum, main) : '');
  head.appendChild(chip);
  var def = defaultAccount(st);
  if (def && def.id === acc.id) {
    var badge = document.createElement('span');
    badge.className = 'account-default-badge';
    badge.textContent = 'Default';
    head.appendChild(badge);
  }
  var menu = document.createElement('details');
  menu.className = 'menu';
  var sum = document.createElement('summary');
  sum.textContent = '···';
  sum.setAttribute('aria-label', 'Account options');
  menu.appendChild(sum);
  var mbox = document.createElement('div');
  mbox.className = 'menu-box';
  function menuBtn(text, label, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label + ' ' + acc.name);
    b.addEventListener('click', function () {
      menu.removeAttribute('open');
      fn();
    });
    mbox.appendChild(b);
    return b;
  }
  menuBtn('+ Trade', 'Add trade to', function () { openPrefillTrade(acc.id, true); });
  if (!def || def.id !== acc.id) {
    menuBtn('Make default', 'Make default account', function () { setDefaultAccount(acc.id); });
  }
  menuBtn('Rename', 'Rename', function () { startInlineRename(acc.id, head, nameEl); });
  menuBtn('Delete', 'Delete', function () { deleteAccount(acc.id); });
  menu.appendChild(mbox);
  head.appendChild(menu);
  host.appendChild(head);
  var stats = document.createElement('div');
  stats.className = 'cards detail-stats';
  var pl = 0;
  var mv = 0;
  var mvKnown = false;
  var un = 0;
  var unKnown = false;
  var rz = 0;
  rows.forEach(function (r) {
    rz += r.realized;
    pl += r.totalPL;
    if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
    if (r.unrealized !== null) { un += r.unrealized; unKnown = true; }
  });
  var cost = mv - un;
  var ret = (mvKnown && unKnown && cost > 0) ? ((un + rz) / cost) * 100 : null;
  stats.appendChild(statCard('Value', mvKnown ? fmtMoney(mv, main) : (atrades.length ? '—' : 'New'), mvKnown ? mv : null));
  stats.appendChild(statCard('Unrealized', unKnown ? fmtMoney(un, main) : '—', unKnown ? un : null));
  stats.appendChild(statCard('Realized', fmtMoney(rz, main), rz));
  var retCard = statCard('Return', ret !== null ? fmtPct(ret) : '—', ret);
  var rsc = plClass(ret);
  if (rsc) retCard.querySelector('.card-value').classList.add(rsc);
  stats.appendChild(retCard);
  host.appendChild(stats);
  var ptable = positionTable(rows, main);
  if (ptable) {
    host.appendChild(ptable);
  } else {
    var muted = document.createElement('p');
    muted.className = 'muted';
    muted.textContent = 'No trades yet — add one to see P&L.';
    host.appendChild(muted);
  }
  if (atrades.length) host.appendChild(tradesTable(atrades, main));
}

function route() {
  var home = document.getElementById('view-home');
  var det = document.getElementById('view-account');
  if (!home || !det) return;
  var id = accountDetailId();
  if (id) {
    home.hidden = true;
    det.hidden = false;
    var st;
    try {
      st = loadState();
    } catch (e) {
      st = defaultState();
    }
    if (!st || !st.settings) st = defaultState();
    renderAccountDetail(st, id);
  } else {
    det.hidden = true;
    home.hidden = false;
  }
}

function buildAccounts() {
  var host = document.getElementById('accounts');
  if (host && !host.getAttribute('data-wired')) {
    host.setAttribute('data-wired', '1');
    host.addEventListener('click', function (e) {
      var t = e && e.target && e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'acct-create') {
        createAccount(uiVal('acct-name', ''), uiVal('acct-ticker', ''));
        return;
      }
      if (t.id === 'acct-demo') {
        addDemoTrade();
        return;
      }
      if (t.hasAttribute('data-account-trade')) {
        openPrefillTrade(t.getAttribute('data-account-trade'));
        return;
      }
      if (t.hasAttribute('data-account-rename')) {
        var rid = t.getAttribute('data-account-rename');
        var card = t.closest ? t.closest('[data-account]') : null;
        var headEl = t.closest ? t.closest('.account-head') : null;
        var nameEl = card ? card.querySelector('.account-name') : null;
        startInlineRename(rid, headEl, nameEl);
        return;
      }
      if (t.hasAttribute('data-account-delete')) {
        deleteAccount(t.getAttribute('data-account-delete'));
        return;
      }
      if (t.hasAttribute('data-account-default')) {
        setDefaultAccount(t.getAttribute('data-account-default'));
        return;
      }
      var del = e.target && e.target.closest ? e.target.closest('[data-del]') : null;
      if (del) {
        deleteTrade(del.getAttribute('data-del'));
        return;
      }
    });
  }
  var add = document.getElementById('tb-account');
  if (add && !add.getAttribute('data-wired')) {
    add.setAttribute('data-wired', '1');
    add.addEventListener('click', function () { openAccountDialog(); });
  }
  // Folder-card navigation (home → detail). Buttons keep their own
  // behavior; anything else on the card opens the account page.
  var navHost = document.getElementById('accounts');
  if (navHost && !navHost.getAttribute('data-nav-wired')) {
    navHost.setAttribute('data-nav-wired', '1');
    navHost.addEventListener('click', function (e) {
      if (!e || !e.target || !e.target.closest) return;
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav') && typeof location !== 'undefined') {
        location.hash = '#/account/' + encodeURIComponent(nav.getAttribute('data-account-nav'));
      }
    });
    navHost.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav')) {
        e.preventDefault();
        if (typeof location !== 'undefined') location.hash = '#/account/' + encodeURIComponent(nav.getAttribute('data-account-nav'));
      }
    });
  }
}

// --- New-account dialog ---
// Name + ticker only (story step one). Wired once; empty-state inline row
// keeps its own acct-* ids so the two never collide.

function naError(msg) {
  var p = document.getElementById('na-error');
  if (!p) return;
  if (!msg) {
    p.textContent = '';
    p.hidden = true;
    return;
  }
  p.textContent = String(msg);
  p.hidden = false;
}

function buildAccountDialog() {
  var host = document.getElementById('account-dialog-body');
  if (!host || document.getElementById('na-create')) return;
  wireDialog('account-dialog');
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<label for="na-name">Account name</label>' +
    '<input id="na-name" autocomplete="off" spellcheck="false" placeholder="e.g. Cold wallet">' +
    '<label for="na-ticker">Ticker</label>' +
    '<input id="na-ticker" autocomplete="off" spellcheck="false" placeholder="BTC">' +
    '<p id="na-error" class="banner-error" role="alert" hidden></p>' +
    '<button id="na-create" class="primary" type="button">Create account</button>';
  host.appendChild(wrap);
  document.getElementById('na-create').addEventListener('click', function () {
    naError(null);
    var tk = uiVal('na-ticker', '').trim().toUpperCase();
    if (!tk) { naError('Ticker is required (e.g. BTC).'); return; }
    if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) { naError('Ticker looks invalid — letters/numbers, up to 12 chars.'); return; }
    var acc = createAccount(uiVal('na-name', ''), tk);
    if (!acc) { naError('Could not create the account — storage unavailable.'); return; }
    uiSetVal('na-name', '');
    uiSetVal('na-ticker', '');
    closeDialog('account-dialog');
  });
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
    '<div id="t-account-row"><label for="t-account">Account</label>' +
    '<select id="t-account"></select></div>' +
    '<div class="fld-locked"><span class="fld-label">Symbol (locked to account)</span> <span id="t-symbol-locked" role="status"></span></div>' +
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
    '<details class="adv"><summary>Details</summary>' +
    '<label for="t-fee">Fee</label>' +
    '<input id="t-fee" inputmode="decimal" placeholder="0">' +
    '<label for="t-feeccy">Fee currency</label>' +
    '<select id="t-feeccy">' + ccyOptions('EUR', false) + '</select>' +
    '<label for="t-note">Note</label>' +
    '<input id="t-note" autocomplete="off" placeholder="optional">' +
    '<label for="t-manual-rate">Manual FX rate (fallback when ECB is unavailable)</label>' +
    '<input id="t-manual-rate" inputmode="decimal" placeholder="e.g. 0.92">' +
    '<label for="t-manual-price">Manual live price (override, in main currency)</label>' +
    '<input id="t-manual-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '</details>' +
    '<p id="t-error" class="banner-error" role="alert" hidden></p>' +
    '<button class="primary" type="submit">Add trade</button>' +
    '</form>';
  host.appendChild(wrap);
  var form = document.getElementById('trade-form');
  form.addEventListener('submit', onTradeSubmit);
  var acctSel = document.getElementById('t-account');
  if (acctSel) acctSel.addEventListener('change', syncLockedSymbol);
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

// --- Account-bound trade dialog (Task 3) ---
// First field is the Account select (options rebuilt on every open);
// the symbol is shown locked read-only to that account's ticker.
// openPrefillTrade(accountId|null) preselects the originating card's
// account (or the default for null/unknown) and opens the dialog.

function syncLockedSymbol() {
  var sel = document.getElementById('t-account');
  var locked = document.getElementById('t-symbol-locked');
  if (!sel || !locked) return;
  var acc = accountById(loadState(), sel.value);
  locked.textContent = acc ? String(acc.ticker).toUpperCase() : '';
}

function openPrefillTrade(accountId, lockIt) {
  var st = loadState();
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  if (!accounts.length) {
    showBanner('Create your first account to enable Add trade.');
    var host = document.getElementById('accounts');
    if (host && host.scrollIntoView) {
      try { host.scrollIntoView(); } catch (e) { /* ignore */ }
    }
    return null;
  }
  var target = ((typeof accountId === 'string' && accountId.length > 0) && accountById(st, accountId)) ||
    defaultAccount(st) || accounts[0];
  buildTradeForm(); // ensure the form exists (init normally builds it)
  var sel = document.getElementById('t-account');
  if (sel) {
    sel.innerHTML = '';
    accounts.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = target.id;
  }
  // Locked context (e.g. opened from an account page): the account is fixed,
  // so the select is hidden. From home the select stays visible.
  var row = document.getElementById('t-account-row');
  if (row) row.style.display = (lockIt && target) ? 'none' : '';
  syncLockedSymbol();
  var d = document.getElementById('t-date');
  if (d && !d.value) d.value = todayStr();
  tradeFormError(null);
  openDialog('trade-dialog');
  return target;
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
  var st0 = loadState();
  var main = st0.settings.mainCurrency;
  var side = uiVal('t-side', 'buy') === 'sell' ? 'sell' : 'buy';
  var acc = accountById(st0, uiVal('t-account', '')) || defaultAccount(st0);
  if (!acc) { tradeFormError('Create your first account to enable Add trade.'); return; }
  var symbol = String(acc.ticker).toUpperCase();
  var accountId = acc.id;
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
  if (!symbol || !/^[A-Z0-9._-]{1,12}$/.test(symbol)) { tradeFormError('Account ticker looks invalid.'); return; }
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
      accountId: accountId,
      createdAt: new Date().toISOString()
    };
    var err = validateTrade(trade, heldQtyFor(accountTrades(st, accountId), symbol));
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
    if (typeof location !== 'undefined') location.hash = '#/account/' + encodeURIComponent(accountId);
    render(); // route() picks up the hash: the trade's account page shows the new rows
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
    add.addEventListener('click', function () {
      var cur = loadState();
      if (!Array.isArray(cur.accounts) || cur.accounts.length === 0) {
        showBanner('Create your first account to enable Add trade.');
        var host = document.getElementById('accounts');
        if (host && host.scrollIntoView) {
          try { host.scrollIntoView(); } catch (e) { /* ignore */ }
        }
        return;
      }
      // On an open account page the trade belongs to that account (locked);
      // on home the account stays selectable (defaults to the default).
      var rid = accountDetailId();
      var open = (typeof rid === 'string' && rid) ? accountById(cur, rid) : null;
      if (open) openPrefillTrade(open.id, true);
      else openPrefillTrade(null);
    });
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
    '<details class="opt" open><summary>Price overrides</summary>' +
    '<label for="o-symbol">Symbol</label>' +
    '<input id="o-symbol" autocomplete="off" spellcheck="false" placeholder="BTC">' +
    '<label for="o-price">Price (main currency)</label>' +
    '<input id="o-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '<button id="o-add" type="button">Save override</button>' +
    '<ul id="o-list"></ul>' +
    '</details>' +
    '<details class="opt"><summary>Backup &amp; restore</summary>' +
    '<button id="s-download" type="button">Download backup</button>' +
    '<label for="s-upload">Restore from file</label>' +
    '<input id="s-upload" type="file" accept="application/json,.json">' +
    '</details>' +
    '<details class="opt"><summary>Danger zone</summary>' +
    '<button id="s-demo" type="button">Load demo trade</button>' +
    '<button id="s-clear" type="button">Clear all data</button>' +
    '</details>';
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
  var acc = defaultAccount(st);
  if (!acc) {
    acc = { id: uid(), name: 'Demo BTC', ticker: 'BTC', createdAt: new Date().toISOString() };
    st.accounts.push(acc);
    st.settings.defaultAccountId = acc.id;
  }
  st.trades.push({
    id: uid(),
    type: 'buy',
    symbol: acc.ticker,
    qty: 1,
    total: 50000,
    currency: m,
    date: '2026-01-01',
    fee: 0,
    feeCurrency: m,
    note: 'demo trade — remove with “Clear all data”',
    fxLock: { pair: m + '/' + m, rate: 1, source: '1:1', interpolated: false },
    accountId: acc.id,
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
  (st.accounts || []).forEach(function (a) {
    if (a && a.ticker) {
      var t = String(a.ticker).toUpperCase();
      if (syms.indexOf(t) === -1) syms.push(t); // unique: trades may already list it
    }
  });
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
  renderAccounts(st);
  syncTopbar(st);
  var ver = document.getElementById('app-ver');
  if (ver) ver.textContent = 'INOCULENS ASSETS v' + APP_VERSION + ' · local-only, no account, no server';
  route(); // show home or the routed account page
}

var hashWired = false;

function init() {
  if (uiBooted) {
    render();
    return;
  }
  if (!document.getElementById('accounts')) return;
  buildTopbar();
  buildAccounts();
  buildTradeForm();
  buildSettings();
  buildAccountDialog();
  if (!hashWired && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    hashWired = true;
    window.addEventListener('hashchange', route);
  }
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
  window.Inoculens.renderAccounts = renderAccounts;
  window.Inoculens.openAccountDialog = openAccountDialog;
  window.Inoculens.createAccount = createAccount;
  window.Inoculens.renameAccount = renameAccount;
  window.Inoculens.deleteAccount = deleteAccount;
  window.Inoculens.setDefaultAccount = setDefaultAccount;
  window.Inoculens.accountTrades = accountTrades;
  window.Inoculens.heldQtyFor = heldQtyFor;
  window.Inoculens.openPrefillTrade = openPrefillTrade;
  window.Inoculens.syncLockedSymbol = syncLockedSymbol;
  window.Inoculens.route = route;
  window.Inoculens.renderAccountDetail = renderAccountDetail;
  window.Inoculens.accountDetailId = accountDetailId;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', init);
  }
  // Surface unexpected errors visibly so users can report them with the version above.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('error', function (e) {
      try {
        showBanner('App error: ' + ((e && e.message) || 'unknown error') + ' — please report this text plus your app version (bottom of page).');
      } catch (err) { /* ignore */ }
    });
  }
}
