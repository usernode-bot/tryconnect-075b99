const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// The four ready-made kinds of cuan, as the spec fixes them.
const CATEGORIES = ['makanan', 'ojek', 'jualan', 'jasa'];

// Points: every fresh update on a zone earns a fixed amount, once per zone
// per member every 24 hours, so nobody can farm points.
const POINTS_PER_UPDATE = 10;
const UPDATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Data and demo rows are staging-only; the feature itself is not.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Schema ────────────────────────────────────────────────────────────────
// Applied idempotently on every boot (CREATE TABLE IF NOT EXISTS / ADD
// COLUMN IF NOT EXISTS), so a staging rebuild and a first production boot
// both land on the same shape.
//
// `zones` is public (the list IS the app); `zone_reports` carries who
// reported what, personal information beyond a public username, so it is
// marked `staging:private` and staging copies its schema without the rows.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zones (
      id serial PRIMARY KEY,
      author_id text NOT NULL,
      author_username text NOT NULL,
      name varchar(60) NOT NULL,
      category text NOT NULL CHECK (category = ANY(ARRAY['makanan','ojek','jualan','jasa']::text[])),
      note varchar(140) NOT NULL DEFAULT '',
      lat double precision,
      lng double precision,
      created_at timestamptz NOT NULL DEFAULT now(),
      is_demo boolean NOT NULL DEFAULT false,
      demo_key text UNIQUE
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zone_reports (
      id serial PRIMARY KEY,
      zone_id integer NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (zone_id, reporter_id)
    )`);
  // Which accounts have had their two demo zones written: a one-per-account
  // marker, so a zone the viewer deleted during the demo is not written
  // again on their next load.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_viewer_seeds (
      account_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    )`);
  // Updates members post on a zone: public like the zone itself, since the
  // zone detail shows them to everyone who can read zones.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zone_updates (
      id serial PRIMARY KEY,
      zone_id integer NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_username text NOT NULL,
      note varchar(140) NOT NULL DEFAULT '',
      photo_url text,
      photo_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      demo_key text UNIQUE
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS zone_updates_zone_author_idx
    ON zone_updates (zone_id, author_id, created_at DESC)`);
  // The points balance: one row per earned amount. Private — it carries
  // account ids and money-adjacent data, and it is the base for the rupiah
  // exchange later. Private-to-public FK (update_id) is allowed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS point_ledger (
      id serial PRIMARY KEY,
      account_id text NOT NULL,
      amount integer NOT NULL,
      reason text NOT NULL,
      update_id integer REFERENCES zone_updates(id) ON DELETE SET NULL,
      is_demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS point_ledger_account_idx
    ON point_ledger (account_id, is_demo)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS update_reports (
      id serial PRIMARY KEY,
      update_id integer NOT NULL REFERENCES zone_updates(id) ON DELETE CASCADE,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (update_id, reporter_id)
    )`);
  await pool.query(
    `COMMENT ON TABLE zone_reports IS 'staging:private'`);
  await pool.query(
    `COMMENT ON TABLE demo_viewer_seeds IS 'staging:private'`);
  await pool.query(
    `COMMENT ON TABLE point_ledger IS 'staging:private'`);
  await pool.query(
    `COMMENT ON TABLE update_reports IS 'staging:private'`);
}

