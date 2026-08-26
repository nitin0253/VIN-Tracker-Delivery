let vinCache = null, entCache = null, lastFetch = 0;
// Per-source last-good raw data, so a flaky/slow version (or the enterprise CSV)
// never blocks the others from refreshing or takes the whole dashboard down.
let lastRowsV1 = null, lastRowsV2 = null, lastRowsV1IM = null, lastEntText = null;
let staleV1 = false, staleV2 = false, staleV1IM = false;
// In-memory TTL: keeps the serverless instance from re-fetching Metabase on
// every request. 2 min is short enough for near-real-time, long enough to
// absorb bursts. (Hobby plan can't run sub-daily crons, so no warm cache.)
const CACHE_TTL = 2 * 60 * 1000;

// ── Config (set these in the Vercel dashboard → Settings → Environment Variables,
//    or in a local .env for `vercel dev`). NEVER commit real credentials. ──────────
const MB = (process.env.METABASE_URL || 'https://metabase.spyne.ai').replace(/\/+$/, '');
// Three "VIN tracker" questions with identical columns:
//   v2 (12497), v1 (12832), v1-IM (12947 — Instamotion + Carvago2, split for volume).
const VIN_CARD_ID_V2    = process.env.VIN_CARD_ID_V2 || process.env.VIN_CARD_ID || '12497';
const VIN_CARD_ID_V1    = process.env.VIN_CARD_ID_V1 || '12832';
const VIN_CARD_ID_V1_IM = process.env.VIN_CARD_ID_V1_IM || '12947';
const MB_USER     = process.env.METABASE_USER || '';
const MB_PASS     = process.env.METABASE_PASSWORD || '';
const MB_API_KEY  = process.env.METABASE_API_KEY || '';           // optional alternative to user/pass

// Enterprise details stay on their existing PUBLIC link (no auth needed).
const ENT_URL = process.env.ENT_URL
  || "https://metabase.spyne.ai/public/question/b8f1271c-cc5a-470f-badf-807711f74af4.csv";

// ── Metabase auth: cache a session token, re-login automatically on expiry ────────
let mbSession = null;

