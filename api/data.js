let cache = null;
let lastFetch = 0;
const CACHE_TIME = 5 * 60 * 1000;

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/e45c301d-aa55-4df8-a804-51ec721b6f26.csv";

function parseCSVRow(row) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (vals[i] ?? '').trim()));
    return obj;
  });
}

function pickField(r, names) {
  for (const n of names) if (r[n] != null && String(r[n]).trim() !== '') return r[n];
  return '';
}

async function loadRows() {
  if (cache && Date.now() - lastFetch < CACHE_TIME) return cache;
  const resp = await fetch(METABASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Metabase responded ${resp.status}`);
  const text = await resp.text();
  const rows = parseCSV(text);

  if (rows.length > 0) {
    console.log('[data.js] cols:', Object.keys(rows[0]).join(', '));
    console.log('[data.js] rows:', rows.length);
  }

  cache = rows.map(r => ({
    dealerVinId:     pickField(r, ['dealerVinId','dealer_vin_id','DealerVinId']),
    enterpriseId:    pickField(r, ['enterpriseId','enterprise_id','EnterpriseId']),
    teamId:          pickField(r, ['teamId','team_id']),
    vinName:         pickField(r, ['vinName','vin_name','VinName','vin']),
    make:            pickField(r, ['make','Make']),
    model:           pickField(r, ['model','Model']),
    year:            pickField(r, ['year','Year']),
    trim:            pickField(r, ['trim','Trim']),
    stockNumber:     pickField(r, ['stockNumber','stock_number']),
    sellingPrice:    pickField(r, ['sellingPrice','selling_price']),
    platform:        pickField(r, ['platform','Platform']),
    imageCount:      pickField(r, ['image_count','imageCount']),
    outputImageCount:pickField(r, ['output_image_count','outputImageCount']),
    videoCount:      pickField(r, ['video_count','videoCount']),
    overallStatus:   pickField(r, ['status_overallStatus','overallStatus','overall_status','status']),
    vinCreation:     pickField(r, ['vinCreation','vin_creation','created_at']),
    receivedAt:      pickField(r, ['receivedAt','received_at']),
    sentAt:          pickField(r, ['sentAt','sent_at']),
    hasPhotos:       pickField(r, ['has_photos','hasPhotos']),
    status:          pickField(r, ['status','Status']),
    after24hrs:      pickField(r, ['after_24_hrs','after24hrs','after_24hrs']),
    reasonBucket:    pickField(r, ['reason_bucket','reasonBucket','reason bucket']),
    holdReason:      pickField(r, ['hold_reason','holdReason']),
    thumbnailUrl:    pickField(r, ['thumbnail_url','thumbnailUrl']),
    vdpUrl:          pickField(r, ['vdp_url','vdpUrl']),
    vinScore:        pickField(r, ['vin_score','vinScore']),
  }));

  lastFetch = Date.now();
  return cache;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.query.force === '1') { cache = null; lastFetch = 0; }
    const rows = await loadRows();

    if (req.query.debug === '1') {
      return res.status(200).json({
        count: rows.length,
        sample: rows.slice(0, 2),
        uniqueReasonBuckets: [...new Set(rows.map(r => r.reasonBucket).filter(Boolean))],
      });
    }

    res.status(200).json({
      rows,
      count: rows.length,
      lastSynced: new Date(lastFetch).toISOString(),
    });
  } catch (err) {
    console.error('[data.js]', err);
    res.status(500).json({ error: err.message });
  }
}
