export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const url = 'https://metabase.spyne.ai/public/question/15e908e4-fe21-4982-9d8c-4aff07f2c948.csv';
    const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rawText  = await upstream.text();
    const ct       = upstream.headers.get('content-type') || 'unknown';

    // Try to parse as JSON
    let jsonInfo = null;
    try {
      const j = JSON.parse(rawText);
      jsonInfo = {
        isJSON: true,
        topKeys: Object.keys(j).slice(0, 10),
        hasCols: !!j?.data?.cols,
        colNames: (j?.data?.cols || []).map(c => c.name || c.display_name).slice(0, 30),
        rowCount: (j?.data?.rows || []).length,
      };
    } catch(_) {
      // It's CSV — get first row columns
      const firstLine = rawText.split(/\r?\n/)[0] || '';
      jsonInfo = { isJSON: false, firstLineRaw: firstLine.slice(0, 500) };
    }

    res.status(200).json({
      httpStatus: upstream.status,
      contentType: ct,
      totalBytes: rawText.length,
      first500: rawText.slice(0, 500),
      analysis: jsonInfo
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
