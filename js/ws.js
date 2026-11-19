/* NIVA QUANT AI — ws.js
   Binance Futures WebSocket: multiplexed aggTrade + kline + markPrice +
   bookTicker for watched symbols. Auto-reconnect with backoff, base
   fallback (fstream → data-stream). Stale-data detection: any symbol
   with no tick for 60s is flagged stale. */
'use strict';

import { WS_URLS } from './config.js';
import { logEvent } from './utils.js';

export const STALE_MS = 60000;

export class NivaSocket {
  constructor() {
    this.ws = null;
    this.baseIdx = 0;
    this.symbols = new Set(); // lowercase, e.g. 'btcusdt'
    this.klineTf = '5m';
    this.prices = new Map(); // symbol -> { price, ts }
    this.bookTicker = new Map(); // symbol -> { bid, ask, ts }
    this.klines = new Map(); // symbol -> latest kline object
    this.depthHandlers = new Map(); // symbol -> fn(event)
    this.onTick = null; // fn(symbol, price)
    this.onStatus = null; // fn(status, detail)
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.shouldRun = false;
    this.connected = false;
    this.lastMessageTs = null;
    this.staleTimer = null;
  }

  streamsFor(symbol) {
    const s = symbol.toLowerCase();
    return [
      s + '@aggTrade',
      s + '@kline_' + this.klineTf,
      s + '@markPrice@1s',
      s + '@bookTicker',
    ];
  }

  connect() {
    this.shouldRun = true;
    this._open();
    if (!this.staleTimer) {
      this.staleTimer = setInterval(() => this._checkStale(), 15000);
    }
  }

  _open() {
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    const base = WS_URLS[this.baseIdx % WS_URLS.length];
    const url = base + '/stream?streams=' + [...this.symbols].flatMap((s) => this.streamsFor(s)).join('/');
    // Binance requires at least one stream; if none watched yet, use BTC.
    const finalUrl = this.symbols.size ? url : base + '/stream?streams=btcusdt@markPrice@1s';
    let ws;
    try {
      ws = new WebSocket(finalUrl);
    } catch (e) {
      this._scheduleReconnect('WebSocket constructor failed');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.lastMessageTs = Date.now();
      logEvent('ws', 'WebSocket connected (' + base + ')');
      if (this.onStatus) this.onStatus('connected', base);
    };
    ws.onmessage = (ev) => {
      this.lastMessageTs = Date.now();
      try {
        const msg = JSON.parse(ev.data);
        this._handle(msg);
      } catch (e) { /* malformed frame — ignore */ }
    };
    ws.onerror = () => { /* onclose will handle reconnect */ };
    ws.onclose = () => {
      this.connected = false;
      if (this.onStatus) this.onStatus('disconnected', 'Connection closed');
      if (this.shouldRun) this._scheduleReconnect('Connection closed');
    };
  }

  _scheduleReconnect(reason) {
    if (!this.shouldRun || this.reconnectTimer) return;
    logEvent('ws', 'WebSocket reconnect in ' + (this.reconnectDelay / 1000) + 's — ' + reason);
    if (this.onStatus) this.onStatus('reconnecting', reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.baseIdx++; // alternate bases on each retry
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this._open();
    }, this.reconnectDelay);
  }

  _handle(msg) {
    const stream = msg.stream || '';
    const data = msg.data || msg;
    if (!stream) return;
    const symbol = stream.split('@')[0].toUpperCase();
    const now = Date.now();
    if (stream.includes('@aggTrade')) {
      const price = +data.p;
      this.prices.set(symbol, { price, ts: now });
      if (this.onTick) this.onTick(symbol, price, 'trade');
    } else if (stream.includes('@markPrice')) {
      const price = +data.p;
      if (!this.prices.has(symbol) || now - (this.prices.get(symbol).ts || 0) > 2000) {
        this.prices.set(symbol, { price, ts: now });
      }
      if (this.onTick) this.onTick(symbol, price, 'mark');
    } else if (stream.includes('@bookTicker')) {
      this.bookTicker.set(symbol, { bid: +data.b, ask: +data.a, ts: now });
    } else if (stream.includes('@kline_')) {
      const k = data.k;
      if (k) {
        this.klines.set(symbol, {
          t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v,
          closed: !!k.x, closeTime: k.T,
        });
      }
    } else if (stream.includes('@depth')) {
      const h = this.depthHandlers.get(symbol);
      if (h) h(data);
    }
  }

  /* Re-subscribe: Binance combined streams are fixed at connect time,
     so changing the watchlist reconnects (cheap, with backoff guard). */
  watch(symbols, klineTf) {
    const next = new Set(symbols.map((s) => s.toLowerCase()));
    if (klineTf) this.klineTf = klineTf;
    const same = next.size === this.symbols.size && [...next].every((s) => this.symbols.has(s));
    if (same && this.connected) return;
    this.symbols = next;
    if (this.shouldRun) this._open();
  }

  subscribeDepth(symbol, handler) {
    this.depthHandlers.set(symbol.toUpperCase(), handler);
    // Depth streams need their own connection params; re-open with depth
    // included is handled by watch() callers re-connecting. Here we just
    // record the handler — the stream list is extended in _open via
    // streamsFor only for core streams; depth is added on demand:
    if (this.ws && this.connected) {
      try {
        this.ws.send(JSON.stringify({
          method: 'SUBSCRIBE',
          params: [symbol.toLowerCase() + '@depth@100ms'],
          id: Date.now(),
        }));
      } catch (e) { /* will retry on reconnect */ }
    }
  }

  price(symbol) {
    const p = this.prices.get(symbol.toUpperCase());
    return p ? p.price : null;
  }

  isStale(symbol) {
    const p = this.prices.get(symbol.toUpperCase());
    if (!p) return true;
    return Date.now() - p.ts > STALE_MS;
  }

  staleSymbols() {
    return [...this.symbols].map((s) => s.toUpperCase()).filter((s) => this.isStale(s));
  }

  _checkStale() {
    const stale = this.staleSymbols();
    if (stale.length && this.connected) {
      logEvent('ws', 'Stale data (>60s without a tick): ' + stale.join(', '));
      if (this.onStatus) this.onStatus('stale', stale.join(', '));
    }
  }

  disconnect() {
    this.shouldRun = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    this.connected = false;
  }
}

export const socket = new NivaSocket();