// ── Staging demo ──────────────────────────────────────────────────────────
// A first version's populated demo (the "Staging demo" convention, first-
// version exception): staging only, `?demo=1` only, and two seeds.
//
// 1. On boot: ~8 zones by obviously fake people, fixed `demo_key`s, ON
//    CONFLICT DO NOTHING so a rebuild changes nothing.
// 2. On the first `GET /api/zones?demo=1` of an account: that viewer's two
//    zones, `demo_key viewer:<id>:1` / `:2`, so what the viewer deletes
//    stays deleted on reload. Demo rows never appear without `demo=1`, so
//    the plain route's empty state stays honest.
const DEMO_ORIGIN = { lat: -6.1450, lng: 106.7450 }; // a fixed spot in West Jakarta
const DEMO_ZONES = [
  { key: 'demo:1', name: 'Angkringan Pak Tono', category: 'makanan', note: 'Kopi dan sate jam 6 sampai 11 malam, ramai anak kos.', lat: -6.1428, lng: 106.7502 },
  { key: 'demo:2', name: 'Stasiun Palmerah', category: 'ojek', note: 'Penumpang keluar jam 17.00 sampai 19.00, antrean ojek cepat jalan.', lat: -6.2071, lng: 106.7966 },
  { key: 'demo:3', name: 'Lapangan Car Free Day', category: 'jualan', note: 'Minggu pagi, cocok untuk jual minuman dingin dan kaos.', lat: -6.1705, lng: 106.7590 },
  { key: 'demo:4', name: 'Kompleks Ruko Meruya', category: 'jasa', note: 'Banyak kantor kecil, butuh jasa cuci motor dan servis AC.', lat: -6.1971, lng: 106.7360 },
  { key: 'demo:5', name: 'Halte TransGlodok', category: 'ojek', note: 'Jam 8 pagi penumpang berebut, banyak tawaran antar kantor.', lat: -6.1312, lng: 106.6950 },
  { key: 'demo:6', name: 'Bazar Kampus Trisakti', category: 'jualan', note: 'Bazar bulanan, sewa lapak murah untuk pemula.', lat: -6.1573, lng: 106.7448 },
  { key: 'demo:7', name: 'Warung Kopi Cengkareng', category: 'makanan', note: 'Malam hari ramai anak kantor, butuh bantuan antar pesanan.', lat: -6.1550, lng: 106.7250 },
  { key: 'demo:8', name: 'Sentra Kreasi Podomoro', category: 'jasa', note: 'Butuh jasa servis sepeda dan laundry kilat tiap akhir bulan.', lat: -6.1630, lng: 106.7330 },
];
const DEMO_AUTHORS = ['Rina Contoh', 'Bagas Contoh', 'Dewi Contoh', 'Sari Contoh', 'Tono Contoh', 'Maya Contoh', 'Andra Contoh'];

async function seedDemoZones() {
  const rows = DEMO_ZONES.map((z, i) => [
    'demo-author:' + (i + 1), DEMO_AUTHORS[i % DEMO_AUTHORS.length],
    z.name, z.category, z.note, z.lat, z.lng, z.key,
  ]);
  // Older created_at for earlier rows, so "newest first" is stable.
  await pool.query(`
    INSERT INTO zones (author_id, author_username, name, category, note, lat, lng, is_demo, demo_key, created_at)
    SELECT * FROM unnest($1::text[], $2::text[], $3::varchar[], $4::text[], $5::varchar[], $6::float8[], $7::float8[], $8::boolean[], $9::text[], $10::timestamptz[])
    ON CONFLICT (demo_key) DO NOTHING`,
    [
      rows.map(r => r[0]), rows.map(r => r[1]), rows.map(r => r[2]), rows.map(r => r[3]),
      rows.map(r => r[4]), rows.map(r => r[5]), rows.map(r => r[6]),
      rows.map(() => true), rows.map(r => r[7]),
      rows.map((_, i) => new Date(Date.now() - (rows.length - i) * 36e5)),
    ]);
}

async function seedViewerDemoZones(user) {
  // The viewer's two zones, written once per account: the marker row is
  // the "once" — after the viewer deletes a demo zone, a reload does not
  // bring it back.
  const marker = await pool.query(
    'INSERT INTO demo_viewer_seeds (account_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING account_id',
    [String(user.id)]);
  if (marker.rowCount === 0) return;
  await pool.query(`
    INSERT INTO zones (author_id, author_username, name, category, note, lat, lng, is_demo, demo_key)
    VALUES
      ($1, $2, 'Pasar Pagi Kebon Jeruk', 'makanan', 'Ramai jam 5 sampai 8 pagi, pesanan sarapan banyak.', $3, $4, true, $5),
      ($1, $2, 'Terminal Kalideres', 'ojek', 'Sabtu malam penuh pemudik, tarif antar jauh lebih tinggi.', $6, $7, true, $8)
    ON CONFLICT (demo_key) DO NOTHING`,
    [String(user.id), user.username,
      -6.1482, 106.7489, 'viewer:' + user.id + ':1',
      -6.1470, 106.7025, 'viewer:' + user.id + ':2']);
}

// A few text-only updates by the demo zones' fake authors, written once on
// boot with fixed demo_keys. No ledger rows for fake authors: their points
// are never shown. Nothing is written for the viewer, so the cooldown and
// balance logic stay real on the demo route.
const DEMO_UPDATES = [
  { key: 'demo-update:1', zone: 'demo:2', author: 'Bagas Contoh', note: 'Sore ini antrean penumpang panjang di pintu selatan.', hoursAgo: 1 },
  { key: 'demo-update:2', zone: 'demo:2', author: 'Dewi Contoh', note: 'Hujan dari jam 4, pesanan antar naik.', hoursAgo: 5 },
  { key: 'demo-update:3', zone: 'demo:1', author: 'Rina Contoh', note: 'Malam ini buka sampai jam 12, ramai anak kos.', hoursAgo: 3 },
  { key: 'demo-update:4', zone: 'demo:3', author: 'Sari Contoh', note: 'Minggu ini lapak dipindah ke sisi timur lapangan.', hoursAgo: 26 },
];

