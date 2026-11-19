/* NIVA QUANT AI — footprint.js
   Footprint chart view: price levels with bid/ask traded volume, delta,
   total volume, imbalance highlight. Built from real aggTrades —
   traded volume only, NOT resting liquidity. */
'use strict';

import { getAggTrades } from './binance.js';
import { buildFootprint, findImbalances, pointOfControl, volumeClusters } from './orderflow.js';
import { fmtPrice, fmtCompact, esc } from './utils.js';

export async function loadFootprint(symbol, settings, bucketMin = 15) {
  const trades = await getAggTrades(symbol, 1000);
  if (!trades.length) return { insufficient: true, reason: 'No recent trades returned for ' + symbol };
  const fp = buildFootprint(trades, bucketMin * 60 * 1000, null);
  const imbalances = findImbalances(fp.rows, settings.footprintImbalance || 300);
  const imbSet = new Set(imbalances.map((i) => i.price + '|' + i.side));
  const poc = pointOfControl(fp.rows);
  const clusters = volumeClusters(fp.rows, 5);
  return {
    insufficient: false,
    symbol, rows: fp.rows, tick: fp.tick,
    imbalances, imbSet, poc, clusters,
    tradeCount: trades.length,
    windowMin: trades.length > 1 ? Math.round((trades[trades.length - 1].time - trades[0].time) / 60000) : 0,
  };
}

/* Render the footprint table into a container element. */
export function renderFootprint(container, data) {
  if (!data || data.insufficient) {
    container.innerHTML = '<p class="hint">' + esc(data ? data.reason : 'No footprint data — pick a coin first.') + '</p>';
    return;
  }
  const maxTotal = Math.max(...data.rows.map((r) => r.total), 1);
  const rowsHtml = data.rows.slice(0, 40).map((r) => {
    const bullImb = data.imbSet.has(r.price + '|bull');
    const bearImb = data.imbSet.has(r.price + '|bear');
    const isPoc = data.poc && data.poc.price === r.price;
    const barW = Math.round(r.total / maxTotal * 100);
    return '<tr class="' + (isPoc ? 'fp-poc' : '') + '">' +
      '<td class="num">' + fmtPrice(r.price) + (isPoc ? ' <span class="tag">POC</span>' : '') + '</td>' +
      '<td class="num ' + (bearImb ? 'fp-imb-bear' : '') + '">' + fmtCompact(r.bidVol) + '</td>' +
      '<td class="num ' + (bullImb ? 'fp-imb-bull' : '') + '">' + fmtCompact(r.askVol) + '</td>' +
      '<td class="num ' + (r.delta >= 0 ? 'pos' : 'neg') + '">' + (r.delta >= 0 ? '+' : '') + fmtCompact(r.delta) + '</td>' +
      '<td class="num">' + fmtCompact(r.total) + '</td>' +
      '<td><div class="fp-bar"><div class="fp-fill ' + (r.delta >= 0 ? 'bull' : 'bear') + '" style="width:' + barW + '%"></div></div></td>' +
      '</tr>';
  }).join('');
  container.innerHTML =
    '<div class="fp-meta">' + data.tradeCount + ' trades · ' + data.windowMin + ' min window · tick ' + fmtPrice(data.tick) +
    ' · ' + data.imbalances.length + ' imbalance(s) · POC ' + (data.poc ? fmtPrice(data.poc.price) : '–') + '</div>' +
    '<p class="hint">Bid/ask volumes are TRADED volume from executed trades — not resting liquidity. ' +
    'Highlighted cells are imbalances ≥ ' + esc(String(data.imbalanceThreshold || 300)) + '% (one side 3x the other).</p>' +
    '<table class="tbl compact"><thead><tr>' +
    '<th>Price</th><th>Bid vol $</th><th>Ask vol $</th><th>Delta $</th><th>Total $</th><th>Volume</th>' +
    '</tr></thead><tbody>' + rowsHtml + '</tbody></table>';
}
