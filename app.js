/**
 * OHLCV Candlestick Chart — Excel upload + TradingView-style crosshair
 */

const COLUMN_ALIASES = {
  datetime: ['datetime', 'datetimestamp', 'timestamp', 'dataora', 'datatime', 'date_time'],
  date: ['date', 'data', 'datum', 'zi'],
  time: ['time', 'ora', 'hour', 'timp'],
  open: ['open', 'deschidere', 'desch', 'o', 'pret deschidere', 'pretdeschidere'],
  high: ['high', 'maxim', 'max', 'h', 'pret maxim', 'pretmaxim'],
  low: ['low', 'minim', 'min', 'l', 'pret minim', 'pretminim'],
  close: ['close', 'inchidere', 'închidere', 'inch', 'c', 'pret inchidere', 'pretinchidere'],
  volume: ['volume', 'vol', 'volum', 'v', 'qty', 'quantity', 'tickvol'],
  spread: ['spread'],
  symbol: ['symbol', 'simbol', 'ticker', 'instrument', 'activ'],
};

const CHART_COLORS = {
  background: '#0d1117',
  text: '#8b949e',
  grid: '#21262d',
  border: '#30363d',
  up: '#3fb950',
  down: '#f85149',
};

let chart = null;
let candleSeries = null;
let volumeSeries = null;
let parsedCandles = [];
let resizeObserver = null;

const els = {
  fileInput: document.getElementById('fileInput'),
  chartContainer: document.getElementById('chartContainer'),
  emptyState: document.getElementById('emptyState'),
  symbolBadge: document.getElementById('symbolBadge'),
  statusText: document.getElementById('statusText'),
  candleCount: document.getElementById('candleCount'),
  infoDate: document.getElementById('infoDate'),
  infoOpen: document.getElementById('infoOpen'),
  infoHigh: document.getElementById('infoHigh'),
  infoLow: document.getElementById('infoLow'),
  infoClose: document.getElementById('infoClose'),
  infoVolume: document.getElementById('infoVolume'),
  infoSpread: document.getElementById('infoSpread'),
  infoChange: document.getElementById('infoChange'),
  dateJumpBar: document.getElementById('dateJumpBar'),
  dateJumpInput: document.getElementById('dateJumpInput'),
  dateJumpTodayBtn: document.getElementById('dateJumpTodayBtn'),
};

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function detectColumn(headers, field) {
  const aliases = COLUMN_ALIASES[field];
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i]);
    if (aliases.includes(h)) return i;
  }
  return -1;
}

/**
 * Convert Excel date/time to a UTC wall-clock timestamp.
 * The time from the file (e.g. 01:05:00) is shown identically on the chart, with no timezone offset.
 */
function parseDateParts(dateStr) {
  const s = String(dateStr).trim();

  let match = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (match) {
    return { year: +match[1], month: +match[2], day: +match[3] };
  }

  match = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if (match) {
    return { year: +match[3], month: +match[2], day: +match[1] };
  }

  match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return { year: +match[1], month: +match[2], day: +match[3] };
  }

  return null;
}

function parseTimeParts(timeValue) {
  if (timeValue == null || timeValue === '') {
    return { hour: 0, minute: 0, second: 0 };
  }

  if (timeValue instanceof Date) {
    return {
      hour: timeValue.getHours(),
      minute: timeValue.getMinutes(),
      second: timeValue.getSeconds(),
    };
  }

  if (typeof timeValue === 'number' && timeValue >= 0 && timeValue < 1) {
    const totalSeconds = Math.round(timeValue * 86400);
    return {
      hour: Math.floor(totalSeconds / 3600),
      minute: Math.floor((totalSeconds % 3600) / 60),
      second: totalSeconds % 60,
    };
  }

  const timeStr = String(timeValue).trim();
  const match = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    return {
      hour: +match[1],
      minute: +match[2],
      second: +(match[3] ?? 0),
    };
  }

  return null;
}

