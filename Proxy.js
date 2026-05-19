export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-cache, no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const url = 'https://metabase.spyne.ai/public/question/15e908e4-fe21-4982-9d8c-4aff07f2c948.csv';
    
    const upstream = await fetch(url, {
      headers: {
        'Accept': 'text/csv,application/json,*/*',
        'User-Agent': 'Mozilla/5.0',
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ 
        error: `Upstream HTTP ${upstream.status}: ${upstream.statusText}` 
      });
    }

    const rawText = await upstream.text();
    const ct = upstream.headers.get('content-type') || '';

    // ── Case 1: Metabase JSON format ──────────────────────────────────
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch(_) {}

    if (parsed) {
      // Format A: { data: { cols: [...], rows: [[...], ...] } }
      const cols = parsed?.data?.cols ?? parsed?.cols ?? null;
      const rows = parsed?.data?.rows ?? parsed?.rows ?? null;

      if (Array.isArray(cols) && Array.isArray(rows)) {
        const header = cols.map(c => csvEsc(c.display_name || c.name || '')).join(',');
        const lines  = rows.map(r => r.map(v => v == null ? '' : csvEsc(String(v))).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        return res.status(200).send([header, ...lines].join('\r\n'));
      }

      // Format B: array of objects
      if (Array.isArray(parsed) && parsed.length) {
        const keys   = Object.keys(parsed[0]);
        const header = keys.map(csvEsc).join(',');
        const lines  = parsed.map(obj => keys.map(k => obj[k] == null ? '' : csvEsc(String(obj[k]))).join(','));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        return res.status(200).send([header, ...lines].join('\r\n'));
      }

      return res.status(500).json({ error: 'JSON received but unknown structure', sample: JSON.stringify(parsed).slice(0, 400) });
    }

    // ── Case 2: Plain CSV ─────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(rawText);

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 300) });
  }
}

function csvEsc(v) {
  if (/[,"\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
