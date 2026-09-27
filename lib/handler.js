// Tárgyaló API – egyetlen függvény kezeli az összes /api/* kérést.
// Vercelen serverless függvényként fut, helyben a dev-server.js hívja.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, kind: dbKind, findEnv } = require('./db');

const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 500;
// Az újabb Vercel Blob tárolók token helyett OIDC-vel (BLOB_STORE_ID) kötődnek be
const BLOB_TOKEN = findEnv('BLOB_READ_WRITE_TOKEN') || findEnv('READ_WRITE_TOKEN');
const BLOB_STORE_ID = findEnv('BLOB_STORE_ID');
const STORAGE = BLOB_TOKEN || BLOB_STORE_ID ? 'blob' : process.env.VERCEL ? 'none' : 'local';
const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');
const PRESENCE_TTL_MS = 40 * 1000;
const SESSION_TTL_S = 90 * 24 * 3600;
const LOCK_AFTER = 5;
const LOCK_S = 5 * 60;

const COLORS = ['#7c5cff', '#22c1a4', '#ff7a59', '#3b9cff', '#f5b73b', '#e0529c'];
const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, color: u.color });
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

// ---------------------------------------------------------------------------
// Adatok
// ---------------------------------------------------------------------------
const getUsers = async () => (await db.get('users')) || [];
const getMeetings = async () => (await db.get('meetings')) || [];

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

function checkPin(user, pin) {
  const a = Buffer.from(hashPin(pin, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createSession(user) {
  const token = newId(24);
  await db.set(`sess:${token}`, { userId: user.id }, { ex: SESSION_TTL_S });
  return token;
}

async function auth(ctx) {
  const header = ctx.req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : ctx.body?.token || ctx.query.token;
  if (!token || typeof token !== 'string') fail(401, 'Lépj be újra.');
  const userId = (await db.get(`sess:${token}`))?.userId;
  const user = userId && (await getUsers()).find((u) => u.id === userId);
  if (!user) fail(401, 'Lejárt a munkamenet, lépj be újra.');
  ctx.token = token;
  return user;
}

// ---------------------------------------------------------------------------
// Jelenlét: minden böngészőfül ide jelentkezik be pár másodpercenként.
// Egy hash tárol mindent: clientId -> { userId, roomId, peerId, state, since, t }
// ---------------------------------------------------------------------------
async function readPresence() {
  const all = (await db.hgetall('presence')) || {};
  const now = Date.now();
  const fresh = {};
  const stale = [];
  for (const [clientId, p] of Object.entries(all)) {
    if (p && now - p.t < PRESENCE_TTL_MS) fresh[clientId] = p;
    else stale.push(clientId);
  }
  if (stale.length) await db.hdel('presence', ...stale);
  return fresh;
}

function liveRooms(presence, usersById) {
  const live = {};
  for (const p of Object.values(presence)) {
    if (!p.roomId || !usersById[p.userId]) continue;
    const list = (live[p.roomId] ||= []);
    if (!list.some((u) => u.id === p.userId)) list.push(publicUser(usersById[p.userId]));
  }
  return live;
}

function meetingView(m, usersById, live) {
  const creator = usersById[m.createdBy];
  return { ...m, creator: creator ? publicUser(creator) : null, live: live[m.id] || [] };
}

const byId = (users) => Object.fromEntries(users.map((u) => [u.id, u]));

// ---------------------------------------------------------------------------
// Útvonalak
// ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route('GET', /^config$/, async () => ({
  allowRegistration: ALLOW_REGISTRATION,
  maxUploadMb: MAX_UPLOAD_MB,
  storage: STORAGE,
  blobMode: BLOB_TOKEN ? 'token' : 'presigned',
  db: dbKind,
}));

// A belépő képernyő listázza a fiókokat, hogy csak rá kelljen kattintani
route('GET', /^users$/, async () => (await getUsers()).map(publicUser));

route('POST', /^register$/, async ({ body }) => {
  if (!ALLOW_REGISTRATION) fail(403, 'A regisztráció le van zárva.');
  const name = clean(body.name, 32);
  const role = clean(body.role, 40);
  const { pin, pin2 } = body;
  if (name.length < 2) fail(400, 'A név legalább 2 karakter legyen.');
  if (!role) fail(400, 'Add meg a szereped.');
  if (!/^\d{4}$/.test(pin || '')) fail(400, 'A kód pontosan 4 számjegy.');
  if (pin !== pin2) fail(400, 'A két kód nem egyezik.');

  const users = await getUsers();
  if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) fail(400, 'Ez a név már foglalt.');
  const salt = newId(16);
  const user = {
    id: newId(),
    name,
    role,
    color: COLORS[users.length % COLORS.length],
    salt,
    hash: hashPin(pin, salt),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await db.set('users', users);
  return { token: await createSession(user), user: publicUser(user) };
});

