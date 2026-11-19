/* NIVA QUANT AI — utils.js
   Formatting, concurrency pool, fetch with timeout. No DOM here. */
'use strict';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

export function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '–';
  const a = Math.abs(p);
  if (a >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 100) return p.toFixed(2);
  if (a >= 1) return p.toFixed(4);
  if (a >= 0.01) return p.toFixed(5);
  if (a === 0) return '0.00';
  return p.toFixed(8);
}

export function fmtNum(n, digits = 2) {
  if (n == null || !isFinite(n)) return '–';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtCompact(n) {
  if (n == null || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

export function fmtUsd(n, digits = 2) {
  if (n == null || !isFinite(n)) return '–';
  return (n < 0 ? '-$' : '$') + fmtNum(Math.abs(n), digits);
}

export function fmtPct(x, digits = 2) {
  if (x == null || !isFinite(x)) return '–';
  return (x >= 0 ? '+' : '') + x.toFixed(digits) + '%';
}

export function fmtSigned(x, digits = 2) {
  if (x == null || !isFinite(x)) return '–';
  return (x >= 0 ? '+' : '') + x.toFixed(digits);
}

export function fmtR(r) {
  if (r == null || !isFinite(r)) return '–';
  return (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
}

export function timeAgo(ts) {
  if (!ts) return '–';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}

export function fmtTime(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDate(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* Escape text before injecting into HTML — symbols come from the exchange,
   never trust them raw. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* fetch with a hard timeout; throws on HTTP error with status attached. */
export async function fetchJSON(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ' ' + url);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally { clearTimeout(t); }
}

/* Run async tasks with limited parallelism; onProgress(done, total).
   A failed item yields null — one bad pair never kills the scan. */
export async function pool(items, size, fn, onProgress) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = null; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/* Simple in-memory event log, mirrored to localStorage (bounded). */
const LOG_CAP = 300;
export function logEvent(type, message, detail) {
  const entry = { ts: Date.now(), type, message, detail: detail || null };
  try {
    const key = 'niva_logs_v1';
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.unshift(entry);
    localStorage.setItem(key, JSON.stringify(arr.slice(0, LOG_CAP)));
  } catch (e) { /* storage unavailable */ }
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent('niva-log', { detail: entry }));
  }
  return entry;
}

export function loadLogs() {
  try { return JSON.parse(localStorage.getItem('niva_logs_v1') || '[]'); }
  catch (e) { return []; }
}

export function clearLogs() {
  try { localStorage.removeItem('niva_logs_v1'); } catch (e) {}
}
