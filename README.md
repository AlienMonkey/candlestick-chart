# OHLCV Candlestick Chart

Web app for viewing financial data from Excel as a candlestick chart (similar to TradingView / MetaTrader).

## Features

- Upload **.xlsx**, **.xls**, **.csv** files
- **Candlestick** chart with volume below
- **Crosshair** — hover the chart to see OHLCV
- **Drawing tools** — horizontal line, vertical line, trend line (TradingView-style)
  - Change color and style (solid, dashed, dotted)
  - Edit price or date/time precisely in the right-hand panel
  - Drag lines with the mouse; Delete to remove them
- **Fibonacci Retracement** — click two points (swing low → swing high)
  - Default levels: 0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%
  - Editable levels: enable/disable, change the percentage, add or remove
- **Price label on the Y axis** at the cursor position
- Top bar with Date, Open, High, Low, Close, Volume, and change

## Accepted columns

| Field | Example column names |
|------|-------------------------|
| Date/Time | `DateTime`, `Date`, `Data`, `<DATE>` (+ optional `Time` / `<TIME>`) |
| Open | `Open`, `Deschidere` |
| High | `High`, `Maxim` |
| Low | `Low`, `Minim` |
| Close | `Close`, `Inchidere`, `Închidere` |
| Volume | `Volume`, `Volum`, `Vol`, `<TICKVOL>` (optional) |
| Symbol | `Symbol`, `Simbol`, `Ticker` (optional) |

Supports **MetaTrader** exports (`<DATE>`, `<TIME>`, `<OPEN>`, etc.) with date format `YYYY.MM.DD` and time `HH:mm:ss`. The time from Excel is shown as-is on the chart (no timezone conversion).

## Run

Open `index.html` in a browser (double-click) or start a local server:

```powershell
# Python (if installed)
python -m http.server 8080
```

Then open: http://localhost:8080

## Sample file

Upload `sample-US30.csv` to test the app (fictional US30 data).

## Technologies

- [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
- [SheetJS](https://sheetjs.com/) for Excel parsing
