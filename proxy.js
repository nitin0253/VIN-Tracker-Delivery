export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const upstream = await fetch(
      'https://metabase.spyne.ai/public/question/15e908e4-fe21-4982-9d8c-4aff07f2c948.csv',
      { headers: { 'Accept': 'text/csv, application/json, */*' } }
    );

    if (!upstream.ok) {
      res.status(upstream.status).send('Upstream error: ' + upstream.statusText);
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const text = await upstream.text();

    // If Metabase returned JSON, convert to CSV
    if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        const json = JSON.parse(text);

        // Metabase native JSON: { data: { cols, rows } }
        const cols = json?.data?.cols || json?.cols || null;
        const rows = json?.data?.rows || json?.rows || null;

        if (cols && rows && cols.length) {
          const header = cols.map(c => escapeCsv(c.display_name || c.name || '')).join(',');
          const csvRows = rows.map(row =>
            row.map(cell => cell === null || cell === undefined ? '' : escapeCsv(String(cell))).join(',')
          );
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          return res.status(200).send([header, ...csvRows].join('\n'));
        }

        // Array-of-objects fallback
        if (Array.isArray(json) && json.length) {
          const keys = Object.keys(json[0]);
          const header = keys.map(escapeCsv).join(',');
          const csvRows = json.map(obj =>
            keys.map(k => obj[k] === null || obj[k] === undefined ? '' : escapeCsv(String(obj[k]))).join(',')
          );
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          return res.status(200).send([header, ...csvRows].join('\n'));
        }
      } catch (_) {}
    }

    // Plain CSV passthrough
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(text);
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}

function escapeCsv(val) {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}
