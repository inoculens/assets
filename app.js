'use strict';
/* INOCULENS ASSETS — app.js
 * Vanilla JS, no framework, no build step. Organized in sections:
 * Store, Prices, Fx, Ledger, Ui. Tasks 3-6 append their sections below.
 */

// === Store ===
// Local-first persistence: localStorage + versioned export/import.
// Key: exactly 'inoculens.v1'. Export envelope: exactly
// {app:"inoculens-assets", version:1, exportedAt, settings, trades}.
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
    trades: s.trades
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