route('POST', /^login$/, async ({ body }) => {
  const name = clean(body.name, 32).toLowerCase();
  const pin = String(body.pin || '');
  const key = `att:${name}`;
  if (Number(await db.get(key)) >= LOCK_AFTER) fail(429, 'Túl sok rossz próbálkozás. Várj 5 percet.');

  const user = (await getUsers()).find((u) => u.name.toLowerCase() === name);
  if (!user || !checkPin(user, pin)) {
    const count = await db.incr(key);
    await db.expire(key, LOCK_S);
    const left = LOCK_AFTER - count;
    fail(401, left > 0 ? `Hibás kód. Még ${left} próbálkozás.` : 'Hibás kód. 5 percre zárolva.');
  }
  await db.del(key);
  return { token: await createSession(user), user: publicUser(user) };
});

route('GET', /^me$/, async (ctx) => ({ user: publicUser(await auth(ctx)) }));

route('POST', /^logout$/, async (ctx) => {
  await auth(ctx);
  await db.del(`sess:${ctx.token}`);
  return { ok: true };
});

// Szívverés: jelenlét frissítése + minden, ami a főoldalhoz és a híváshoz kell
route('POST', /^presence$/, async (ctx) => {
  const user = await auth(ctx);
  const { body } = ctx;
  const clientId = clean(body.clientId, 40);
  if (!clientId) fail(400, 'Hiányzó clientId.');

  if (body.gone) {
    await db.hdel('presence', clientId);
    return { ok: true };
  }

  const roomId = clean(body.roomId, 20) || null;
  const s = body.state || {};
  await db.hset('presence', {
    [clientId]: {
      userId: user.id,
      roomId,
      peerId: roomId ? clean(body.peerId, 64) || null : null,
      since: Number(body.since) || Date.now(),
      state: { mic: !!s.mic, cam: !!s.cam, screen: !!s.screen },
      t: Date.now(),
    },
  });

  const [presence, [users, meetings], msgCount] = await Promise.all([
    readPresence(),
    db.mget('users', 'meetings'),
    roomId ? db.llen(`msgs:${roomId}`) : 0,
  ]);
  const usersById = byId(users || []);
  const live = liveRooms(presence, usersById);
  const members = roomId
    ? Object.entries(presence)
        .filter(([id, p]) => id !== clientId && p.roomId === roomId && p.peerId && usersById[p.userId])
        .map(([id, p]) => ({ clientId: id, peerId: p.peerId, since: p.since, state: p.state, user: publicUser(usersById[p.userId]) }))
    : [];

  return {
    online: [...new Set(Object.values(presence).map((p) => p.userId))],
    live,
    users: (users || []).map(publicUser),
    meetings: (meetings || [])
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
      .map((m) => meetingView(m, usersById, live)),
    members,
    msgCount,
  };
});

// --- Meetingek -------------------------------------------------------------
route('GET', /^meetings\/([a-f0-9]+)$/, async (ctx, id) => {
  await auth(ctx);
  const [meetings, users, presence] = await Promise.all([getMeetings(), getUsers(), readPresence()]);
  const m = meetings.find((x) => x.id === id);
  if (!m) fail(404, 'Nincs ilyen meeting.');
  const usersById = byId(users);
  return meetingView(m, usersById, liveRooms(presence, usersById));
});

route('POST', /^meetings$/, async (ctx) => {
  const user = await auth(ctx);
  const { body } = ctx;
  const instant = !!body.instant;
  const title = clean(body.title, 80) || (instant ? 'Azonnali meeting' : '');
  const description = clean(body.description, 600);
  const startsAt = instant ? new Date() : new Date(body.startsAt);
  const durationMin = Math.min(Math.max(Number(body.durationMin) || 30, 5), 600);
  if (!title) fail(400, 'Adj nevet a meetingnek.');
  if (Number.isNaN(startsAt.getTime())) fail(400, 'Érvénytelen időpont.');

  const meeting = {
    id: newId(5),
    title,
    description,
    startsAt: startsAt.toISOString(),
    durationMin,
    createdBy: user.id,
    createdAt: new Date().toISOString(),
  };
  const meetings = await getMeetings();
  meetings.push(meeting);
  await db.set('meetings', meetings);
  return { ...meeting, creator: publicUser(user), live: [] };
});

route('DELETE', /^meetings\/([a-f0-9]+)$/, async (ctx, id) => {
  const user = await auth(ctx);
  const meetings = await getMeetings();
  const m = meetings.find((x) => x.id === id);
  if (!m) fail(404, 'Nincs ilyen meeting.');
  if (m.createdBy !== user.id) fail(403, 'Csak a szervező törölheti.');
  await db.set('meetings', meetings.filter((x) => x !== m));
  await db.del(`msgs:${id}`);
  return { ok: true };
});

// --- Chat ------------------------------------------------------------------
route('GET', /^rooms\/([a-f0-9]+)\/messages$/, async (ctx, id) => {
  await auth(ctx);
  const since = Math.max(Number(ctx.query.since) || 0, 0);
  return db.lrange(`msgs:${id}`, since, -1);
});

