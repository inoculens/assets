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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
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

function fxFetchOnce(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) {
      var err = new Error('fx-http-' + res.status);
      err.fxStatus = res.status;
      throw err;
    }
    return res.json();
  });
}

function fxFetchWithRetry(url) {
  return fxFetchOnce(url).catch(function (e) {
    if (e && e.fxStatus === 404) throw e; // missing fixing: no point retrying the same date
    return fxFetchOnce(url); // retry once; a second failure propagates to the caller
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
  function attempt(d, back) {
    var url = FX_BASE_URL + '/' + d +
      '?from=' + encodeURIComponent(effFrom) + '&to=' + encodeURIComponent(effTo);
    function walkBack() {
      if (back >= FX_MAX_LOOKBACK_DAYS) throw new Error('fx-unavailable');
      return attempt(fxShiftDate(d, -1), back + 1);
    }
    return fxFetchWithRetry(url).then(
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
    var m = now.getUTCMonth() + 1;
    var d = now.getUTCDate();
    var today = now.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
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