async function login() {
  if (!MB_USER || !MB_PASS) {
    throw new Error('Missing METABASE_USER / METABASE_PASSWORD env vars');
  }
  const resp = await fetch(`${MB}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MB_USER, password: MB_PASS }),
  });
  if (!resp.ok) {
    throw new Error(`Metabase login ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  mbSession = (await resp.json()).id;
  return mbSession;
}

function authHeaders(token) {
  return MB_API_KEY ? { 'X-Api-Key': MB_API_KEY } : { 'X-Metabase-Session': token };
}

// Fetch a saved question's results as CSV via the authenticated API. This returns
// the SAME CSV the public link did, so all the parsing below is unchanged.
async function fetchCardCsv(cardId) {
  const url = `${MB}/api/card/${cardId}/query/csv`;
  const doFetch = (token) => fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'parameters=' + encodeURIComponent('[]'),
  });

  let token = MB_API_KEY ? null : (mbSession || await login());
  let resp = await doFetch(token);

  // Session expired / invalid → drop it, log in again, retry once.
  if (!MB_API_KEY && (resp.status === 401 || resp.status === 403)) {
    mbSession = null;
    token = await login();
    resp = await doFetch(token);
  }
  // Transient Metabase 5xx (e.g. a gateway 504 on a slow query) → retry once. The
  // query often finishes / caches server-side, so the retry can succeed quickly.
  if (!resp.ok && resp.status >= 500) {
    resp = await doFetch(token);
  }
  if (!resp.ok) {
    throw new Error(`VIN card ${cardId} query ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return resp.text();
}

function splitRow(row) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') { if (q && row[i+1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim()); return out;
}
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitRow(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitRow(line), obj = {};
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
  const d = new Date(ts); if (isNaN(d)) return null;
  const h = (now - d) / 3600000; return h >= 0 ? h : null;
}

async function buildCache() {
  if (vinCache && Date.now() - lastFetch < CACHE_TTL) return { vinCache, entCache };
  const now = Date.now();

  // Log in once up front so the parallel VIN fetches share a single session.
  if (!MB_API_KEY && !mbSession) await login();

  // Fetch all three VIN questions + enterprise CSV in parallel. Each source keeps
  // its own last-good copy so one failing source doesn't block the others.
  const entPromise = fetch(ENT_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    .then(r => (r.ok ? r.text() : null))
    .catch(() => null);
  const [resV2, resV1, resV1IM] = await Promise.allSettled([
    fetchCardCsv(VIN_CARD_ID_V2),
    fetchCardCsv(VIN_CARD_ID_V1),
    fetchCardCsv(VIN_CARD_ID_V1_IM),
  ]);
  const entResult = await entPromise;

  const freshV2   = resV2.status   === 'fulfilled' ? parseCSV(resV2.value)   : null;
  const freshV1   = resV1.status   === 'fulfilled' ? parseCSV(resV1.value)   : null;
  const freshV1IM = resV1IM.status === 'fulfilled' ? parseCSV(resV1IM.value) : null;
  if (freshV2 && freshV2.length)     { freshV2.forEach(r   => { r.__version = 'v2'; }); lastRowsV2   = freshV2;   staleV2   = false; }
  else { staleV2   = true; console.warn(`v2 (${VIN_CARD_ID_V2}) failed/empty — serving last-good (${lastRowsV2 ? lastRowsV2.length : 0} rows)`); }
  if (freshV1 && freshV1.length)     { freshV1.forEach(r   => { r.__version = 'v1'; }); lastRowsV1   = freshV1;   staleV1   = false; }
  else { staleV1   = true; console.warn(`v1 (${VIN_CARD_ID_V1}) failed/empty — serving last-good (${lastRowsV1 ? lastRowsV1.length : 0} rows)`); }
  if (freshV1IM && freshV1IM.length) { freshV1IM.forEach(r => { r.__version = 'v1'; }); lastRowsV1IM = freshV1IM; staleV1IM = false; }
  else { staleV1IM = true; console.warn(`v1-IM (${VIN_CARD_ID_V1_IM}) failed/empty — serving last-good (${lastRowsV1IM ? lastRowsV1IM.length : 0} rows)`); }
  if (entResult) lastEntText = entResult;

  if (!lastRowsV1 && !lastRowsV2 && !lastRowsV1IM) {
    throw new Error(`No VIN data available from any card (v2=${resV2.status}, v1=${resV1.status}, v1IM=${resV1IM.status})`);
  }
  const rawVin = [...(lastRowsV2 || []), ...(lastRowsV1 || []), ...(lastRowsV1IM || [])];

  const entMap = {};
  if (lastEntText) {
    const rawEnt = parseCSV(lastEntText);
    rawEnt.forEach(r => {
      const id = pick(r, 'dt.enterprise_id', 'enterprise_id', 'enterpriseId');
      if (id) {
        entMap[id] = {
          name:    pick(r, 'name', 'enterprise_name'),
          type:    pick(r, 'type'),
          stage:   pick(r, 'stage'),
          website: pick(r, 'website_url'),
          poc:     pick(r, 'poc_id', 'poc'),
          email:   pick(r, 'email_id', 'email', 'poc_email'),
        };
      }
    });
  }

  vinCache = rawVin.map(r => {
    const eid = pick(r, 'enterpriseId');
    const tid = pick(r, 'teamId');
    const ent = entMap[eid] || {};
    return {
      vin:             pick(r, 'vinName'),
      dealerVinId:     pick(r, 'dealerVinId'),
      eid,
      entName:         pick(r, 'enterprise_name') || ent.name  || eid,
      entType:         ent.type  || '',
      entStage:        ent.stage || pick(r, 'stage') || '',
      entEmail:        ent.email || pick(r, 'email_id', 'poc_email', 'email') || '',
      teamId:          tid,
      teamName:        pick(r, 'team_name'),
      customerSegment: pick(r, 'customer_segment'),
      crmStatus:       pick(r, 'crm_status'),
      make:            pick(r, 'make'),
      model:           pick(r, 'model'),
      year:            pick(r, 'year'),
      trim:            pick(r, 'trim'),
      stock:           pick(r, 'stockNumber'),
      skuId:           pick(r, 'sd.sku_id', 'sku_id', 'skuId'),
      platform:        pick(r, 'platform'),
      type:            pick(r, 'type') || pick(r, 'platform'),
      status:          pick(r, 'status_overallStatus', 'status'),
      rb:              pick(r, 'reason_bucket'),
      holdReason:      pick(r, 'hold_reason'),
      hasPhotos:       pick(r, 'has_photos'),
      after24:         pick(r, 'after_24_hrs'),
      // "Images" on the dashboard = output (processed) image count. image_count
      // (input images) is 0 for v1/API uploads, so output_image_count is the
      // meaningful, populated value across both versions.
      imgCount:        parseInt(pick(r, 'output_image_count')) || 0,
      vidCount:        parseInt(pick(r, 'video_count')) || 0,
      outImgs:         parseInt(pick(r, 'output_image_count')) || 0,
      overallScore:    pick(r, 'overall_score'),
      vinScore:        pick(r, 'vin_score'),
      price:           pick(r, 'sellingPrice'),
      thumbnail:       pick(r, 'thumbnail_url'),
      vdpUrl:          pick(r, 'vdp_url'),
      websiteUrl:      pick(r, 'website_listing_url'),
      vinCreation:     pick(r, 'vinCreation'),
      receivedAt:      pick(r, 'receivedAt'),
      sentAt:          pick(r, 'sentAt'),
      hrsVc:           hoursAgo(pick(r, 'vinCreation'), now),
      hrsRecv:         hoursAgo(pick(r, 'receivedAt'), now),
      version:         r.__version || '',
    };
  });

  entCache = Object.entries(entMap).map(([id, e]) => ({ id, ...e }));
  lastFetch = now;
  return { vinCache, entCache };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Was 'no-store' — this is the change that matters most: lets Vercel's
  // CDN serve cached responses for 60s and stale-while-revalidate for 5 more
  // minutes, so repeat requests don't all hit this function.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  try {
    // Cron (x-vercel-cron header), ?force=1 or ?warm=1 → refresh the cache in the
    // background so the slow fetch runs here, not on a user/bot page load.
    if (req.query.force === '1' || req.query.warm === '1' || req.headers['x-vercel-cron']) {
      vinCache = null; entCache = null; lastFetch = 0;
    }
    const { vinCache: rows, entCache: ents } = await buildCache();
    if (req.query.debug === '1') {
      return res.status(200).json({
        totalVins: rows.length, totalEnts: ents.length,
        byVersion: { v1: rows.filter(r => r.version === 'v1').length,
                     v2: rows.filter(r => r.version === 'v2').length },
        stale: { v1: staleV1, v2: staleV2, v1IM: staleV1IM },
        sampleVin: rows[0], sampleEnt: ents[0],
        uniqueRB:              [...new Set(rows.map(r => r.rb).filter(Boolean))],
        uniqueType:            [...new Set(rows.map(r => r.type).filter(Boolean))],
        uniqueCustomerSegment: [...new Set(rows.map(r => r.customerSegment).filter(Boolean))],
        uniqueCrmStatus:       [...new Set(rows.map(r => r.crmStatus).filter(Boolean))],
        pocEmailSample: rows.filter(r => r.entEmail).slice(0, 5).map(r => ({
          eid: r.eid, entName: r.entName, email: r.entEmail
        })),
      });
    }
    res.status(200).json({ rows, ents, total: rows.length, stale: { v1: staleV1, v2: staleV2, v1IM: staleV1IM }, lastSynced: new Date(lastFetch).toISOString() });
  } catch (err) {
    // Errors must not be cached by the CDN — otherwise a single failed refresh
    // would be served for the whole s-maxage window instead of retrying.
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: err.message });
  }
}