function buildWallClockDate(parts) {
  const { year, month, day, hour, minute, second } = parts;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function excelSerialToWallClockDate(serial) {
  const wholeDays = Math.floor(serial);
  const dayFraction = serial - wholeDays;
  const excelEpochMs = Date.UTC(1899, 11, 30);
  const ms = excelEpochMs + wholeDays * 86400000 + Math.round(dayFraction * 86400000);
  return new Date(ms);
}

function parseDateTime(value, timeValue) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    const parts = {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
      ...parseTimeParts(timeValue),
    };
    if (!timeValue) {
      parts.hour = value.getHours();
      parts.minute = value.getMinutes();
      parts.second = value.getSeconds();
    }
    return buildWallClockDate(parts);
  }

  if (typeof value === 'number' && value > 30000) {
    const serialDate = excelSerialToWallClockDate(value);
    if (timeValue != null && timeValue !== '') {
      const dateParts = parseDateParts(
        `${serialDate.getUTCFullYear()}.${String(serialDate.getUTCMonth() + 1).padStart(2, '0')}.${String(serialDate.getUTCDate()).padStart(2, '0')}`,
      );
      const timeParts = parseTimeParts(timeValue);
      if (dateParts && timeParts) {
        return buildWallClockDate({ ...dateParts, ...timeParts });
      }
    }
    return serialDate;
  }

  const dateParts = parseDateParts(value);
  if (!dateParts) return null;

  const timeParts = parseTimeParts(timeValue);
  if (!timeParts) return null;

  return buildWallClockDate({ ...dateParts, ...timeParts });
}

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function formatDateTime(unixSec) {
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function toInputDateTime(unixSec) {
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function fromInputDateTime(value) {
  if (!value) return 0;
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second = 0] = timePart.split(':').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

const drawingHelpers = { toInputDateTime, fromInputDateTime, formatPrice };

function formatPrice(value) {
  if (value == null || isNaN(value)) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatVolume(value) {
  if (value == null || isNaN(value)) return '—';
  const n = Number(value);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString('en-US');
}

function formatSpread(value) {
  if (value == null || isNaN(value)) return '—';
  const n = Number(value);
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (value == null || value === '') return NaN;
  const cleaned = String(value).replace(/\s/g, '').replace(',', '.');
  return parseFloat(cleaned);
}

function parseSheetRows(rows) {
  if (rows.length < 2) {
    throw new Error('The file must contain at least a header row and one data row.');
  }

  const headers = rows[0].map((h) => String(h ?? ''));

  let colDatetime = detectColumn(headers, 'datetime');
  const colDate = detectColumn(headers, 'date');
  const colTime = detectColumn(headers, 'time');
  const colOpen = detectColumn(headers, 'open');
  const colHigh = detectColumn(headers, 'high');
  const colLow = detectColumn(headers, 'low');
  const colClose = detectColumn(headers, 'close');
  const colVolume = detectColumn(headers, 'volume');
  const colSpread = detectColumn(headers, 'spread');
  const colSymbol = detectColumn(headers, 'symbol');

  if (colDatetime === -1 && colDate === -1) {
    throw new Error('Could not find a date column. Use: Date, DateTime, or Timestamp.');
  }

  const required = [
    ['Open', colOpen],
    ['High', colHigh],
    ['Low', colLow],
    ['Close', colClose],
  ];

  for (const [name, col] of required) {
    if (col === -1) throw new Error(`Could not find column: ${name}`);
  }

  const candles = [];
  let symbol = null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c == null || c === '')) continue;

    let dt;
    if (colDatetime !== -1) {
      dt = parseDateTime(row[colDatetime]);
    } else {
      dt = parseDateTime(row[colDate], colTime !== -1 ? row[colTime] : null);
    }

    if (!dt) continue;

    const open = parseNumber(row[colOpen]);
    const high = parseNumber(row[colHigh]);
    const low = parseNumber(row[colLow]);
    const close = parseNumber(row[colClose]);
    const volume = colVolume !== -1 ? parseNumber(row[colVolume]) : 0;
    const spread = colSpread !== -1 ? parseNumber(row[colSpread]) : NaN;

    if ([open, high, low, close].some(isNaN)) continue;

    if (!symbol && colSymbol !== -1 && row[colSymbol]) {
      symbol = String(row[colSymbol]).trim();
    }

    candles.push({
      time: toUnixSeconds(dt),
      open,
      high,
      low,
      close,
      volume: isNaN(volume) ? 0 : volume,
      spread: isNaN(spread) ? null : spread,
    });
  }

  if (candles.length === 0) {
    throw new Error('Could not parse valid data from the file. Check the column format.');
  }

  candles.sort((a, b) => a.time - b.time);

  const unique = [];
  const seen = new Set();
  for (const c of candles) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    unique.push(c);
  }

  return { candles: unique, symbol };
}

function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
        resolve(parseSheetRows(rows));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Error reading the file.'));
    reader.readAsArrayBuffer(file);
  });
}

