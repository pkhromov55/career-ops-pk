// Единственный ключ в KV — весь стейт приложения одним JSON-документом.
// Работает с Vercel KV / Upstash Redis через REST API, без зависимостей.
const STATE_KEY = "gymquest:state";
const MAX_BYTES = 512 * 1024;

function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export default async function handler(req, res) {
  const kv = kvConfig();
  if (!kv) {
    return res.status(503).json({ error: "no-db", hint: "Подключи Upstash Redis (KV) к проекту в Vercel → Storage" });
  }

  const pin = process.env.APP_PIN;
  if (pin && req.headers["x-pin"] !== pin) {
    return res.status(401).json({ error: "pin-required" });
  }

  const auth = { Authorization: `Bearer ${kv.token}` };

  if (req.method === "GET") {
    const r = await fetch(`${kv.url}/get/${STATE_KEY}`, { headers: auth });
    if (!r.ok) return res.status(502).json({ error: "kv-read-failed" });
    const j = await r.json();
    let state = null;
    if (j.result) {
      try { state = JSON.parse(j.result); } catch (e) { state = null; }
    }
    return res.status(200).json({ state });
  }

  if (req.method === "PUT" || req.method === "POST") {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    if (!body || body === "{}" || body === "null") return res.status(400).json({ error: "empty" });
    if (Buffer.byteLength(body, "utf8") > MAX_BYTES) return res.status(413).json({ error: "too-big" });
    try { JSON.parse(body); } catch (e) { return res.status(400).json({ error: "bad-json" }); }

    const r = await fetch(`${kv.url}/set/${STATE_KEY}`, { method: "POST", headers: auth, body });
    if (!r.ok) return res.status(502).json({ error: "kv-write-failed" });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, PUT, POST");
  return res.status(405).json({ error: "method-not-allowed" });
}
