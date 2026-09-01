/**
 * Drawing tools: horizontal, vertical, trend lines
 * TradingView / MetaTrader style
 */

const DEFAULT_FIB_COLOR = '#e3a008';
const DEFAULT_FIB_LEVELS = [
  { ratio: 0, enabled: true },
  { ratio: 0.236, enabled: true },
  { ratio: 0.382, enabled: true },
  { ratio: 0.5, enabled: true },
  { ratio: 0.618, enabled: true },
  { ratio: 0.786, enabled: true },
  { ratio: 1, enabled: true },
];

const FIB_STANDARD_KEY = 'ohlcv-fib-standard';

function factoryFibStandard() {
  return {
    color: DEFAULT_FIB_COLOR,
    levels: DEFAULT_FIB_LEVELS.map((l) => ({ ...l })),
  };
}

function isValidHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function sanitizeFibLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const cleaned = [];
  for (const level of levels) {
    const ratio = Number(level?.ratio);
    if (!Number.isFinite(ratio)) continue;
    cleaned.push({ ratio, enabled: Boolean(level.enabled) });
  }
  return cleaned.length ? cleaned : null;
}

function loadFibStandard() {
  try {
    const raw = localStorage.getItem(FIB_STANDARD_KEY);
    if (!raw) return factoryFibStandard();
    const parsed = JSON.parse(raw);
    const levels = sanitizeFibLevels(parsed.levels);
    const color = isValidHexColor(parsed.color) ? parsed.color : DEFAULT_FIB_COLOR;
    if (!levels) return factoryFibStandard();
    return { color, levels };
  } catch {
    return factoryFibStandard();
  }
}

function saveFibStandard(standard) {
  fibStandard = {
    color: standard.color,
    levels: standard.levels.map((l) => ({ ratio: l.ratio, enabled: l.enabled })),
  };
  localStorage.setItem(FIB_STANDARD_KEY, JSON.stringify(fibStandard));
}

let fibStandard = loadFibStandard();

const LINE_STYLES = {
  solid: { lw: LightweightCharts.LineStyle.Solid, dash: [] },
  dashed: { lw: LightweightCharts.LineStyle.Dashed, dash: [8, 4] },
  dotted: { lw: LightweightCharts.LineStyle.Dotted, dash: [2, 3] },
};

let drawingState = {
  chart: null,
  series: null,
  container: null,
  canvas: null,
  ctx: null,
  drawings: [],
  activeTool: 'cursor',
  selectedId: null,
  pendingPoint: null,
  drag: null,
  helpers: null,
  nextId: 1,
  abortController: null,
  propsPanelExpanded: false,
  snapOverlay: null,
  liveRedrawRaf: null,
  liveRedrawCount: 0,
  wheelRedrawTimer: null,
  dayBoundaryTimes: [],
  candles: [],
  measure: null,
};

function setSnapOverlay(overlay) {
  drawingState.snapOverlay = overlay;
  redrawCanvas();
}

function drawSnapOverlay(ctx) {
  const snap = drawingState.snapOverlay;
  if (!snap || snap.price == null) return;

  const y = priceToY(snap.price);
  if (y == null) return;

  const w = ctx.canvas.width / (window.devicePixelRatio || 1);

  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#f0b429';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = '#f0b429';
  ctx.font = 'bold 11px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Snap: ${snap.label} ${drawingState.helpers?.formatPrice?.(snap.price) ?? snap.price.toFixed(2)}`, 8, y - 4);
  ctx.restore();
}

function applySnapToPoint(time, price) {
  if (typeof snapChartPoint !== 'function') {
    return { time, price, snapped: false };
  }
  const snapped = snapChartPoint(time, price);
  if (snapped.snapped) {
    drawingState.snapOverlay = {
      price: snapped.price,
      field: snapped.field,
      label: snapped.label,
    };
  }
  return snapped;
}

function beginLiveRedrawLoop() {
  if (drawingState.liveRedrawRaf != null) return;
  const tick = () => {
    redrawCanvas();
    drawingState.liveRedrawRaf = requestAnimationFrame(tick);
  };
  drawingState.liveRedrawRaf = requestAnimationFrame(tick);
}

function endLiveRedrawLoop() {
  if (drawingState.liveRedrawRaf != null) {
    cancelAnimationFrame(drawingState.liveRedrawRaf);
    drawingState.liveRedrawRaf = null;
  }
  redrawCanvas();
}