function updateInfoBar(candle, snapField = null) {
  if (!candle) {
    els.infoDate.textContent = '—';
    els.infoOpen.textContent = '—';
    els.infoHigh.textContent = '—';
    els.infoLow.textContent = '—';
    els.infoClose.textContent = '—';
    els.infoVolume.textContent = '—';
    els.infoSpread.textContent = '—';
    els.infoChange.textContent = '—';
    els.infoChange.className = 'info-value';
    els.infoClose.className = 'info-value';
    els.infoOpen.className = 'info-value';
    els.infoHigh.className = 'info-value';
    els.infoLow.className = 'info-value';
    return;
  }

  const change = candle.close - candle.open;
  const changePct = candle.open !== 0 ? (change / candle.open) * 100 : 0;
  const isUp = change >= 0;

  els.infoDate.textContent = formatDateTime(candle.time);
  els.infoOpen.textContent = formatPrice(candle.open);
  els.infoHigh.textContent = formatPrice(candle.high);
  els.infoLow.textContent = formatPrice(candle.low);
  els.infoClose.textContent = formatPrice(candle.close);
  els.infoVolume.textContent = formatVolume(candle.volume);
  els.infoSpread.textContent = formatSpread(candle.spread);

  const snapClass = ' snap-highlight';
  els.infoOpen.className = 'info-value' + (snapField === 'open' ? snapClass : '');
  els.infoHigh.className = 'info-value up' + (snapField === 'high' ? snapClass : '');
  els.infoLow.className = 'info-value down' + (snapField === 'low' ? snapClass : '');
  els.infoClose.className = 'info-value ' + (isUp ? 'up' : 'down') + (snapField === 'close' ? snapClass : '');
  els.infoChange.textContent = `${change >= 0 ? '+' : ''}${formatPrice(change)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`;
  els.infoChange.className = 'info-value ' + (isUp ? 'up' : 'down');
}

function destroyChart() {
  destroyDrawings();
  clearOhlcSnap();
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (chart) {
    chart.remove();
    chart = null;
    candleSeries = null;
    volumeSeries = null;
  }
}

function initChart(candles) {
  destroyChart();

  parsedCandles = candles;
  initOhlcSnap(candles);

  chart = LightweightCharts.createChart(els.chartContainer, {
    layout: {
      background: { type: 'solid', color: CHART_COLORS.background },
      textColor: CHART_COLORS.text,
      fontSize: 12,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: {
        color: '#758696',
        width: 1,
        style: LightweightCharts.LineStyle.Dashed,
        labelBackgroundColor: '#30363d',
      },
      horzLine: {
        color: '#758696',
        width: 1,
        style: LightweightCharts.LineStyle.Dashed,
        labelBackgroundColor: '#30363d',
      },
    },
    rightPriceScale: {
      borderColor: CHART_COLORS.border,
      scaleMargins: { top: 0.05, bottom: 0.25 },
    },
    timeScale: {
      borderColor: CHART_COLORS.border,
      timeVisible: true,
      secondsVisible: true,
      rightOffset: 5,
      barSpacing: 8,
    },
    localization: {
      locale: 'en-US',
      priceFormatter: formatPrice,
    },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: CHART_COLORS.up,
    downColor: CHART_COLORS.down,
    borderUpColor: CHART_COLORS.up,
    borderDownColor: CHART_COLORS.red,
    wickUpColor: CHART_COLORS.up,
    wickDownColor: CHART_COLORS.red,
  });

  volumeSeries = chart.addHistogramSeries({
    color: '#26a69a80',
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });

  chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
    borderVisible: false,
  });

  const candleData = candles.map(({ time, open, high, low, close }) => ({
    time,
    open,
    high,
    low,
    close,
  }));

  const volumeData = candles.map(({ time, open, close, volume }) => ({
    time,
    value: volume,
    color: close >= open ? '#3fb95060' : '#f8514960',
  }));

  candleSeries.setData(candleData);
  volumeSeries.setData(volumeData);
  chart.timeScale().fitContent();

  const candleMap = new Map(candles.map((c) => [c.time, c]));

  chart.subscribeCrosshairMove((param) => {
    if (!param.time) {
      updateInfoBar(null);
      setSnapOverlay(null);
      return;
    }

    const candle = candleMap.get(param.time) ?? getCandleAtTime(param.time);
    if (!candle) {
      updateInfoBar(null);
      setSnapOverlay(null);
      return;
    }

    if (isCtrlSnapActive() && param.point) {
      const rawPrice = candleSeries.coordinateToPrice(param.point.y);
      const snap = snapPriceToOHLC(candle, rawPrice);
      if (snap) {
        updateInfoBar(candle, snap.field);
        setSnapOverlay({
          price: snap.price,
          field: snap.field,
          label: snap.label,
        });
        return;
      }
    }

    setSnapOverlay(null);
    updateInfoBar(candle);
  });

  if (candles.length > 0) {
    updateInfoBar(candles[candles.length - 1]);
  }

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      chart.applyOptions({ width, height });
    }
  });
  resizeObserver.observe(els.chartContainer);

  initDrawings(chart, candleSeries, drawingHelpers, candles);
}

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function parseJumpDate(text) {
  const s = String(text ?? '').trim();
  let match = s.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  let year;
  let month;
  let day;

  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
    if (!match) return null;
    year = 2000 + Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }

  if (!isValidCalendarDate(year, month, day)) return null;
  return { year, month, day };
}