async function seedDemoUpdates() {
  const { rows } = await pool.query("SELECT id, demo_key FROM zones WHERE demo_key LIKE 'demo:%'");
  const zoneIdByKey = {};
  rows.forEach(z => { zoneIdByKey[z.demo_key] = z.id; });
  const demo = DEMO_UPDATES.filter(u => zoneIdByKey[u.zone]);
  if (!demo.length) return;
  await pool.query(`
    INSERT INTO zone_updates (zone_id, author_id, author_username, note, created_at, demo_key)
    SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::varchar[], $5::timestamptz[], $6::text[])
    ON CONFLICT (demo_key) DO NOTHING`,
    [
      demo.map(u => zoneIdByKey[u.zone]),
      demo.map(u => 'demo-author:' + (DEMO_AUTHORS.indexOf(u.author) + 1)),
      demo.map(u => u.author),
      demo.map(u => u.note),
      demo.map(u => new Date(Date.now() - u.hoursAgo * 36e5)),
      demo.map(u => u.key),
    ]);
}

// ── The API ───────────────────────────────────────────────────────────────
// Sorting happens in the browser; these routes return rows and (in the
// demo) a fixed stand-in position for the viewer.

app.get('/api/zones', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    if (demo && req.user) await seedViewerDemoZones(req.user);
    const viewerId = req.user ? req.user.id : null;
    const { rows } = await pool.query(`
      SELECT id, author_id, author_username, name, category, note, lat, lng, created_at,
             (author_id = $1::text) AS mine
      FROM zones
      WHERE is_demo = $2::boolean
      ORDER BY created_at DESC`,
      [viewerId, demo]);
    // Each returned zone carries its five newest updates, newest first,
    // whether the viewer has reported each one, and the viewer's own last
    // update time on that zone (the 24 h cooldown). Guests read updates
    // too but have no report rows and no updates of their own.
    if (rows.length) {
      const ids = rows.map(r => r.id);
      const { rows: updRows } = await pool.query(`
        SELECT zone_id, id, author_id, author_username, note, photo_url, created_at,
               (author_id = $2::text) AS mine,
               EXISTS (SELECT 1 FROM update_reports ur
                       WHERE ur.update_id = zone_updates.id AND ur.reporter_id = $2::text) AS reported,
               row_number() OVER (PARTITION BY zone_id ORDER BY created_at DESC) AS rn
        FROM zone_updates
        WHERE zone_id = ANY($1::int[])`,
        [ids, viewerId]);
      const byZone = {};
      updRows.forEach(u => {
        if (Number(u.rn) > 5) return;
        (byZone[u.zone_id] = byZone[u.zone_id] || []).push({
          id: u.id, author_username: u.author_username, note: u.note,
          photo_url: u.photo_url, created_at: u.created_at,
          mine: u.mine || false, reported: u.reported || false,
        });
      });
      const lastByZone = {};
      if (req.user) {
        const { rows: lastRows } = await pool.query(`
          SELECT zone_id, MAX(created_at) AS last_at
          FROM zone_updates
          WHERE author_id = $1::text AND zone_id = ANY($2::int[])
          GROUP BY zone_id`, [viewerId, ids]);
        lastRows.forEach(r => { lastByZone[r.zone_id] = r.last_at; });
      }
      rows.forEach(z => {
        z.updates = byZone[z.id] || [];
        z.my_last_update_at = lastByZone[z.id] || null;
      });
    }
    // The viewer's point balance for this mode; guests have none. Demo
    // points never mix with real ones.
    let points = null;
    if (req.user) {
      const { rows: [bal] } = await pool.query(
        'SELECT COALESCE(SUM(amount), 0)::int AS points FROM point_ledger WHERE account_id = $1::text AND is_demo = $2::boolean',
        [viewerId, demo]);
      points = bal.points;
    }
    res.json({ zones: rows, demoOrigin: demo ? DEMO_ORIGIN : null, points });
  } catch (err) {
    console.error('GET /api/zones failed', err);
    res.status(500).json({ error: 'gagal_memuat' });
  }
});

