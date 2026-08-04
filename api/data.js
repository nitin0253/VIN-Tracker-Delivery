let vinCache = null, entCache = null, lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ── Config (set these in the Vercel dashboard → Settings → Environment Variables,
//    or in a local .env for `vercel dev`). NEVER commit real credentials. ──────────
const MB = (process.env.METABASE_URL || 'https://metabase.spyne.ai').replace(/\/+$/, '');
// Two "VIN tracker" questions with identical columns — v2 (12497) and v1 (12832).
// The dashboard merges both. VIN_CARD_ID (legacy) still works as the v2 id.
const VIN_CARD_ID_V2 = process.env.VIN_CARD_ID_V2 || process.env.VIN_CARD_ID || '12497';
const VIN_CARD_ID_V1 = process.env.VIN_CARD_ID_V1 || '12832';
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

  // Log in once up front so the two parallel VIN fetches share a single session
  // (avoids two concurrent logins on a cold cache).
  if (!MB_API_KEY && !mbSession) await login();

  // Both VIN questions (v2 + v1) → authenticated Metabase API; enterprise → public link.
  // Each VIN fetch is resilient: if one version fails we still render the other.
  const [rawVinV2, rawVinV1, entResult] = await Promise.all([
    fetchCardCsv(VIN_CARD_ID_V2).catch(e => { console.error('VIN v2 fetch failed:', e.message); return ''; }),
    fetchCardCsv(VIN_CARD_ID_V1).catch(e => { console.error('VIN v1 fetch failed:', e.message); return ''; }),
    fetch(ENT_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      .then(r => (r.ok ? r.text() : null))
      .catch(() => null),
  ]);
  const rowsV2 = parseCSV(rawVinV2); rowsV2.forEach(r => { r.__version = 'v2'; });
  const rowsV1 = parseCSV(rawVinV1); rowsV1.forEach(r => { r.__version = 'v1'; });
  const rawVin = [...rowsV2, ...rowsV1];
  if (!rawVin.length) throw new Error('Both VIN cards (v1 + v2) returned no data');

  const entMap = {};
  if (entResult) {
    const rawEnt = parseCSV(entResult);
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
      imgCount:        parseInt(pick(r, 'image_count')) || 0,
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
    if (req.query.force === '1') { vinCache = null; entCache = null; lastFetch = 0; }
    const { vinCache: rows, entCache: ents } = await buildCache();
    if (req.query.debug === '1') {
      return res.status(200).json({
        totalVins: rows.length, totalEnts: ents.length,
        byVersion: { v1: rows.filter(r => r.version === 'v1').length,
                     v2: rows.filter(r => r.version === 'v2').length },
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
    res.status(200).json({ rows, ents, total: rows.length, lastSynced: new Date(lastFetch).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
