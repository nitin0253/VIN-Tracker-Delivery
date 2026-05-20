let cache = null;
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000;
const METABASE_URL = "https://metabase.spyne.ai/public/question/7f434e89-1ab4-43e9-8633-841e7076d2f7.csv";

function splitRow(row) {
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

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitRow(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitRow(line);
    const obj = {};
    headers.forEach((h, j) => { obj[h] = (vals[j] ?? '').trim(); });
    return obj;
  });
}

function pick(r, ...names) {
  for (const n of names) { const v = r[n]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}

function hoursAgo(ts, now) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const h = (now - d) / 3600000;
  return h >= 0 ? h : null;
}

async function buildCache() {
  if (cache && Date.now() - lastFetch < CACHE_TTL) return cache;
  const resp = await fetch(METABASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Metabase ${resp.status}`);
  const raw = parseCSV(await resp.text());
  const cols = raw.length ? Object.keys(raw[0]) : [];
  const now = Date.now();

  const rows = raw.map(r => ({
    dealerVinId:  pick(r, 'dvm.dealerVinId', 'dealerVinId'),
    eid:          pick(r, 'dvm.enterpriseId', 'enterpriseId'),
    teamId:       pick(r, 'dvm.teamId', 'teamId'),
    vin:          pick(r, 'vinName'),
    make:         pick(r, 'dvm.make', 'make'),
    model:        pick(r, 'dvm.model', 'model'),
    year:         pick(r, 'year'),
    trim:         pick(r, 'trim'),
    stock:        pick(r, 'stockNumber'),
    outputImgs:   pick(r, 'output_image_count'),
    price:        pick(r, 'sellingPrice'),
    platform:     pick(r, 'platform'),
    imgCount:     pick(r, 'image_count'),
    vidCount:     pick(r, 'video_count'),
    status:       pick(r, 'status_overallStatus'),
    vinCreation:  pick(r, 'vinCreation'),
    receivedAt:   pick(r, 'receivedAt'),
    sentAt:       pick(r, 'sentAt'),
    rb:           pick(r, 'reason_bucket'),
    holdReason:   pick(r, 'hold_reason'),
    thumbnail:    pick(r, 'thumbnail_url'),
    vdpUrl:       pick(r, 'vdp_url'),
    ename:        pick(r, 'enterprise_name'),
    team:         pick(r, 'apd.team_name', 'team_name'),
    type:         pick(r, 'type'),
    teamType:     pick(r, 'team_type'),
    poc:          pick(r, 'poc_email'),
    hrsVc:        hoursAgo(pick(r, 'vinCreation'), now),
    hrsRecv:      hoursAgo(pick(r, 'receivedAt'), now),
  }));

  cache = { rows, cols, total: rows.length, lastSynced: now };
  lastFetch = now;
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
      return res.status(200).json({
        totalRows: data.total, cols: data.cols, sampleRow: data.rows[0],
        uniqueRB:   [...new Set(data.rows.map(r => r.rb).filter(Boolean))],
        uniqueType: [...new Set(data.rows.map(r => r.type).filter(Boolean))],
        uniquePoc:  [...new Set(data.rows.map(r => r.poc).filter(Boolean))].slice(0,10),
      });
    }
    res.status(200).json({ rows: data.rows, total: data.total, lastSynced: new Date(data.lastSynced).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
