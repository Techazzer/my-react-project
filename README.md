# 📦 Reprint Projection — Inventory Planning Tool

An adaptive weighted-rate reprint forecasting tool for book publishers. Upload your inventory and transaction CSVs to get instant reprint decisions with spike detection.

## Features

- **Adaptive Weighted Rate** — blends 2-month avg + recent 10-day spike detection
- **60-day demand forecast** per SKU
- **Reprint decisions**: 🔴 Urgent / 🟡 At Risk / 🟢 Safe
- **⬇ Download CSV** of all projection data
- **Projection Formula panel** — full step-by-step methodology

## Deploy on Vercel (from GitHub)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your GitHub repo
3. Vercel auto-detects Vite. Settings are already correct:
   - **Framework:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. Click **Deploy** — done ✓

## Run Locally

```bash
npm install
npm run dev
```

## CSV File Requirements

### Inventory CSV
Required columns:
- `Master SKU`
- `Available Inventory - Good`
- `Product Name`

### Transactions CSV
Required columns:
- `Master SKU`
- `Shiprocket Created At`
- `Product Quantity`
- `Status`
- `Is Reverse`

## Projection Algorithm

| Step | What | Formula |
|------|------|---------|
| 1 | Measure rates | rate_10d, rate_30d, rate_prev30d |
| 2 | 2-month avg | (rate_30d + rate_prev) ÷ 2 |
| 3 | Spike detection | spike if rate_10d > 1.3× rate_2mo |
| 4 | Effective rate | No spike: rate_2mo · Spike: 60% × rate_10d + 40% × rate_2mo |
| 5 | 60d forecast | eff_rate × 60 |
| 6 | Decision | Urgent <15d · At Risk <75d · Safe ≥75d |
