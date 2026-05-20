let cache = null;
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000;

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/e45c301d-aa55-4df8-a804-51ec721b6f26.csv";

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

async function buildCache() {
  if (cache && Date.now() - lastFetch < CACHE_TTL) return cache;
  const resp = await fetch(METABASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Metabase ${resp.status}`);
  const raw = parseCSV(await resp.text());
  const cols = raw.length ? Object.keys(raw[0]) : [];

  const now = Date.now();

  const rows = raw.map(r => {
    // Compute hours from vinCreation for primary bucketing
    const vcStr = pick(r, 'vinCreation', 'vin_creation', 'created_at');
    let hrsVc = null;
    if (vcStr) {
      const d = new Date(vcStr);
      if (!isNaN(d)) { const h = (now - d) / 3600000; if (h >= 0) hrsVc = h; }
    }

    // Also compute from receivedAt as fallback
    let hrsRecv = null;
    const recvStr = pick(r, 'receivedAt', 'received_at');
    const sentStr = pick(r, 'sentAt', 'sent_at');
    const a24 = pick(r, 'after_24_hrs', 'after24hrs').toLowerCase();
    if (a24 === 'true' || a24 === '1' || a24 === 'yes') { hrsRecv = 25; }
    else {
      for (const ts of [recvStr, sentStr]) {
        if (!ts) continue;
        const d = new Date(ts);
        if (!isNaN(d)) { const h = (now - d) / 3600000; if (h >= 0) { hrsRecv = h; break; } }
      }
    }

    return {
      eid:    pick(r, 'enterpriseId', 'enterprise_id', 'EnterpriseId'),
      ename:  pick(r, 'enterprise_name', 'enterpriseName', 'enterpriseId', 'enterprise_id'),
      team:   pick(r, 'apd.team_name', 'team_name', 'teamName', 'teamId', 'team_id'),
      vin:    pick(r, 'vinName', 'vin_name', 'VinName', 'vin'),
      rb:     pick(r, 'reason_bucket', 'reasonBucket', 'reason bucket'),
      type:   pick(r, 'type', 'Type', 'platform', 'Platform'),
      status: pick(r, 'status', 'Status', 'status_overallStatus', 'overallStatus'),
      cspoc:  pick(r, 'cs_poc_email', 'csPocEmail', 'POC_CS', 'poc_cs'),
      obpoc:  pick(r, 'ob_poc_email', 'obPocEmail', 'POC_OB', 'poc_ob'),
      aepoc:  pick(r, 'ae_poc_email', 'aePocEmail'),
      hrsVc,   // hours from vinCreation
      hrsRecv, // hours from receivedAt/sentAt
    };
  });

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
        uniqueStatus: [...new Set(data.rows.map(r => r.status).filter(Boolean))],
        uniqueRB:     [...new Set(data.rows.map(r => r.rb).filter(Boolean))],
        uniqueType:   [...new Set(data.rows.map(r => r.type).filter(Boolean))],
      });
    }
    res.status(200).json({ rows: data.rows, total: data.total, lastSynced: new Date(data.lastSynced).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