// Coordinates a client may hand us: inside Indonesia's rough bounds, so a
// stray or absurd value is refused rather than saved. Rounded to 4 decimals
// (~11 m) before saving, which is fine for a zone.
function cleanCoords(lat, lng) {
  if (lat === undefined || lat === null || lng === undefined || lng === null) {
    return { lat: null, lng: null };
  }
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return { lat: null, lng: null };
  if (la < -11.5 || la > 6.5 || ln < 94.5 || ln > 141.5) return null;
  return { lat: Math.round(la * 10000) / 10000, lng: Math.round(ln * 10000) / 10000 };
}

// A photo URL a client may hand us with an update: only a file the
// platform's own storage returned (its /app-files/ path and 32-hex id),
// never an outside image host or a data URI. Nothing is accepted when the
// platform origin is unknown.
const HEX32 = /^[0-9a-f]{32}$/;
function cleanPhotoUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  if (!PLATFORM_ORIGIN) return null;
  const trimmed = url.trim();
  const prefix = PLATFORM_ORIGIN + '/app-files/';
  if (!trimmed.startsWith(prefix)) return null;
  return HEX32.test(trimmed.slice(prefix.length)) ? trimmed : null;
}

function cleanPhotoId(id) {
  return typeof id === 'string' && HEX32.test(id) ? id : null;
}

app.post('/api/zones', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    const category = req.body.category;
    if (!name || name.length > 60) return res.status(400).json({ error: 'Nama zona wajib diisi, paling banyak 60 huruf.' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Pilih salah satu jenis cuan.' });
    if (note.length > 140) return res.status(400).json({ error: 'Catatan singkat paling banyak 140 huruf.' });
    const coords = cleanCoords(req.body.lat, req.body.lng);
    if (coords === null) return res.status(400).json({ error: 'Lokasi tidak valid.' });
    const { rows: [row] } = await pool.query(`
      INSERT INTO zones (author_id, author_username, name, category, note, lat, lng, is_demo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, author_id, author_username, name, category, note, lat, lng, created_at,
                (author_id = $1::text) AS mine`,
      [req.user.id, req.user.username, name, category, note, coords.lat, coords.lng, IS_STAGING && req.query.demo === '1']);
    res.status(201).json({ zone: row });
  } catch (err) {
    console.error('POST /api/zones failed', err);
    res.status(500).json({ error: 'gagal_menyimpan' });
  }
});

app.delete('/api/zones/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const zoneId = Number(req.params.id);
    if (!Number.isInteger(zoneId)) return res.status(400).json({ error: 'Zona tidak ditemukan.' });
    const { rows: [zone] } = await pool.query(
      'SELECT author_id FROM zones WHERE id = $1::int', [zoneId]);
    if (!zone) return res.status(404).json({ error: 'Zona tidak ditemukan.' });
    // Token ids arrive as numbers, author_id is text: compare as strings.
    if (String(zone.author_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Zona ini bukan tambahan kamu.' });
    }
    await pool.query('DELETE FROM zones WHERE id = $1::int', [zoneId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/zones/:id failed', err);
    res.status(500).json({ error: 'gagal_menghapus' });
  }
});

app.post('/api/zones/:id/report', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const zoneId = Number(req.params.id);
    if (!Number.isInteger(zoneId)) return res.status(400).json({ error: 'Zona tidak ditemukan.' });
    const { rows: [zone] } = await pool.query(
      'SELECT author_id FROM zones WHERE id = $1::int', [zoneId]);
    if (!zone) return res.status(404).json({ error: 'Zona tidak ditemukan.' });
    if (String(zone.author_id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Zona ini tambahan kamu sendiri.' });
    }
    await pool.query(
      'INSERT INTO zone_reports (zone_id, reporter_id, created_at) VALUES ($1::int, $2, $3) ON CONFLICT DO NOTHING',
      [zoneId, req.user.id, req.now]);
    // A report never hides the zone; it is only recorded.
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/zones/:id/report failed', err);
    res.status(500).json({ error: 'gagal_melaporkan' });
  }
});