function getVisibleBarCount() {
  const range = chart?.timeScale().getVisibleLogicalRange();
  if (!range || range.to <= range.from) return 80;
  return range.to - range.from;
}

function jumpToCandleIndex(index) {
  if (!chart || index < 0 || index >= parsedCandles.length) return;
  const span = getVisibleBarCount();
  chart.timeScale().setVisibleLogicalRange({
    from: index,
    to: index + span,
  });
}

function jumpToCalendarDate(year, month, day) {
  const start = Math.floor(Date.UTC(year, month - 1, day) / 1000);
  const end = Math.floor(Date.UTC(year, month - 1, day + 1) / 1000);
  const index = parsedCandles.findIndex((c) => c.time >= start && c.time < end);
  if (index === -1) return false;
  jumpToCandleIndex(index);
  return true;
}

function jumpToLatestDay() {
  if (!chart || parsedCandles.length === 0) return;
  const last = parsedCandles[parsedCandles.length - 1];
  const d = new Date(last.time * 1000);
  jumpToCalendarDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function onDateJumpSubmit() {
  const parsed = parseJumpDate(els.dateJumpInput.value);
  if (!parsed) return;
  jumpToCalendarDate(parsed.year, parsed.month, parsed.day);
}

function extractSymbolFromFilename(filename) {
  const base = filename.replace(/\.(xlsx|xls|csv)$/i, '');
  const match = base.match(/([A-Z]{2,10}\d*)/i);
  return match ? match[1].toUpperCase() : base.slice(0, 20);
}

async function handleFile(file) {
  if (!file) return;

    els.statusText.textContent = `Processing ${file.name}…`;

  try {
    const { candles, symbol } = await readExcelFile(file);
    const displaySymbol = symbol || extractSymbolFromFilename(file.name);

    els.symbolBadge.textContent = displaySymbol;
    els.candleCount.textContent = `${candles.length.toLocaleString('en-US')} candles`;
    els.statusText.textContent = `Loaded: ${file.name}`;

    els.emptyState.classList.add('hidden');
    els.chartContainer.classList.add('visible');

    initChart(candles);
  } catch (err) {
    els.statusText.textContent = `Error: ${err.message}`;
    console.error(err);
    alert(`Error processing file:\n\n${err.message}`);
  }
}

els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  handleFile(file);
  e.target.value = '';
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

window.addEventListener('beforeunload', destroyChart);

els.dateJumpBar.addEventListener('mousedown', (e) => e.stopPropagation());
els.dateJumpInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  e.stopPropagation();
  onDateJumpSubmit();
});
els.dateJumpTodayBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  jumpToLatestDay();
});

let spaceHeld = false;

function isFormField(el) {
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function setSpaceHeld(held) {
  spaceHeld = held;
  els.chartContainer?.classList.toggle('space-panning', held);
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (isFormField(document.activeElement)) return;
  e.preventDefault();
  setSpaceHeld(true);
});

document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  setSpaceHeld(false);
});

window.addEventListener('blur', () => setSpaceHeld(false));

els.chartContainer.addEventListener(
  'wheel',
  (e) => {
    if (!spaceHeld || !chart) return;
    e.preventDefault();
    e.stopPropagation();

    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;

    const span = range.to - range.from;
    if (span <= 0) return;

    const bars = (span * 0.12) * (e.deltaY / 100);
    timeScale.setVisibleLogicalRange({
      from: range.from - bars,
      to: range.to - bars,
    });
  },
  { capture: true, passive: false },
);
