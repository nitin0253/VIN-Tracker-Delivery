# Spyne Inventory QC Dashboard

A live dashboard built with vanilla HTML/CSS/JS that reads directly from a Metabase public CSV endpoint and visualizes QC Pending inventory data.

## Features

- **Total QC Pending count** with KPI cards (total, within 24h, beyond 24h, enterprises affected)
- **Hourly buckets** (0–4h, 5–8h, 9–12h, 13–24h, 24+h) for all QC Pending items
- **Top 10 enterprises** table with per-bucket breakdown

## Data Source

Reads live from:
```
https://metabase.spyne.ai/public/question/15e908e4-fe21-4982-9d8c-4aff07f2c948.csv
```

> **Note:** For the dashboard to load data in-browser, the Metabase endpoint must allow CORS from your Vercel domain. If it doesn't, you'll need a small proxy (see below).

## Deploy to Vercel

1. Push this repo to GitHub
2. Import the repo in [vercel.com](https://vercel.com)
3. Deploy — no build step needed (static site)

## CORS Proxy (if needed)

If Metabase blocks cross-origin requests, add a lightweight proxy. The easiest option with Vercel:

Create `api/proxy.js`:

```js
export default async function handler(req, res) {
  const upstream = await fetch(
    'https://metabase.spyne.ai/public/question/15e908e4-fe21-4982-9d8c-4aff07f2c948.csv'
  );
  const text = await upstream.text();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/csv');
  res.send(text);
}
```

Then change `CSV_URL` in `index.html` to `/api/proxy`.

## Column Mapping

| Column | Usage |
|---|---|
| `reason_bucket` | Filter for `QC Pending` |
| `after_24_hrs` | Quick flag for >24h bucket |
| `receivedAt` | Used to compute hours if `after_24_hrs` unavailable |
| `enterpriseId` | Enterprise grouping in table |