function schedulePostInteractionRedraw(frames = 24) {
  let n = 0;
  const step = () => {
    redrawCanvas();
    if (++n < frames) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function startLiveRedraw() {
  drawingState.liveRedrawCount++;
  if (drawingState.liveRedrawCount === 1) beginLiveRedrawLoop();
}

function stopLiveRedraw() {
  drawingState.liveRedrawCount = Math.max(0, drawingState.liveRedrawCount - 1);
  if (drawingState.liveRedrawCount === 0) {
    endLiveRedrawLoop();
    schedulePostInteractionRedraw();
  }
}

function bindChartSyncRedraw(container, signal) {
  container.addEventListener(
    'mousedown',
    () => startLiveRedraw(),
    { capture: true, signal },
  );

  window.addEventListener('mouseup', () => stopLiveRedraw(), { signal });

  container.addEventListener(
    'wheel',
    () => {
      startLiveRedraw();
      clearTimeout(drawingState.wheelRedrawTimer);
      drawingState.wheelRedrawTimer = setTimeout(() => stopLiveRedraw(), 120);
    },
    { passive: true, signal },
  );
}

function createDrawing(type, defaults = {}) {
  const base = {
    id: drawingState.nextId++,
    type,
    color: defaults.color || '#58a6ff',
    style: defaults.style || 'solid',
    priceLineRef: null,
  };

  if (type === 'horizontal') {
    return { ...base, price: defaults.price ?? 0 };
  }
  if (type === 'vertical') {
    return { ...base, time: defaults.time ?? 0 };
  }
  if (type === 'fibonacci') {
    return {
      ...base,
      color: defaults.color || fibStandard.color,
      p1: defaults.p1 ?? { time: 0, price: 0 },
      p2: defaults.p2 ?? { time: 0, price: 0 },
      levels: (defaults.levels ?? fibStandard.levels).map((l) => ({ ...l })),
    };
  }
  return {
    ...base,
    p1: defaults.p1 ?? { time: 0, price: 0 },
    p2: defaults.p2 ?? { time: 0, price: 0 },
  };
}

function getDrawingById(id) {
  return drawingState.drawings.find((d) => d.id === id) ?? null;
}

function timeToX(time) {
  return drawingState.chart.timeScale().timeToCoordinate(time);
}

function priceToY(price) {
  return drawingState.series.priceToCoordinate(price);
}

function xToTime(x) {
  return drawingState.chart.timeScale().coordinateToTime(x);
}

function yToPrice(y) {
  return drawingState.series.coordinateToPrice(y);
}

function snapPrice(price) {
  if (price == null || isNaN(price)) return 0;
  return Math.round(price * 100) / 100;
}

function findCandleIndex(time) {
  const candles = drawingState.candles;
  if (!candles?.length || time == null) return -1;
  let lo = 0;
  let hi = candles.length - 1;
  if (time <= candles[0].time) return 0;
  if (time >= candles[hi].time) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(candles[lo - 1].time - time) <= Math.abs(candles[lo].time - time)) {
    return lo - 1;
  }
  return lo;
}

function startMeasure(pt) {
  const index = findCandleIndex(pt.time);
  drawingState.measure = {
    dragging: true,
    start: { time: pt.time, price: pt.price, index },
    end: { time: pt.time, price: pt.price, index },
  };
  redrawCanvas();
}

function updateMeasure(pt) {
  if (!drawingState.measure) return;
  drawingState.measure.end = {
    time: pt.time,
    price: pt.price,
    index: findCandleIndex(pt.time),
  };
  redrawCanvas();
}

function clearMeasure() {
  drawingState.measure = null;
}

function drawMeasureOverlay(ctx) {
  const measure = drawingState.measure;
  if (!measure?.start || !measure?.end) return;

  const x1 = timeToX(measure.start.time);
  const y1 = priceToY(measure.start.price);
  const x2 = timeToX(measure.end.time);
  const y2 = priceToY(measure.end.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return;

  const priceDelta = measure.end.price - measure.start.price;
  const isUp = priceDelta >= 0;
  const color = isUp ? '#3fb950' : '#f85149';
  const bars = (measure.start.index >= 0 && measure.end.index >= 0)
    ? Math.abs(measure.end.index - measure.start.index)
    : 0;
  const pct = measure.start.price !== 0
    ? (priceDelta / measure.start.price) * 100
    : 0;
  const fmt = drawingState.helpers?.formatPrice ?? ((v) => v.toFixed(2));
  const sign = priceDelta >= 0 ? '+' : '';
  const line1 = `${sign}${fmt(priceDelta)}  (${sign}${pct.toFixed(2)}%)`;
  const line2 = `${bars} ${bars === 1 ? 'candle' : 'candles'}`;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  ctx.save();
  ctx.fillStyle = isUp ? '#3fb95022' : '#f8514922';
  ctx.fillRect(left, top, width, height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(left, top, width, height);

  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(x1, y1, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x2, y2, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  const padX = 8;
  const padY = 6;
  const textW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
  const boxW = textW + padX * 2;
  const boxH = 38;
  const dpr = window.devicePixelRatio || 1;
  const canvasW = ctx.canvas.width / dpr;
  const canvasH = ctx.canvas.height / dpr;
  let boxX = x2 + 12;
  let boxY = y2 - boxH / 2;
  if (boxX + boxW > canvasW - 8) boxX = x2 - 12 - boxW;
  if (boxX < 8) boxX = 8;
  if (boxY < 8) boxY = 8;
  if (boxY + boxH > canvasH - 8) boxY = canvasH - boxH - 8;

  ctx.fillStyle = '#161b22ee';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect?.(boxX, boxY, boxW, boxH, 4);
  if (!ctx.roundRect) {
    ctx.rect(boxX, boxY, boxW, boxH);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.fillText(line1, boxX + padX, boxY + padY);
  ctx.fillStyle = '#e6edf3';
  ctx.fillText(line2, boxX + padX, boxY + padY + 16);
  ctx.restore();
}

function cloneFibLevels(levels) {
  return levels.map((l) => ({ ratio: l.ratio, enabled: l.enabled }));
}

function getFibLevelPrice(drawing, ratio) {
  return drawing.p1.price + (drawing.p2.price - drawing.p1.price) * ratio;
}

function formatFibRatio(ratio) {
  const pct = ratio * 100;
  if (Math.abs(pct - Math.round(pct)) < 0.001) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}

function getFibBounds(drawing) {
  const x1 = timeToX(drawing.p1.time);
  const x2 = timeToX(drawing.p2.time);
  if (x1 == null || x2 == null) return null;
  return { left: Math.min(x1, x2), right: Math.max(x1, x2) };
}

function applyCanvasStroke(ctx, drawing) {
  ctx.strokeStyle = drawing.color;
  ctx.lineWidth = drawing.selected ? 2.5 : 1.5;
  ctx.setLineDash(LINE_STYLES[drawing.style]?.dash ?? []);
}

function syncHorizontalPriceLine(drawing) {
  if (drawing.priceLineRef) {
    drawingState.series.removePriceLine(drawing.priceLineRef);
    drawing.priceLineRef = null;
  }
  drawing.priceLineRef = drawingState.series.createPriceLine({
    price: drawing.price,
    color: drawing.color,
    lineWidth: drawing.selected ? 2 : 1,
    lineStyle: LINE_STYLES[drawing.style].lw,
    axisLabelVisible: true,
    title: '',
  });
}

function syncAllHorizontalPriceLines() {
  for (const d of drawingState.drawings) {
    if (d.type === 'horizontal') syncHorizontalPriceLine(d);
  }
}

function utcDayKey(unixSec) {
  const d = new Date(unixSec * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function computeDayBoundaryTimes(candles) {
  const times = [];
  let prevDay = null;
  for (const candle of candles) {
    const day = utcDayKey(candle.time);
    if (prevDay != null && day !== prevDay) times.push(candle.time);
    prevDay = day;
  }
  return times;
}

function drawDaySeparators(ctx) {
  const times = drawingState.dayBoundaryTimes;
  if (!times.length || !drawingState.chart) return;

  const dpr = window.devicePixelRatio || 1;
  const height = ctx.canvas.height / dpr;

  ctx.save();
  ctx.strokeStyle = '#6e7681';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.7;

  for (const time of times) {
    const x = timeToX(time);
    if (x == null) continue;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.restore();
}

function redrawCanvas() {
  const { canvas, ctx, drawings } = drawingState;
  if (!canvas || !ctx || !drawingState.chart) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  drawDaySeparators(ctx);

  for (const d of drawings) {
    if (d.type === 'vertical') drawVertical(ctx, d);
    if (d.type === 'trend') drawTrend(ctx, d);
    if (d.type === 'fibonacci') drawFibonacci(ctx, d);
    if (d.selected) drawHandles(ctx, d);
  }

  const pendingTools = ['trend', 'fibonacci'];
  if (drawingState.pendingPoint && pendingTools.includes(drawingState.activeTool)) {
    ctx.beginPath();
    ctx.strokeStyle = '#58a6ff80';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const x1 = timeToX(drawingState.pendingPoint.time);
    const y1 = priceToY(drawingState.pendingPoint.price);
    if (x1 != null && y1 != null) {
      ctx.arc(x1, y1, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawMeasureOverlay(ctx);
  drawSnapOverlay(ctx);
}

function drawVertical(ctx, drawing) {
  const x = timeToX(drawing.time);
  if (x == null) return;
  const dpr = window.devicePixelRatio || 1;
  const height = ctx.canvas.height / dpr;
  ctx.beginPath();
  applyCanvasStroke(ctx, drawing);
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}

function drawTrend(ctx, drawing) {
  const x1 = timeToX(drawing.p1.time);
  const y1 = priceToY(drawing.p1.price);
  const x2 = timeToX(drawing.p2.time);
  const y2 = priceToY(drawing.p2.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return;

  const w = ctx.canvas.width;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;

  let sx, sy, ex, ey;
  if (Math.abs(dx) < 0.001) {
    sx = x1; sy = 0; ex = x1; ey = ctx.canvas.height;
  } else {
    const slope = dy / dx;
    sx = 0;
    sy = y1 + slope * (0 - x1);
    ex = w;
    ey = y1 + slope * (w - x1);
  }

  ctx.beginPath();
  applyCanvasStroke(ctx, drawing);
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
}

function drawFibonacci(ctx, drawing) {
  const x1 = timeToX(drawing.p1.time);
  const y1 = priceToY(drawing.p1.price);
  const x2 = timeToX(drawing.p2.time);
  const y2 = priceToY(drawing.p2.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return;

  const bounds = getFibBounds(drawing);
  if (!bounds) return;

  const { left, right } = bounds;
  const fmt = drawingState.helpers?.formatPrice ?? ((v) => v.toFixed(2));

  ctx.setLineDash([]);
  ctx.strokeStyle = drawing.color + '90';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = drawing.color + '60';
  ctx.beginPath();
  ctx.moveTo(left, y1);
  ctx.lineTo(right, y1);
  ctx.moveTo(left, y2);
  ctx.lineTo(right, y2);
  ctx.stroke();

  for (const level of drawing.levels) {
    if (!level.enabled) continue;
    const price = getFibLevelPrice(drawing, level.ratio);
    const y = priceToY(price);
    if (y == null) continue;

    ctx.beginPath();
    applyCanvasStroke(ctx, drawing);
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = drawing.color;
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = `${formatFibRatio(level.ratio)} (${fmt(price)})`;
    ctx.fillText(label, left + 4, y - 8);
  }
}

function drawHandles(ctx, drawing) {
  const points = getHandlePoints(drawing);
  for (const pt of points) {
    if (pt.x == null || pt.y == null) continue;
    ctx.beginPath();
    ctx.fillStyle = drawing.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function getHandlePoints(drawing) {
  if (drawing.type === 'horizontal') {
    const y = priceToY(drawing.price);
    return [{ x: 40, y, handle: 'price' }];
  }
  if (drawing.type === 'vertical') {
    const x = timeToX(drawing.time);
    return [{ x, y: 40, handle: 'time' }];
  }
  if (drawing.type === 'fibonacci' || drawing.type === 'trend') {
    return [
      { x: timeToX(drawing.p1.time), y: priceToY(drawing.p1.price), handle: 'p1' },
      { x: timeToX(drawing.p2.time), y: priceToY(drawing.p2.price), handle: 'p2' },
    ];
  }
  return [];
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTest(x, y) {
  const threshold = 7;
  let best = null;
  let bestDist = threshold;

  for (let i = drawingState.drawings.length - 1; i >= 0; i--) {
    const d = drawingState.drawings[i];

    if (d.type === 'horizontal') {
      const ly = priceToY(d.price);
      if (ly != null && Math.abs(y - ly) < bestDist) {
        best = d;
        bestDist = Math.abs(y - ly);
      }
    } else if (d.type === 'vertical') {
      const lx = timeToX(d.time);
      if (lx != null && Math.abs(x - lx) < bestDist) {
        best = d;
        bestDist = Math.abs(x - lx);
      }
    } else if (d.type === 'trend') {
      const x1 = timeToX(d.p1.time);
      const y1 = priceToY(d.p1.price);
      const x2 = timeToX(d.p2.time);
      const y2 = priceToY(d.p2.price);
      if (x1 != null && y1 != null && x2 != null && y2 != null) {
        const dist = distToSegment(x, y, x1, y1, x2, y2);
        if (dist < bestDist) {
          best = d;
          bestDist = dist;
        }
      }
    } else if (d.type === 'fibonacci') {
      const bounds = getFibBounds(d);
      if (!bounds || x < bounds.left - threshold || x > bounds.right + threshold) continue;
      for (const level of d.levels) {
        if (!level.enabled) continue;
        const ly = priceToY(getFibLevelPrice(d, level.ratio));
        if (ly != null && Math.abs(y - ly) < bestDist) {
          best = d;
          bestDist = Math.abs(y - ly);
        }
      }
    }
  }

  return best;
}

function hitTestHandle(x, y, drawing) {
  if (!drawing) return null;
  for (const pt of getHandlePoints(drawing)) {
    if (pt.x == null || pt.y == null) continue;
    if (Math.hypot(x - pt.x, y - pt.y) < 8) return pt.handle;
  }
  return null;
}

function selectDrawing(id) {
  for (const d of drawingState.drawings) {
    d.selected = d.id === id;
  }
  drawingState.selectedId = id;
  syncAllHorizontalPriceLines();
  redrawCanvas();
  updatePropsPanel();
  if (id != null) setPropsPanelExpanded(true);
}

function deleteSelectedDrawing() {
  if (!drawingState.selectedId) return;
  const idx = drawingState.drawings.findIndex((d) => d.id === drawingState.selectedId);
  if (idx === -1) return;
  const d = drawingState.drawings[idx];
  if (d.priceLineRef) {
    drawingState.series.removePriceLine(d.priceLineRef);
  }
  drawingState.drawings.splice(idx, 1);
  drawingState.selectedId = null;
  redrawCanvas();
  updatePropsPanel();
}

function addDrawing(drawing) {
  drawing.selected = true;
  for (const d of drawingState.drawings) {
    if (d.id !== drawing.id) d.selected = false;
  }
  if (drawing.type === 'horizontal') syncHorizontalPriceLine(drawing);
  drawingState.drawings.push(drawing);
  drawingState.selectedId = drawing.id;
  redrawCanvas();
  updatePropsPanel();
  setPropsPanelExpanded(true);
}

function setActiveTool(tool) {
  drawingState.activeTool = tool;
  drawingState.pendingPoint = null;
  if (tool !== 'crosshair') clearMeasure();
  document.querySelectorAll('.draw-tool-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  drawingState.canvas.style.pointerEvents = 'none';
  drawingState.canvas.style.cursor = tool === 'cursor' ? 'default' : 'crosshair';
  drawingState.container.style.cursor = tool === 'cursor' ? 'default' : 'crosshair';
}

function chartPointFromEvent(e) {
  const rect = drawingState.container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const time = xToTime(x);
  const rawPrice = yToPrice(y);
  const snapped = applySnapToPoint(time, snapPrice(rawPrice));

  return {
    x,
    y,
    time: snapped.time,
    price: snapPrice(snapped.price),
    snapped: snapped.snapped,
    snapField: snapped.field,
  };
}

function onContainerMouseDown(e) {
  if (!drawingState.chart) return;
  if (e.target.closest?.('.date-jump-bar')) return;
  const tool = drawingState.activeTool;
  const pt = chartPointFromEvent(e);

  if (tool === 'cursor') {
    const selected = getDrawingById(drawingState.selectedId);
    const handle = hitTestHandle(pt.x, pt.y, selected);
    if (handle) {
      drawingState.drag = { id: selected.id, handle, startX: pt.x, startY: pt.y };
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const hit = hitTest(pt.x, pt.y);
    if (hit) {
      selectDrawing(hit.id);
      drawingState.drag = { id: hit.id, handle: 'move', startX: pt.x, startY: pt.y, snapshot: cloneDrawing(hit) };
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    selectDrawing(null);
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  if (pt.time == null || pt.price == null) return;

  if (tool === 'horizontal') {
    addDrawing(createDrawing('horizontal', { price: pt.price }));
    setActiveTool('cursor');
    return;
  }

  if (tool === 'vertical') {
    addDrawing(createDrawing('vertical', { time: pt.time }));
    setActiveTool('cursor');
    return;
  }

  if (tool === 'crosshair') {
    startMeasure(pt);
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (tool === 'trend' || tool === 'fibonacci') {
    if (!drawingState.pendingPoint) {
      drawingState.pendingPoint = { time: pt.time, price: pt.price };
      redrawCanvas();
    } else {
      const type = tool === 'fibonacci' ? 'fibonacci' : 'trend';
      addDrawing(
        createDrawing(type, {
          p1: drawingState.pendingPoint,
          p2: { time: pt.time, price: pt.price },
        }),
      );
      drawingState.pendingPoint = null;
      setActiveTool('cursor');
    }
    return;
  }
}

function cloneDrawing(d) {
  if (d.type === 'trend' || d.type === 'fibonacci') {
    const clone = { p1: { ...d.p1 }, p2: { ...d.p2 } };
    if (d.type === 'fibonacci') clone.levels = cloneFibLevels(d.levels);
    return clone;
  }
  return JSON.parse(JSON.stringify(d));
}

function onContainerMouseMove(e) {
  if (drawingState.measure?.dragging) {
    const pt = chartPointFromEvent(e);
    if (pt.time != null && pt.price != null) updateMeasure(pt);
    return;
  }
  if (!drawingState.drag) {
    if (!isCtrlSnapActive()) {
      if (drawingState.snapOverlay) {
        drawingState.snapOverlay = null;
        redrawCanvas();
      }
    }
    return;
  }
  const pt = chartPointFromEvent(e);
  const d = getDrawingById(drawingState.drag.id);
  if (!d || pt.time == null || pt.price == null) return;

  const { handle, snapshot } = drawingState.drag;

  if (d.type === 'horizontal') {
    if (handle === 'price' || handle === 'move') d.price = pt.price;
  } else if (d.type === 'vertical') {
    if (handle === 'time' || handle === 'move') d.time = pt.time;
  } else if (d.type === 'trend' || d.type === 'fibonacci') {
    if (handle === 'p1') {
      d.p1 = { time: pt.time, price: pt.price };
    } else if (handle === 'p2') {
      d.p2 = { time: pt.time, price: pt.price };
    } else if (handle === 'move' && snapshot) {
      const startTime = xToTime(drawingState.drag.startX);
      const startPrice = yToPrice(drawingState.drag.startY);
      if (startTime != null && pt.time != null) {
        const dt = pt.time - startTime;
        const dp = pt.price - startPrice;
        d.p1 = { time: snapshot.p1.time + dt, price: snapPrice(snapshot.p1.price + dp) };
        d.p2 = { time: snapshot.p2.time + dt, price: snapPrice(snapshot.p2.price + dp) };
      }
    }
  }

  if (d.type === 'horizontal') syncHorizontalPriceLine(d);
  redrawCanvas();
  updatePropsPanel();
}

function onContainerMouseUp() {
  if (drawingState.measure?.dragging) {
    drawingState.measure.dragging = false;
  }
  drawingState.drag = null;
}

function resizeCanvas() {
  const container = drawingState.container;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  drawingState.canvas.width = rect.width * dpr;
  drawingState.canvas.height = rect.height * dpr;
  drawingState.canvas.style.width = `${rect.width}px`;
  drawingState.canvas.style.height = `${rect.height}px`;
  drawingState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawCanvas();
}

function setPropsPanelExpanded(expanded) {
  drawingState.propsPanelExpanded = expanded;
  const sidebar = document.getElementById('drawPropsSidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed', !expanded);
  const toggle = document.getElementById('drawPropsToggle');
  if (toggle) {
    toggle.title = expanded ? 'Hide properties panel' : 'Show properties panel';
  }
  requestAnimationFrame(() => {
    if (drawingState.container && drawingState.chart) {
      const { width, height } = drawingState.container.getBoundingClientRect();
      drawingState.chart.applyOptions({ width, height });
    }
    resizeCanvas();
  });
}

function togglePropsPanel() {
  setPropsPanelExpanded(!drawingState.propsPanelExpanded);
}

function showPropsSidebar() {
  document.getElementById('drawPropsSidebar')?.classList.remove('hidden');
}

function hidePropsSidebar() {
  document.getElementById('drawPropsSidebar')?.classList.add('hidden');
}

function updatePropsPanel() {
  const d = getDrawingById(drawingState.selectedId);
  const emptyState = document.getElementById('propEmptyState');
  const content = document.getElementById('propContent');
  const deleteBtn = document.getElementById('propDeleteBtn');

  if (!d) {
    emptyState?.classList.remove('hidden');
    content?.classList.add('hidden');
    deleteBtn?.classList.add('hidden');
    return;
  }

  emptyState?.classList.add('hidden');
  content?.classList.remove('hidden');
  deleteBtn?.classList.remove('hidden');

  document.getElementById('propColor').value = d.color;
  document.getElementById('propStyle').value = d.style;

  const priceGroup = document.getElementById('propPriceGroup');
  const timeGroup = document.getElementById('propTimeGroup');
  const trendGroup = document.getElementById('propTrendGroup');
  const fibGroup = document.getElementById('propFibGroup');

  priceGroup.classList.toggle('hidden', d.type !== 'horizontal');
  timeGroup.classList.toggle('hidden', d.type !== 'vertical');
  trendGroup.classList.toggle('hidden', d.type !== 'trend');
  fibGroup.classList.toggle('hidden', d.type !== 'fibonacci');

  if (d.type === 'horizontal') {
    document.getElementById('propPrice').value = d.price.toFixed(2);
  }
  if (d.type === 'vertical') {
    document.getElementById('propDateTime').value = drawingState.helpers.toInputDateTime(d.time);
  }
  if (d.type === 'trend') {
    document.getElementById('propP1Price').value = d.p1.price.toFixed(2);
    document.getElementById('propP2Price').value = d.p2.price.toFixed(2);
    document.getElementById('propP1DateTime').value = drawingState.helpers.toInputDateTime(d.p1.time);
    document.getElementById('propP2DateTime').value = drawingState.helpers.toInputDateTime(d.p2.time);
  }
  if (d.type === 'fibonacci') {
    document.getElementById('propFibP1Price').value = d.p1.price.toFixed(2);
    document.getElementById('propFibP2Price').value = d.p2.price.toFixed(2);
    document.getElementById('propFibP1DateTime').value = drawingState.helpers.toInputDateTime(d.p1.time);
    document.getElementById('propFibP2DateTime').value = drawingState.helpers.toInputDateTime(d.p2.time);
    renderFibLevelsPanel(d);
  }
}

function renderFibLevelsPanel(drawing) {
  const container = document.getElementById('propFibLevels');
  container.innerHTML = '';
  drawing.levels.forEach((level, index) => {
    const row = document.createElement('div');
    row.className = 'fib-level-row';
    row.dataset.index = index;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = level.enabled;
    checkbox.title = 'Enabled';

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '-500';
    input.max = '500';
    input.value = (level.ratio * 100).toFixed(1);
    input.title = 'Level %';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'fib-level-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove level';

    checkbox.addEventListener('change', applyPropsFromPanel);
    input.addEventListener('change', applyPropsFromPanel);
    input.addEventListener('input', applyPropsFromPanel);
    removeBtn.addEventListener('click', () => {
      if (drawing.levels.length <= 1) return;
      drawing.levels.splice(index, 1);
      renderFibLevelsPanel(drawing);
      redrawCanvas();
    });

    row.appendChild(checkbox);
    row.appendChild(input);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

function readFibLevelsFromPanel(drawing) {
  const rows = document.querySelectorAll('#propFibLevels .fib-level-row');
  const levels = [];
  rows.forEach((row) => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    const input = row.querySelector('input[type="number"]');
    const ratio = parseFloat(input.value) / 100;
    if (isNaN(ratio)) return;
    levels.push({ ratio, enabled: checkbox.checked });
  });
  levels.sort((a, b) => a.ratio - b.ratio);
  drawing.levels = levels;
}

function applyPropsFromPanel() {
  const d = getDrawingById(drawingState.selectedId);
  if (!d) return;

  d.color = document.getElementById('propColor').value;
  d.style = document.getElementById('propStyle').value;

  if (d.type === 'horizontal') {
    d.price = snapPrice(parseFloat(document.getElementById('propPrice').value));
  }
  if (d.type === 'vertical') {
    d.time = drawingState.helpers.fromInputDateTime(document.getElementById('propDateTime').value);
  }
  if (d.type === 'trend') {
    d.p1.price = snapPrice(parseFloat(document.getElementById('propP1Price').value));
    d.p2.price = snapPrice(parseFloat(document.getElementById('propP2Price').value));
    d.p1.time = drawingState.helpers.fromInputDateTime(document.getElementById('propP1DateTime').value);
    d.p2.time = drawingState.helpers.fromInputDateTime(document.getElementById('propP2DateTime').value);
  }
  if (d.type === 'fibonacci') {
    d.p1.price = snapPrice(parseFloat(document.getElementById('propFibP1Price').value));
    d.p2.price = snapPrice(parseFloat(document.getElementById('propFibP2Price').value));
    d.p1.time = drawingState.helpers.fromInputDateTime(document.getElementById('propFibP1DateTime').value);
    d.p2.time = drawingState.helpers.fromInputDateTime(document.getElementById('propFibP2DateTime').value);
    readFibLevelsFromPanel(d);
  }

  if (d.type === 'horizontal') syncHorizontalPriceLine(d);
  redrawCanvas();
}

let propsPanelBound = false;

function bindPropsPanel() {
  if (propsPanelBound) return;
  propsPanelBound = true;
  document.querySelectorAll('#drawPropsPanel input, #drawPropsPanel select').forEach((el) => {
    el.addEventListener('change', applyPropsFromPanel);
    el.addEventListener('input', applyPropsFromPanel);
  });
  document.getElementById('propDeleteBtn').addEventListener('click', deleteSelectedDrawing);
  document.getElementById('drawPropsToggle').addEventListener('click', togglePropsPanel);
  document.getElementById('propFibAddLevel').addEventListener('click', () => {
    const d = getDrawingById(drawingState.selectedId);
    if (!d || d.type !== 'fibonacci') return;
    d.levels.push({ ratio: 0.5, enabled: true });
    d.levels.sort((a, b) => a.ratio - b.ratio);
    renderFibLevelsPanel(d);
    redrawCanvas();
  });
  document.getElementById('propFibResetLevels').addEventListener('click', () => {
    const d = getDrawingById(drawingState.selectedId);
    if (!d || d.type !== 'fibonacci') return;
    d.levels = cloneFibLevels(DEFAULT_FIB_LEVELS);
    renderFibLevelsPanel(d);
    redrawCanvas();
  });
  document.getElementById('propFibSaveStandard').addEventListener('click', () => {
    const d = getDrawingById(drawingState.selectedId);
    if (!d || d.type !== 'fibonacci') return;
    applyPropsFromPanel();
    saveFibStandard({ color: d.color, levels: d.levels });
    const btn = document.getElementById('propFibSaveStandard');
    const original = btn.textContent;
    btn.textContent = 'Saved';
    setTimeout(() => {
      btn.textContent = original;
    }, 1200);
  });
  document.querySelectorAll('.draw-tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
  });
}

function initDrawings(chart, series, helpers, candles = []) {
  destroyDrawings();

  const container = document.getElementById('chartContainer');
  drawingState.chart = chart;
  drawingState.series = series;
  drawingState.helpers = helpers;
  drawingState.container = container;
  drawingState.dayBoundaryTimes = computeDayBoundaryTimes(candles);
  drawingState.candles = candles;

  const canvas = document.createElement('canvas');
  canvas.id = 'drawCanvas';
  canvas.className = 'draw-canvas';
  container.appendChild(canvas);

  drawingState.canvas = canvas;
  drawingState.ctx = canvas.getContext('2d');

  drawingState.abortController = new AbortController();
  const signal = drawingState.abortController.signal;
  container.addEventListener('mousedown', onContainerMouseDown, { capture: true, signal });
  window.addEventListener('mousemove', onContainerMouseMove, { signal });
  window.addEventListener('mouseup', onContainerMouseUp, { signal });

  chart.timeScale().subscribeVisibleLogicalRangeChange(redrawCanvas);
  chart.subscribeCrosshairMove(redrawCanvas);
  bindChartSyncRedraw(container, signal);

  resizeCanvas();
  bindPropsPanel();
  showPropsSidebar();
  setPropsPanelExpanded(false);
  setActiveTool('cursor');

  if (!drawingState.resizeObs) {
    drawingState.resizeObs = new ResizeObserver(resizeCanvas);
    drawingState.resizeObs.observe(container);
  }
}

function destroyDrawings() {
  drawingState.abortController?.abort();
  drawingState.abortController = null;
  clearTimeout(drawingState.wheelRedrawTimer);
  drawingState.wheelRedrawTimer = null;
  drawingState.liveRedrawCount = 0;
  endLiveRedrawLoop();
  if (drawingState.resizeObs) {
    drawingState.resizeObs.disconnect();
    drawingState.resizeObs = null;
  }
  for (const d of drawingState.drawings) {
    if (d.priceLineRef && drawingState.series) {
      try { drawingState.series.removePriceLine(d.priceLineRef); } catch (_) {}
    }
  }
  drawingState.drawings = [];
  drawingState.selectedId = null;
  drawingState.pendingPoint = null;
  drawingState.drag = null;

  const canvas = document.getElementById('drawCanvas');
  if (canvas) canvas.remove();

  drawingState.canvas = null;
  drawingState.ctx = null;
  drawingState.chart = null;
  drawingState.series = null;
  drawingState.container = null;
  drawingState.dayBoundaryTimes = [];
  drawingState.candles = [];
  drawingState.measure = null;

  hidePropsSidebar();
  setPropsPanelExpanded(false);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    drawingState.pendingPoint = null;
    clearMeasure();
    setActiveTool('cursor');
    redrawCanvas();
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && drawingState.selectedId) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    deleteSelectedDrawing();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'Control') setSnapOverlay(null);
});
