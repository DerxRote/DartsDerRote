/*
 * Darts Counter – Server für den Freunde-Bereich.
 *
 * Statische Dateien liefert Cloudflare direkt aus (Ordner public/). Dieser Worker läuft nur für /api/*.
 * Davor sitzt Cloudflare Access: Nur eingeladene E-Mail-Adressen kommen durch. Zusätzlich prüft der Worker
 * das von Access signierte Token (Header Cf-Access-Jwt-Assertion), damit niemand Access umgehen kann.
 *
 * Anmelden (Login-Code per E-Mail) kann sich jeder. Mitspielen darf aber nur, wer einmal den geheimen
 * Einladungscode eingegeben hat (Worker-Secret INVITE_CODE). Freigeschaltete E-Mail-Adressen stehen in der
 * Tabelle members. Alle anderen Daten (Spieler, Spiele, Trainings) sind gemeinsam für alle Mitglieder.
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
    return { email: normEmail(env.DEV_SKIP_AUTH_EMAIL) };
  }
  const teamDomain = String(env.TEAM_DOMAIN || '').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const payload = await verifyAccessJwt(token, teamDomain, env.POLICY_AUD || '');
    return { email: normEmail(payload.email) };
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ Datenbank (D1)

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, uuid TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, uuid))'),
    db.prepare('CREATE TABLE IF NOT EXISTS members (email TEXT PRIMARY KEY, joined_at TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS join_attempts (email TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL)')
  ]);
  schemaReady = true;
}

// ------------------------------------------------------------ Einladungscode

const MAX_FAILURES = 5;            // falsche Versuche pro E-Mail …
const FAILURE_WINDOW = 3600;       // … pro Stunde

const normEmail = (e) => String(e || '').trim().toLowerCase();

async function isMember(env, email) {
  if (!email) return false;
  const row = await env.DB.prepare('SELECT 1 AS ok FROM members WHERE email = ?1').bind(email).first();
  return !!row;
}

// Vergleich in konstanter Zeit, damit die Antwortzeit nichts über den Code verrät.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const normCode = (c) => String(c || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function postJoin(request, env, user) {
  const bad = checkPost(request); if (bad) return bad;
  const secret = normCode(env.INVITE_CODE);
  if (!secret) return json({ error: 'no_code', message: 'Es ist noch kein Einladungscode eingerichtet.' }, 503);
  if (!user.email) return json({ error: 'no_email' }, 400);
  if (await isMember(env, user.email)) return json({ ok: true, member: true });

  const now = Math.floor(Date.now() / 1000);
  // Abgelaufene Zählungen falscher Versuche entfernen (Datensparsamkeit, siehe Datenschutzerklärung).
  await env.DB.prepare('DELETE FROM join_attempts WHERE ?1 - window_start >= ?2').bind(now, FAILURE_WINDOW).run();
  const att = await env.DB.prepare('SELECT failures, window_start FROM join_attempts WHERE email = ?1').bind(user.email).first();
  const inWindow = att && now - att.window_start < FAILURE_WINDOW;
  if (inWindow && att.failures >= MAX_FAILURES) {
    return json({ error: 'too_many', message: 'Zu viele falsche Versuche. Bitte in einer Stunde noch einmal probieren.' }, 429);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'json' }, 400); }
  const code = normCode(body && body.code);
  if (code && code.length <= 200 && await sameSecret(code, secret)) {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO members (email, joined_at) VALUES (?1, ?2)').bind(user.email, new Date().toISOString()),
      env.DB.prepare('DELETE FROM join_attempts WHERE email = ?1').bind(user.email)
    ]);
    return json({ ok: true, member: true });
  }
  await env.DB.prepare(
    'INSERT INTO join_attempts (email, failures, window_start) VALUES (?1, 1, ?2) ' +
    'ON CONFLICT (email) DO UPDATE SET failures = CASE WHEN ?2 - window_start < ?3 THEN failures + 1 ELSE 1 END, ' +
    'window_start = CASE WHEN ?2 - window_start < ?3 THEN window_start ELSE ?2 END'
  ).bind(user.email, now, FAILURE_WINDOW).run();
  return json({ error: 'wrong_code', message: 'Der Code stimmt nicht.' }, 400);
}

function checkPost(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'origin' }, 403);
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return json({ error: 'content-type' }, 415);
  return null;
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
  const bad = checkPost(request); if (bad) return bad;

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
      if (url.pathname === '/api/join' && request.method === 'POST') return await postJoin(request, env, user);
      const member = await isMember(env, user.email);
      if (url.pathname === '/api/me' && request.method === 'GET') return json({ email: user.email, member });
      if (!member) return json({ error: 'not_member', email: user.email }, 403);
      if (url.pathname === '/api/data' && request.method === 'GET') return await getData(env, user);
      if (url.pathname === '/api/sync' && request.method === 'POST') return await postSync(request, env);
      return json({ error: 'Nicht gefunden' }, 404);
    } catch (e) {
      console.error('api error', e && e.stack || e);
      return json({ error: 'Serverfehler' }, 500);
    }
  }
};
