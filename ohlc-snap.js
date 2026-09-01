/**
 * Ctrl + snap to OHLC (Open, High, Low, Close) — TradingView style
 */

const ohlcSnapState = {
  ctrlPressed: false,
  candles: [],
  candleMap: null,
};

function initOhlcSnap(candles) {
  ohlcSnapState.candles = candles;
  ohlcSnapState.candleMap = new Map(candles.map((c) => [c.time, c]));
}

function clearOhlcSnap() {
  ohlcSnapState.candles = [];
  ohlcSnapState.candleMap = null;
}

function isCtrlSnapActive() {
  return ohlcSnapState.ctrlPressed;
}

function getCandleAtTime(time) {
  if (time == null || !ohlcSnapState.candles.length) return null;

  const exact = ohlcSnapState.candleMap?.get(time);
  if (exact) return exact;

  const candles = ohlcSnapState.candles;
  let lo = 0;
  let hi = candles.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }

  if (lo > 0 && Math.abs(candles[lo - 1].time - time) <= Math.abs(candles[lo].time - time)) {
    return candles[lo - 1];
  }
  return candles[lo];
}

function snapPriceToOHLC(candle, price) {
  if (!candle || price == null || isNaN(price)) return null;

  const fields = [
    { key: 'open', label: 'Open' },
    { key: 'high', label: 'High' },
    { key: 'low', label: 'Low' },
    { key: 'close', label: 'Close' },
  ];

  let best = fields[0];
  let bestPrice = candle[best.key];
  let bestDist = Math.abs(price - bestPrice);

  for (let i = 1; i < fields.length; i++) {
    const f = fields[i];
    const dist = Math.abs(price - candle[f.key]);
    if (dist < bestDist) {
      best = f;
      bestPrice = candle[f.key];
      bestDist = dist;
    }
  }

  return { price: bestPrice, field: best.key, label: best.label, candle };
}

function snapChartPoint(time, price) {
  if (!ohlcSnapState.ctrlPressed || time == null || price == null || isNaN(price)) {
    return { time, price, snapped: false };
  }

  const candle = getCandleAtTime(time);
  if (!candle) return { time, price, snapped: false };

  const snap = snapPriceToOHLC(candle, price);
  if (!snap) return { time, price, snapped: false };

  return {
    time: candle.time,
    price: snap.price,
    snapped: true,
    field: snap.field,
    label: snap.label,
    candle,
  };
}

function setCtrlSnapPressed(pressed) {
  ohlcSnapState.ctrlPressed = pressed;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Control') setCtrlSnapPressed(true);
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Control') setCtrlSnapPressed(false);
});

window.addEventListener('blur', () => setCtrlSnapPressed(false));
