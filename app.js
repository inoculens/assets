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