// Send an update on a zone: a short note, an optional platform-stored
// photo, or both. Earns POINTS_PER_UPDATE, once per zone per member every
// UPDATE_COOLDOWN_MS. Body validation runs before the cooldown check, so
// the client's empty guest probe never consumes a cooldown.
app.post('/api/zones/:id/updates', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const zoneId = Number(req.params.id);
    if (!Number.isInteger(zoneId)) return res.status(400).json({ error: 'Zona tidak ditemukan.' });
    const { rows: [zone] } = await pool.query(
      'SELECT id, is_demo FROM zones WHERE id = $1::int', [zoneId]);
    if (!zone) return res.status(404).json({ error: 'Zona tidak ditemukan.' });
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (note.length > 140) return res.status(400).json({ error: 'Catatan singkat paling banyak 140 huruf.' });
    const photoUrl = cleanPhotoUrl(req.body.photo_url);
    if (req.body.photo_url && photoUrl === null) {
      return res.status(400).json({ error: 'Foto tidak valid.' });
    }
    const photoId = cleanPhotoId(req.body.photo_id);
    if (req.body.photo_id && photoId === null) {
      return res.status(400).json({ error: 'Foto tidak valid.' });
    }
    if (!note && !photoUrl) return res.status(400).json({ error: 'Isi catatan singkat atau tambah foto.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the zone row so two quick submits wait in line and only the
      // first one inside the cooldown earns points.
      const { rows: [locked] } = await client.query(
        'SELECT id FROM zones WHERE id = $1::int FOR UPDATE', [zoneId]);
      if (!locked) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Zona tidak ditemukan.' });
      }
      const { rows: [last] } = await client.query(`
        SELECT created_at FROM zone_updates
        WHERE zone_id = $1::int AND author_id = $2::text
        ORDER BY created_at DESC LIMIT 1`,
        [zoneId, req.user.id]);
      if (last && new Date(last.created_at).getTime() > req.now.getTime() - UPDATE_COOLDOWN_MS) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: 'Kamu sudah kirim update untuk zona ini. Coba lagi besok.',
          next_at: new Date(new Date(last.created_at).getTime() + UPDATE_COOLDOWN_MS).toISOString(),
        });
      }
      const { rows: [upd] } = await client.query(`
        INSERT INTO zone_updates (zone_id, author_id, author_username, note, photo_url, photo_id, created_at)
        VALUES ($1::int, $2, $3, $4, $5, $6, $7)
        RETURNING id, note, photo_url, created_at`,
        [zoneId, req.user.id, req.user.username, note, photoUrl, photoId, req.now]);
      // The ledger's is_demo copies the zone's, so demo points never mix
      // with real ones. Points stay earned even if the zone or update is
      // later deleted (SET NULL keeps the row).
      await client.query(`
        INSERT INTO point_ledger (account_id, amount, reason, update_id, is_demo, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user.id, POINTS_PER_UPDATE, 'zone_update', upd.id, zone.is_demo, req.now]);
      const { rows: [bal] } = await client.query(
        'SELECT COALESCE(SUM(amount), 0)::int AS points FROM point_ledger WHERE account_id = $1::text AND is_demo = $2::boolean',
        [req.user.id, zone.is_demo]);
      await client.query('COMMIT');
      res.status(201).json({
        update: {
          id: upd.id, author_username: req.user.username, note: upd.note,
          photo_url: upd.photo_url, created_at: upd.created_at, mine: true, reported: false,
        },
        points: bal.points,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/zones/:id/updates failed', err);
    res.status(500).json({ error: 'gagal_menyimpan' });
  }
});

// Report an update. Like reporting a zone: recorded, never hidden, and no
// points are taken away.
app.post('/api/updates/:id/report', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const updateId = Number(req.params.id);
    if (!Number.isInteger(updateId)) return res.status(400).json({ error: 'Update tidak ditemukan.' });
    const { rows: [upd] } = await pool.query(
      'SELECT author_id FROM zone_updates WHERE id = $1::int', [updateId]);
    if (!upd) return res.status(404).json({ error: 'Update tidak ditemukan.' });
    if (String(upd.author_id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Update ini kiriman kamu sendiri.' });
    }
    await pool.query(
      'INSERT INTO update_reports (update_id, reporter_id, created_at) VALUES ($1::int, $2, $3) ON CONFLICT DO NOTHING',
      [updateId, req.user.id, req.now]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/updates/:id/report failed', err);
    res.status(500).json({ error: 'gagal_melaporkan' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/tryconnect-075b99/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/tryconnect-075b99/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await migrate();
  // The demo exists only on staging, and its fake authors are seeded once
  // per boot; a viewer's own rows are written on their first ?demo=1 read.
  if (IS_STAGING) { await seedDemoZones(); await seedDemoUpdates(); }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting connections, drain what is in flight, close the pool.
  const shutdown = (signal) => {
    console.log(signal + ': shutting down');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => pool.end().then(() => process.exit(0)), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