const validFileUrl = (url) =>
  typeof url === 'string' &&
  (STORAGE === 'local' ? url.startsWith('/uploads/') : /^https:\/\/[a-z0-9.-]+\.blob\.vercel-storage\.com\//i.test(url));

route('POST', /^rooms\/([a-f0-9]+)\/messages$/, async (ctx, id) => {
  const user = await auth(ctx);
  const { body } = ctx;
  if (!(await getMeetings()).some((m) => m.id === id)) fail(404, 'Nincs ilyen meeting.');

  const msg = { id: newId(), user: publicUser(user), ts: new Date().toISOString() };
  if (body.type === 'file') {
    const f = body.file || {};
    if (!validFileUrl(f.url)) fail(400, 'Érvénytelen fájl.');
    msg.type = 'file';
    msg.file = {
      name: clean(f.name, 200) || 'fájl',
      size: Number(f.size) || 0,
      mime: clean(f.mime, 100) || 'application/octet-stream',
      url: f.url,
      downloadUrl: typeof f.downloadUrl === 'string' && validFileUrl(f.downloadUrl) ? f.downloadUrl : f.url,
    };
  } else {
    const text = clean(body.text, 4000);
    if (!text) fail(400, 'Üres üzenet.');
    msg.type = 'text';
    msg.text = text;
  }
  const key = `msgs:${id}`;
  await db.rpush(key, msg);
  await db.ltrim(key, -1000, -1);
  return msg;
});

// --- Fájlfeltöltés ---------------------------------------------------------
// Vercel Blob: a böngésző közvetlenül a Blobba tölt fel, ez csak engedélyt ad.
// OIDC-s tárolónál aláírt (presigned) URL-t adunk, régebbinél kliens tokent.
async function uploadUserId(clientPayload) {
  const userId = clientPayload && (await db.get(`sess:${clientPayload}`))?.userId;
  if (!userId) fail(401, 'Lépj be újra.');
  return userId;
}

route('POST', /^upload$/, async (ctx) => {
  if (STORAGE !== 'blob') fail(503, 'A fájltároló (Vercel Blob) nincs bekötve.');
  const maximumSizeInBytes = MAX_UPLOAD_MB * 1024 * 1024;

  if (ctx.body?.type === 'blob.generate-presigned-url') {
    const { handleUploadPresigned } = require('@vercel/blob/client');
    const { issueSignedToken } = require('@vercel/blob');
    return handleUploadPresigned({
      body: ctx.body,
      request: ctx.req,
      getSignedToken: async (pathname, clientPayload) => {
        await uploadUserId(clientPayload);
        const token = await issueSignedToken({
          pathname,
          operations: ['put'],
          maximumSizeInBytes,
          validUntil: Date.now() + 60 * 60 * 1000,
        });
        return { token, urlOptions: { addRandomSuffix: true } };
      },
    });
  }

  const { handleUpload } = require('@vercel/blob/client');
  return handleUpload({
    token: BLOB_TOKEN,
    body: ctx.body,
    request: ctx.req,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const userId = await uploadUserId(clientPayload);
      return { maximumSizeInBytes, addRandomSuffix: true, tokenPayload: JSON.stringify({ userId }) };
    },
  });
});

// Helyi fejlesztéshez: a fájl a data/uploads mappába kerül
route('POST', /^local-upload$/, async (ctx) => {
  if (STORAGE !== 'local') fail(404, 'Nem elérhető.');
  await auth(ctx);
  const id = newId(16);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(path.join(UPLOAD_DIR, id));
    ctx.req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_MB * 1024 * 1024) {
        ctx.req.destroy();
        reject(new HttpError(413, `Maximum ${MAX_UPLOAD_MB} MB tölthető fel.`));
      }
    });
    ctx.req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  const name = clean(ctx.query.name, 200) || 'fájl';
  const url = `/uploads/${id}?name=${encodeURIComponent(name)}`;
  return { url, downloadUrl: `${url}&download=1`, size };
});

// ---------------------------------------------------------------------------
// Belépési pont
// ---------------------------------------------------------------------------
async function readBody(req) {
  try {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
  } catch {
    return {};
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const apiPath = (query.__path ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  const method = req.method.toUpperCase();

  try {
    if (dbKind === 'missing' && apiPath !== 'config') {
      fail(503, 'Nincs adatbázis bekötve. Vercelen: Storage → Upstash for Redis → Connect, majd Redeploy.');
    }
    for (const r of routes) {
      const m = r.method === method && apiPath.match(r.pattern);
      if (!m) continue;
      const streaming = apiPath === 'local-upload';
      const ctx = { req, res, query, body: method === 'GET' || streaming ? {} : await readBody(req) };
      const result = await r.fn(ctx, ...m.slice(1));
      return send(res, 200, result);
    }
    fail(404, 'Ismeretlen végpont.');
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    send(res, err.status || 500, { error: err instanceof HttpError ? err.message : err.message || 'Szerverhiba.' });
  }
};
