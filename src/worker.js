/*
 * Darts Counter – Server für den Freunde-Bereich.
 *
 * Statische Dateien liefert Cloudflare direkt aus (Ordner public/). Dieser Worker läuft nur für /api/*.
 * Davor sitzt Cloudflare Access: Nur eingeladene E-Mail-Adressen kommen durch. Zusätzlich prüft der Worker
 * das von Access signierte Token (Header Cf-Access-Jwt-Assertion), damit niemand Access umgehen kann.
 *
 * Gespeichert werden nur Spieler, Spiele und Trainings (gemeinsam für alle Freunde). E-Mail-Adressen werden
 * nicht in der Datenbank abgelegt.
 */

const KINDS = new Set(['players', 'games', 'trainings']);
const MAX_OPS = 200;
const MAX_RECORD_BYTES = 256 * 1024;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

// ------------------------------------------------------------ Anmeldung (Cloudflare Access)

let jwksCache = { url: '', at: 0, keys: [] };

async function accessKeys(teamDomain, force) {
  const url = teamDomain + '/cdn-cgi/access/certs';
  if (!force && jwksCache.url === url && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error('certs ' + res.status);
  const body = await res.json();
  jwksCache = { url, at: Date.now(), keys: body.keys || [] };
  return jwksCache.keys;
}

function b64url(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyAccessJwt(token, teamDomain, aud) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('format');
  const header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  if (header.alg !== 'RS256') throw new Error('alg');

  let keys = await accessKeys(teamDomain, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await accessKeys(teamDomain, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('kid');

  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== teamDomain) throw new Error('iss');
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) throw new Error('exp');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) throw new Error('nbf');
  if (aud) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new Error('aud');
  }
  return payload;
}

async function authenticate(request, env) {
  const url = new URL(request.url);
  // Nur für die lokale Entwicklung: DEV_SKIP_AUTH_EMAIL steht ausschließlich in .dev.vars (nicht im Repo,
  // nie im Dashboard setzen). wrangler dev läuft über http, die echte Seite immer über https.
  if (env.DEV_SKIP_AUTH_EMAIL && url.protocol === 'http:') {
    return { email: env.DEV_SKIP_AUTH_EMAIL };
  }
  const teamDomain = String(env.TEAM_DOMAIN || '').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const payload = await verifyAccessJwt(token, teamDomain, env.POLICY_AUD || '');
    return { email: payload.email || '' };
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ Datenbank (D1)

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, uuid TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, uuid))'
  ).run();
  schemaReady = true;
}

async function getData(env, user) {
  const { results } = await env.DB.prepare('SELECT kind, data FROM records').all();
  const out = { email: user.email, players: [], games: [], trainings: [] };
  for (const row of results) {
    if (!KINDS.has(row.kind)) continue;
    try { out[row.kind].push(JSON.parse(row.data)); } catch (e) { /* kaputter Eintrag: überspringen */ }
  }
  return json(out);
}

async function postSync(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return json({ error: 'content-type' }, 415);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'json' }, 400); }
  const ops = body && Array.isArray(body.ops) ? body.ops : null;
  if (!ops || ops.length > MAX_OPS) return json({ error: 'ops' }, 400);

  const now = new Date().toISOString();
  const statements = [];
  for (const op of ops) {
    if (!op || !KINDS.has(op.kind) || typeof op.uuid !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(op.uuid)) {
      return json({ error: 'op' }, 400);
    }
    if (op.data === null) {
      statements.push(env.DB.prepare('DELETE FROM records WHERE kind = ?1 AND uuid = ?2').bind(op.kind, op.uuid));
      continue;
    }
    if (typeof op.data !== 'object' || Array.isArray(op.data) || op.data.uuid !== op.uuid) return json({ error: 'data' }, 400);
    const text = JSON.stringify(op.data);
    if (text.length > MAX_RECORD_BYTES) return json({ error: 'too large' }, 413);
    statements.push(env.DB.prepare(
      'INSERT INTO records (kind, uuid, data, updated_at) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT (kind, uuid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
    ).bind(op.kind, op.uuid, text, now));
  }
  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true, count: statements.length });
}

// ------------------------------------------------------------ Einstieg

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const user = await authenticate(request, env);
    if (!user) return json({ error: 'Nicht angemeldet' }, 401);
    if (!env.DB) return json({ error: 'Datenbank nicht eingerichtet' }, 503);

    try {
      await ensureSchema(env.DB);
      if (url.pathname === '/api/data' && request.method === 'GET') return await getData(env, user);
      if (url.pathname === '/api/sync' && request.method === 'POST') return await postSync(request, env);
      return json({ error: 'Nicht gefunden' }, 404);
    } catch (e) {
      console.error('api error', e && e.stack || e);
      return json({ error: 'Serverfehler' }, 500);
    }
  }
};
