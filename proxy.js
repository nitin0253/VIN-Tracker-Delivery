export default async function handler(req, res) {
  try {
    const upstream = await fetch(
      'https://metabase.spyne.ai/public/question/15e908e4-fe21-4982-9d8c-4aff07f2c948.csv'
    );
    if (!upstream.ok) {
      res.status(upstream.status).send('Upstream error: ' + upstream.statusText);
      return;
    }
    const text = await upstream.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).send(text);
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
}
