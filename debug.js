export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const upstream = await fetch(
      'https://metabase.spyne.ai/public/question/15e908e4-fe21-4982-9d8c-4aff07f2c948.csv'
    );
    const contentType = upstream.headers.get('content-type');
    const text = await upstream.text();
    res.status(200).json({
      status: upstream.status,
      contentType,
      first500chars: text.slice(0, 500),
      totalLength: text.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
