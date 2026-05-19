// api/data.js — lean, fast, server-side cached
let cache = null;
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000;

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/e45c301d-aa55-4df8-a804-51ec721b6f26.csv";

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitCSVRow(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitCSVRow(lines[i]);
    const obj = {};
    headers.forEach((h, j) => { obj[h] = (vals[j] ?? '').trim(); });
    out.push(obj);
  }
  return out;
}

function splitCSVRow(row) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') { if (q && row[i+1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function pick(r, ...names) {
  for (const n of names) { const v = r[n]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}

// Pre-aggregate on server: returns summary + slim rows (only fields needed client-side)
async function buildCache() {
  if (cache && Date.now() - lastFetch < CACHE_TTL) return cache;

  const resp = await fetch(METABASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Metabase ${resp.status}`);
  const raw = parseCSV(await resp.text());

  const cols = raw.length ? Object.keys(raw[0]) : [];

  // Map to slim rows — only what the dashboard needs
  const rows = raw.map(r => ({
    eid:    pick(r, 'enterpriseId','enterprise_id','EnterpriseId'),
    vin:    pick(r, 'vinName','vin_name','VinName','vin'),
    rb:     pick(r, 'reason_bucket','reasonBucket','reason bucket'),  // reason_bucket
    type:   pick(r, 'platform','Platform','type','Type'),              // "type" = platform
    a24:    pick(r, 'after_24_hrs','after24hrs'),
    recv:   pick(r, 'receivedAt','received_at'),
    sent:   pick(r, 'sentAt','sent_at'),
    vc:     pick(r, 'vinCreation','vin_creation'),
  }));

  // Pre-compute hours for every row once
  const now = Date.now();
  const withHrs = rows.map(r => {
    let hrs = null;
    const a = r.a24.toLowerCase();
    if (a === 'true' || a === '1' || a === 'yes') { hrs = 25; }
    else {
      for (const ts of [r.recv, r.sent, r.vc]) {
        if (!ts) continue;
        const d = new Date(ts);
        if (!isNaN(d)) { const h = (now - d) / 3600000; if (h >= 0) { hrs = h; break; } }
      }
    }
    return { ...r, hrs };
  });

  cache = { rows: withHrs, cols, total: withHrs.length, lastSynced: Date.now() };
  lastFetch = Date.now();
  return cache;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    if (req.query.force === '1') { cache = null; lastFetch = 0; }
    const data = await buildCache();

    if (req.query.debug === '1') {
      const uniqRB = [...new Set(data.rows.map(r => r.rb).filter(Boolean))];
      const uniqType = [...new Set(data.rows.map(r => r.type).filter(Boolean))];
      return res.status(200).json({
        totalRows: data.total, cols: data.cols,
        sampleRow: data.rows[0],
        uniqueReasonBuckets: uniqRB,
        uniqueTypes: uniqType,
      });
    }

    // Send slim rows — hours already computed
    res.status(200).json({
      rows: data.rows,
      total: data.total,
      lastSynced: new Date(data.lastSynced).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
