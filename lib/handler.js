// Tárgyaló API – egyetlen függvény kezeli az összes /api/* kérést.
// Vercelen serverless függvényként fut, helyben a dev-server.js hívja.
//
// Biztonság röviden:
// - munkamenet csak HttpOnly + SameSite=Strict sütiben, a szerveren csak a hash-e van
// - a PIN scrypt + titkos „bors” (PIN_PEPPER), így adatbázis-szivárgásból sem törhető
// - ismeretlen eszközről egyre hosszabb zárolás (15 perc → 24 óra), a saját
//   megbízható eszközöd közben is be tud lépni; minden hibás próbálkozásról értesítés
// - kérés-korlátok minden végponton, Origin ellenőrzés, csak JSON
// - a fájlok privátak, csak belépve, pár percig érvényes aláírt linkkel érhetők el
// - kötelező kétlépcsős azonosítás (TOTP): PIN + hitelesítő app 6 jegyű kódja

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, kind: dbKind, findEnv } = require('./db');

const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 500;
const PEPPER = process.env.PIN_PEPPER || '';
// Az újabb Vercel Blob tárolók token helyett OIDC-vel (BLOB_STORE_ID) kötődnek be
const BLOB_TOKEN = findEnv('BLOB_READ_WRITE_TOKEN') || findEnv('READ_WRITE_TOKEN');
const BLOB_STORE_ID = findEnv('BLOB_STORE_ID');
const STORAGE = BLOB_TOKEN || BLOB_STORE_ID ? 'blob' : process.env.VERCEL ? 'none' : 'local';
const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');

const PRESENCE_TTL_MS = 40 * 1000;
const SESSION_TTL_S = 30 * 24 * 3600;
const DEVICE_TTL_S = 365 * 24 * 3600;
const FILE_LINK_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const COLORS = ['#7c5cff', '#22c1a4', '#ff7a59', '#3b9cff', '#f5b73b', '#e0529c'];
const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, color: u.color });
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const MEETING_ID = '([a-f0-9]{10})';

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, message, code) => {
  throw new HttpError(status, message, code);
};

// ---------------------------------------------------------------------------
// Rangok: a CEO és a CTO fix (FIXED_ROLES, pl. "kilian:CEO,krisz:CTO"),
// ezeket senki nem kaphatja meg és nem veheti el. Mindenki más alapból Alkalmazott.
// ---------------------------------------------------------------------------
const DEFAULT_ROLE = 'Alkalmazott';
const LOCKED_ROLES = ['CEO', 'CTO'];
const BUILTIN_ROLES = ['CEO', 'CTO', 'Programozó', DEFAULT_ROLE];
const FIXED_ROLES = Object.fromEntries(
  String(process.env.FIXED_ROLES || '')
    .split(',')
    .map((pair) => pair.split(':').map((x) => x.trim()))
    .filter(([name, role]) => name && LOCKED_ROLES.includes(role))
    .map(([name, role]) => [name.toLowerCase(), role])
);

function normalizeRoles(users) {
  for (const u of users) {
    const fixed = FIXED_ROLES[u.name.toLowerCase()];
    if (fixed) u.role = fixed;
    else if (!u.role || LOCKED_ROLES.includes(u.role)) u.role = DEFAULT_ROLE;
  }
  return users;
}

const getRoles = async () => [...BUILTIN_ROLES, ...((await db.get('roles')) || [])];
const isLocked = (user) => !!FIXED_ROLES[user.name.toLowerCase()];

// ---------------------------------------------------------------------------
// Adatok
// ---------------------------------------------------------------------------
const getUsers = async () => normalizeRoles((await db.get('users')) || []);
const getMeetings = async () => (await db.get('meetings')) || [];
const byId = (users) => Object.fromEntries(users.map((u) => [u.id, u]));

// ---------------------------------------------------------------------------
// PIN: v1 = scrypt(pin), v2 = scrypt(HMAC(bors, pin)) erősebb paraméterekkel.
// A régi fiókok belépéskor automatikusan v2-re frissülnek.
// ---------------------------------------------------------------------------
const SCRYPT_V2 = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPin(pin, salt, v = 2) {
  if (v === 1) return crypto.scryptSync(pin, salt, 32).toString('hex');
  const peppered = crypto.createHmac('sha256', PEPPER).update(pin).digest();
  return crypto.scryptSync(peppered, salt, 32, SCRYPT_V2).toString('hex');
}

function checkPin(user, pin) {
  const a = Buffer.from(hashPin(pin, user.salt, user.v || 1), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Kétlépcsős azonosítás (TOTP, RFC 6238): 30 mp-es lépés, 6 számjegy, ±1 lépés
// tűrés. A titkos kulcs AES-256-GCM-mel titkosítva van az adatbázisban, a
// felhasznált lépést eltároljuk, így egy kód nem használható fel kétszer.
// ---------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// A kód lépésszámát adja vissza, ha érvényes és még nem használták
function checkTotp(secretB32, code, lastStep = 0) {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const a = Buffer.from(totpAt(secretB32, step));
    if (crypto.timingSafeEqual(a, Buffer.from(code))) return step;
  }
  return null;
}

const totpKey = () => crypto.createHash('sha256').update(`totp:${PEPPER}`).digest();

function sealSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', totpKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

function openSecret(sealed) {
  const [iv, tag, ct] = String(sealed).split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', totpKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const recoveryHash = (code) => sha(`recovery:${PEPPER}:${code.toLowerCase().replace(/[^a-z2-7]/g, '')}`);

function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const c = base32Encode(crypto.randomBytes(5)).toLowerCase(); // 8 karakter
    return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
  });
}

const mfaInfo = (user) => ({ enabled: !!user.totp, recoveryLeft: user.recovery?.length || 0 });

// ---------------------------------------------------------------------------
// Sütik, munkamenetek, megbízható eszközök
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (req) => !!process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https';
// A __Host- előtag garantálja, hogy a süti csak HTTPS-en és csak erre a domainre él
const cookieName = (req, base) => (isHttps(req) ? `__Host-${base}` : base);

function setCookie(ctx, base, value, maxAge) {
  const secure = isHttps(ctx.req) ? '; Secure' : '';
  ctx.cookies.push(`${cookieName(ctx.req, base)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

function clientIp(req) {
  return (
    req.headers['x-real-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'ismeretlen'
  );
}

async function deviceOf(ctx) {
  const raw = ctx.cookieJar[cookieName(ctx.req, 'tg_d')];
  if (!raw) return { hash: null, trustedFor: null };
  const hash = sha(raw);
  return { hash, trustedFor: (await db.get(`dev:${hash}`))?.userId || null };
}

async function trustDevice(ctx, user, device) {
  let hash = device.hash;
  if (!hash) {
    const raw = secret();
    hash = sha(raw);
    setCookie(ctx, 'tg_d', raw, DEVICE_TTL_S);
  }
  await db.set(`dev:${hash}`, { userId: user.id, created: Date.now() }, { ex: DEVICE_TTL_S });
  await db.hset(`udev:${user.id}`, { [hash]: Date.now() });
  return hash;
}

async function startSession(ctx, user, deviceHash, mfa) {
  const token = secret();
  const hash = sha(token);
  await db.set(`s2:${hash}`, { userId: user.id, device: deviceHash, mfa: !!mfa, created: Date.now() }, { ex: SESSION_TTL_S });
  await db.hset(`usess:${user.id}`, { [hash]: Date.now() });
  setCookie(ctx, 'tg_s', token, SESSION_TTL_S);
}

// setup: a 2FA bekapcsolásához szükséges végpontok 2FA nélkül is elérhetők
async function auth(ctx, { setup = false } = {}) {
  const token = ctx.cookieJar[cookieName(ctx.req, 'tg_s')];
  if (!token) fail(401, 'Lépj be.');
  const hash = sha(token);
  const session = await db.get(`s2:${hash}`);
  const user = session && (await getUsers()).find((u) => u.id === session.userId);
  if (!user) fail(401, 'Lejárt a munkamenet, lépj be újra.');
  if (user.totp && !session.mfa) fail(401, 'Lépj be újra a kétlépcsős kóddal.');
  if (!user.totp && !setup) fail(403, 'Előbb kapcsold be a kétlépcsős azonosítást.', 'mfa_setup');
  ctx.sessionHash = hash;
  ctx.session = session;
  return user;
}

async function revokeAll(userId) {
  const sessions = Object.keys((await db.hgetall(`usess:${userId}`)) || {});
  const devices = Object.keys((await db.hgetall(`udev:${userId}`)) || {});
  const keys = [...sessions.map((h) => `s2:${h}`), ...devices.map((h) => `dev:${h}`), `usess:${userId}`, `udev:${userId}`];
  await db.del(...keys);
}

// ---------------------------------------------------------------------------
// Kérés-korlát (fix időablak)
// ---------------------------------------------------------------------------
async function limit(name, max, windowS, message = 'Túl sok kérés – lassíts egy kicsit.') {
  const key = `rl:${name}:${Math.floor(Date.now() / 1000 / windowS)}`;
  const n = await db.incr(key);
  if (n === 1) await db.expire(key, windowS + 5);
  if (n > max) fail(429, message);
}

// ---------------------------------------------------------------------------
// Belépési zárolás
// ---------------------------------------------------------------------------
function lockMs(count, trusted) {
  // saját eszköz: 5 hiba után 5 perc, duplázva, max 1 óra
  if (trusted) return count < 5 ? 0 : Math.min(5 * 60e3 * 2 ** (count - 5), 60 * 60e3);
  // idegen eszköz: 3 hiba után 15 perc, duplázva, max 24 óra
  return count < 3 ? 0 : Math.min(15 * 60e3 * 2 ** (count - 3), 24 * 60 * 60e3);
}

function waitText(ms) {
  const min = Math.ceil(ms / 60e3);
  return min >= 90 ? `${Math.ceil(min / 60)} óra` : `${min} perc`;
}

async function recordFailedLogin(user, ctx, trusted) {
  const key = `alert:${user.id}`;
  const alert = (await db.get(key)) || { count: 0 };
  await db.set(
    key,
    { count: alert.count + 1, last: Date.now(), ip: clientIp(ctx.req), unknownDevice: !!alert.unknownDevice || !trusted },
    { ex: 60 * 24 * 3600 }
  );
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

// ---------------------------------------------------------------------------
// Útvonalak
// ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), fn });

route('GET', 'config', async (ctx) => {
  await limit(`cfg:${clientIp(ctx.req)}`, 60, 60);
  return {
    allowRegistration: ALLOW_REGISTRATION,
    maxUploadMb: MAX_UPLOAD_MB,
    storage: STORAGE,
    blobMode: BLOB_TOKEN ? 'token' : 'presigned',
    db: dbKind,
  };
});

// A fióklista csak már megbízható eszközön látszik – idegen gépen a nevet is be kell írni
route('GET', 'users', async (ctx) => {
  await limit(`users:${clientIp(ctx.req)}`, 60, 60);
  const device = await deviceOf(ctx);
  if (!device.trustedFor) return [];
  return (await getUsers()).map(publicUser);
});

route('POST', 'register', async (ctx) => {
  if (!ALLOW_REGISTRATION) fail(403, 'A regisztráció le van zárva.');
  await limit(`reg:${clientIp(ctx.req)}`, 5, 3600, 'Túl sok regisztráció erről a hálózatról.');
  const { body } = ctx;
  const name = clean(body.name, 32);
  const { pin, pin2 } = body;
  if (name.length < 2) fail(400, 'A név legalább 2 karakter legyen.');
  if (!/^\d{4}$/.test(pin || '')) fail(400, 'A kód pontosan 4 számjegy.');
  if (pin !== pin2) fail(400, 'A két kód nem egyezik.');

  const users = await getUsers();
  if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) fail(400, 'Ez a név már foglalt.');
  const salt = newId(16);
  const user = {
    id: newId(),
    name,
    role: FIXED_ROLES[name.toLowerCase()] || DEFAULT_ROLE,
    color: COLORS[users.length % COLORS.length],
    salt,
    hash: hashPin(pin, salt, 2),
    v: 2,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await db.set('users', users);
  const deviceHash = await trustDevice(ctx, user, await deviceOf(ctx));
  await startSession(ctx, user, deviceHash, false);
  return { user: publicUser(user), mfa: mfaInfo(user) };
});

route('POST', 'login', async (ctx) => {
  const ip = clientIp(ctx.req);
  await limit(`login-ip:${ip}`, 20, 3600, 'Túl sok belépési próbálkozás erről a hálózatról. Próbáld később.');
  const name = clean(ctx.body.name, 32).toLowerCase();
  const pin = String(ctx.body.pin || '');

  const users = await getUsers();
  const user = users.find((u) => u.name.toLowerCase() === name);
  if (!user || !/^\d{4}$/.test(pin)) {
    hashPin('0000', 'x'.repeat(32)); // ugyanannyi idő, ne derüljön ki, létezik-e a név
    fail(401, 'Hibás név vagy kód.');
  }

  const device = await deviceOf(ctx);
  const trusted = device.trustedFor === user.id;
  const lockKey = trusted ? `lockd:${device.hash}` : `lock:${user.id}`;
  const lock = (await db.get(lockKey)) || { count: 0, until: 0 };
  if (lock.until > Date.now()) {
    fail(429, `Túl sok hibás próbálkozás. Próbáld újra ${waitText(lock.until - Date.now())} múlva.`);
  }

  if (!checkPin(user, pin)) {
    lock.count += 1;
    lock.until = Date.now() + lockMs(lock.count, trusted);
    await db.set(lockKey, lock, { ex: 30 * 24 * 3600 });
    await recordFailedLogin(user, ctx, trusted);
    const wait = lock.until - Date.now();
    fail(401, wait > 0 ? `Hibás kód. Zárolva ${waitText(wait)}ra.` : 'Hibás név vagy kód.');
  }

  // sikeres belépés
  await db.del(lockKey);
  if (!user.v || user.v < 2) {
    user.salt = newId(16);
    user.hash = hashPin(pin, user.salt, 2);
    user.v = 2;
    await db.set('users', users);
  }
  // 2FA-val: még nincs munkamenet, csak egy 5 percig érvényes jegy a második lépéshez
  if (user.totp) {
    const ticket = secret();
    await db.set(`mfat:${sha(ticket)}`, { userId: user.id, tries: 0 }, { ex: 300 });
    return { mfa: 'required', ticket };
  }
  const deviceHash = await trustDevice(ctx, user, device);
  await startSession(ctx, user, deviceHash, false);
  return { user: publicUser(user), mfa: mfaInfo(user), alert: await db.get(`alert:${user.id}`) };
});

// Második lépés: hitelesítő app kódja vagy egy helyreállító kód
route('POST', 'login/2fa', async (ctx) => {
  await limit(`login2-ip:${clientIp(ctx.req)}`, 30, 3600, 'Túl sok próbálkozás erről a hálózatról. Próbáld később.');
  const ticketKey = `mfat:${sha(String(ctx.body.ticket || ''))}`;
  const ticket = await db.get(ticketKey);
  if (!ticket) fail(401, 'A belépés lejárt, kezdd újra a kóddal.', 'mfa_expired');

  const users = await getUsers();
  const user = users.find((u) => u.id === ticket.userId);
  if (!user?.totp) fail(401, 'A belépés lejárt, kezdd újra.', 'mfa_expired');
  const device = await deviceOf(ctx);
  const trusted = device.trustedFor === user.id;
  const lockKey = trusted ? `lock2d:${device.hash}` : `lock2:${user.id}`;
  const lock = (await db.get(lockKey)) || { count: 0, until: 0 };
  if (lock.until > Date.now()) {
    fail(429, `Túl sok hibás kód. Próbáld újra ${waitText(lock.until - Date.now())} múlva.`);
  }

  const code = String(ctx.body.code || '').trim().toLowerCase().replace(/\s+/g, '');
  let ok = false;
  let usedRecovery = false;
  if (/^\d{6}$/.test(code)) {
    const step = checkTotp(openSecret(user.totp), code, user.totpStep || 0);
    if (step) {
      user.totpStep = step;
      ok = true;
    }
  } else if (/^[a-z2-7]{4}-?[a-z2-7]{4}$/.test(code)) {
    const i = (user.recovery || []).indexOf(recoveryHash(code));
    if (i >= 0) {
      user.recovery.splice(i, 1);
      ok = usedRecovery = true;
    }
  }

  if (!ok) {
    lock.count += 1;
    lock.until = Date.now() + lockMs(lock.count, trusted);
    await db.set(lockKey, lock, { ex: 30 * 24 * 3600 });
    await recordFailedLogin(user, ctx, trusted);
    ticket.tries += 1;
    if (ticket.tries >= 5) await db.del(ticketKey);
    else await db.set(ticketKey, ticket, { ex: 300 });
    const wait = lock.until - Date.now();
    if (ticket.tries >= 5) fail(401, 'Túl sok hibás kód. Kezdd újra a belépést.', 'mfa_expired');
    fail(401, wait > 0 ? `Hibás kód. Zárolva ${waitText(wait)}ra.` : 'Hibás kód.');
  }

  await db.set('users', users);
  await db.del(ticketKey, lockKey);
  const deviceHash = await trustDevice(ctx, user, device);
  await startSession(ctx, user, deviceHash, true);
  return { user: publicUser(user), mfa: mfaInfo(user), usedRecovery, alert: await db.get(`alert:${user.id}`) };
});

// 2FA beállítása: új titkos kulcs + QR-kód (bekapcsolás csak helyes kód után)
route('POST', '2fa/setup', async (ctx) => {
  const user = await auth(ctx, { setup: true });
  await limit(`2fa-setup:${user.id}`, 10, 600);
  const secretB32 = base32Encode(crypto.randomBytes(20));
  await db.set(`totp-pending:${user.id}`, sealSecret(secretB32), { ex: 15 * 60 });
  const uri =
    `otpauth://totp/${encodeURIComponent(`Tárgyaló:${user.name}`)}` +
    `?secret=${secretB32}&issuer=${encodeURIComponent('Tárgyaló')}&algorithm=SHA1&digits=6&period=30`;
  const svg = await require('qrcode').toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return {
    qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    secret: secretB32.match(/.{1,4}/g).join(' '),
    uri,
  };
});

route('POST', '2fa/enable', async (ctx) => {
  const user = await auth(ctx, { setup: true });
  await limit(`2fa-enable:${user.id}`, 10, 600, 'Túl sok próbálkozás – kérj új QR-kódot pár perc múlva.');
  const pending = await db.get(`totp-pending:${user.id}`);
  if (!pending) fail(400, 'Lejárt a beállítás, kezdd újra.', 'mfa_setup_expired');
  const step = checkTotp(openSecret(pending), String(ctx.body.code || '').trim());
  if (!step) fail(400, 'Hibás kód. Nézd meg újra az appban (30 mp-enként változik).');

  const users = await getUsers();
  const u = users.find((x) => x.id === user.id);
  const codes = newRecoveryCodes();
  u.totp = pending;
  u.totpStep = step;
  u.recovery = codes.map(recoveryHash);
  await db.set('users', users);
  await db.del(`totp-pending:${user.id}`);

  // minden más (2FA nélküli vagy régi kulcsos) munkamenet érvénytelen, ez marad
  const others = Object.keys((await db.hgetall(`usess:${user.id}`)) || {}).filter((h) => h !== ctx.sessionHash);
  if (others.length) {
    await db.del(...others.map((h) => `s2:${h}`));
    await db.hdel(`usess:${user.id}`, ...others);
  }
  await db.set(`s2:${ctx.sessionHash}`, { ...ctx.session, mfa: true }, { ex: SESSION_TTL_S });
  return { recoveryCodes: codes, mfa: mfaInfo(u) };
});

route('GET', 'me', async (ctx) => {
  const user = await auth(ctx, { setup: true });
  return { user: publicUser(user), mfa: mfaInfo(user), alert: await db.get(`alert:${user.id}`) };
});

route('POST', 'alerts/ack', async (ctx) => {
  const user = await auth(ctx);
  await db.del(`alert:${user.id}`);
  return { ok: true };
});

route('POST', 'logout', async (ctx) => {
  const user = await auth(ctx, { setup: true });
  await db.del(`s2:${ctx.sessionHash}`);
  await db.hdel(`usess:${user.id}`, ctx.sessionHash);
  setCookie(ctx, 'tg_s', '', 0);
  return { ok: true };
});

// Minden eszköz kiléptetése és a megbízható eszközök törlése (pl. elveszett telefon)
route('POST', 'logout-all', async (ctx) => {
  const user = await auth(ctx, { setup: true });
  await limit(`logoutall:${user.id}`, 10, 3600);
  await revokeAll(user.id);
  setCookie(ctx, 'tg_s', '', 0);
  setCookie(ctx, 'tg_d', '', 0);
  return { ok: true };
});

// Saját fiók törlése a meetingjeivel és azok üzeneteivel együtt
route('DELETE', 'me', async (ctx) => {
  const user = await auth(ctx);
  const [users, meetings, presence] = await Promise.all([getUsers(), getMeetings(), readPresence()]);
  const own = meetings.filter((m) => m.createdBy === user.id);
  await db.set('users', users.filter((u) => u.id !== user.id));
  await db.set('meetings', meetings.filter((m) => m.createdBy !== user.id));
  if (own.length) await db.del(...own.map((m) => `msgs:${m.id}`));
  const mine = Object.keys(presence).filter((id) => presence[id].userId === user.id);
  if (mine.length) await db.hdel('presence', ...mine);
  await revokeAll(user.id);
  await db.del(`alert:${user.id}`, `lock:${user.id}`, `lock2:${user.id}`, `totp-pending:${user.id}`);
  setCookie(ctx, 'tg_s', '', 0);
  return { ok: true };
});

// Szívverés: jelenlét frissítése + minden, ami a főoldalhoz és a híváshoz kell
route('POST', 'presence', async (ctx) => {
  const user = await auth(ctx);
  await limit(`presence:${user.id}`, 60, 60);
  const { body } = ctx;
  const clientId = clean(body.clientId, 40);
  if (!/^[a-z0-9-]{8,40}$/i.test(clientId)) fail(400, 'Hibás kliens azonosító.');

  if (body.gone) {
    const p = (await db.hgetall('presence'))?.[clientId];
    if (p?.userId === user.id) await db.hdel('presence', clientId);
    return { ok: true };
  }

  const roomId = /^[a-f0-9]{10}$/.test(body.roomId || '') ? body.roomId : null;
  const peerId = roomId && /^tg-[a-f0-9]{10}-[a-z0-9]{6,12}$/.test(body.peerId || '') ? body.peerId : null;
  const s = body.state || {};
  await db.hset('presence', {
    [clientId]: {
      userId: user.id,
      roomId,
      peerId,
      since: Number(body.since) || Date.now(),
      state: { mic: !!s.mic, cam: !!s.cam, screen: !!s.screen },
      t: Date.now(),
    },
  });

  const [presence, [rawUsers, meetings, alert, customRoles], msgCount] = await Promise.all([
    readPresence(),
    db.mget('users', 'meetings', `alert:${user.id}`, 'roles'),
    roomId ? db.llen(`msgs:${roomId}`) : 0,
  ]);
  const users = normalizeRoles(rawUsers || []);
  const usersById = byId(users);
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
    alert,
    roles: [...BUILTIN_ROLES, ...(customRoles || [])],
    lockedUsers: users.filter(isLocked).map((u) => u.id),
  };
});

// --- Rangok ----------------------------------------------------------------
// CEO: bárkinek adhat / elvehet rangot, rangot hozhat létre és törölhet.
// CTO: Alkalmazottnak Programozó rangot adhat. Más senki nem módosíthat.
route('POST', 'users/([a-f0-9]{12})/role', async (ctx, targetId) => {
  const actor = await auth(ctx);
  await limit(`roles:${actor.id}`, 60, 3600);
  const role = clean(ctx.body.role, 30);
  const users = await getUsers();
  const target = users.find((u) => u.id === targetId);
  if (!target) fail(404, 'Nincs ilyen felhasználó.');
  if (target.id === actor.id) fail(403, 'A saját rangodat nem módosíthatod.');
  if (isLocked(target)) fail(403, `${target.name} rangja (${target.role}) nem módosítható.`);
  if (LOCKED_ROLES.includes(role)) fail(403, 'CEO és CTO rangot nem lehet kiosztani.');
  if (!(await getRoles()).includes(role)) fail(400, 'Nincs ilyen rang.');

  const canCeo = actor.role === 'CEO';
  const canCto = actor.role === 'CTO' && role === 'Programozó' && target.role === DEFAULT_ROLE;
  if (!canCeo && !canCto) {
    fail(403, actor.role === 'CTO' ? 'CTO-ként csak Alkalmazottnak adhatsz Programozó rangot.' : 'Nincs jogod rangot módosítani.');
  }
  target.role = role;
  await db.set('users', users);
  return { user: publicUser(target) };
});

route('POST', 'roles', async (ctx) => {
  const actor = await auth(ctx);
  if (actor.role !== 'CEO') fail(403, 'Új rangot csak a CEO hozhat létre.');
  await limit(`roles:${actor.id}`, 60, 3600);
  const name = clean(ctx.body.name, 30);
  if (name.length < 2) fail(400, 'A rang neve legalább 2 karakter.');
  const custom = (await db.get('roles')) || [];
  if ([...BUILTIN_ROLES, ...custom].some((r) => r.toLowerCase() === name.toLowerCase())) fail(400, 'Ilyen rang már van.');
  if (custom.length >= 20) fail(400, 'Legfeljebb 20 saját rang lehet.');
  custom.push(name);
  await db.set('roles', custom);
  return { roles: [...BUILTIN_ROLES, ...custom] };
});

route('DELETE', 'roles/(.{1,120})', async (ctx, encoded) => {
  const actor = await auth(ctx);
  if (actor.role !== 'CEO') fail(403, 'Rangot csak a CEO törölhet.');
  await limit(`roles:${actor.id}`, 60, 3600);
  let name;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    fail(400, 'Hibás rang.');
  }
  if (BUILTIN_ROLES.includes(name)) fail(400, 'Az alap rangok nem törölhetők.');
  const custom = (await db.get('roles')) || [];
  if (!custom.includes(name)) fail(404, 'Nincs ilyen rang.');
  await db.set('roles', custom.filter((r) => r !== name));
  // akinek ez volt a rangja, visszakerül Alkalmazottnak
  const users = await getUsers();
  let changed = false;
  for (const u of users) {
    if (u.role === name) {
      u.role = DEFAULT_ROLE;
      changed = true;
    }
  }
  if (changed) await db.set('users', users);
  return { ok: true };
});

// --- Meetingek -------------------------------------------------------------
route('GET', `meetings/${MEETING_ID}`, async (ctx, id) => {
  await auth(ctx);
  const [meetings, users, presence] = await Promise.all([getMeetings(), getUsers(), readPresence()]);
  const m = meetings.find((x) => x.id === id);
  if (!m) fail(404, 'Nincs ilyen meeting.');
  const usersById = byId(users);
  return meetingView(m, usersById, liveRooms(presence, usersById));
});

route('POST', 'meetings', async (ctx) => {
  const user = await auth(ctx);
  await limit(`meeting-new:${user.id}`, 15, 3600, 'Túl sok új meeting egy órán belül.');
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
  if (meetings.length >= 500) fail(400, 'Túl sok meeting – törölj néhány régit.');
  meetings.push(meeting);
  await db.set('meetings', meetings);
  return { ...meeting, creator: publicUser(user), live: [] };
});

route('DELETE', `meetings/${MEETING_ID}`, async (ctx, id) => {
  const user = await auth(ctx);
  await limit(`meeting-del:${user.id}`, 30, 3600);
  const meetings = await getMeetings();
  const m = meetings.find((x) => x.id === id);
  if (!m) fail(404, 'Nincs ilyen meeting.');
  if (m.createdBy !== user.id) fail(403, 'Csak a szervező törölheti.');
  await db.set('meetings', meetings.filter((x) => x !== m));
  await db.del(`msgs:${id}`);
  return { ok: true };
});

// --- Chat ------------------------------------------------------------------
route('GET', `rooms/${MEETING_ID}/messages`, async (ctx, id) => {
  const user = await auth(ctx);
  await limit(`msgs-get:${user.id}`, 60, 60);
  const since = Math.max(Number(ctx.query.since) || 0, 0);
  return db.lrange(`msgs:${id}`, since, -1);
});

route('POST', `rooms/${MEETING_ID}/messages`, async (ctx, id) => {
  const user = await auth(ctx);
  await limit(`msgs-post:${user.id}`, 30, 60, 'Túl sok üzenet – lassíts egy kicsit.');
  const { body } = ctx;
  if (!(await getMeetings()).some((m) => m.id === id)) fail(404, 'Nincs ilyen meeting.');

  const msg = { id: newId(), user: publicUser(user), ts: new Date().toISOString() };
  if (body.type === 'file') {
    const f = body.file || {};
    const file = {
      id: newId(12),
      roomId: id,
      userId: user.id,
      name: clean(f.name, 200) || 'fájl',
      size: Math.max(Number(f.size) || 0, 0),
      mime: /^[\w.+-]+\/[\w.+-]+$/.test(f.mime || '') ? f.mime : 'application/octet-stream',
    };
    if (STORAGE === 'blob') {
      // csak ebbe a meetingbe feltöltött fájlra hivatkozhat
      if (!new RegExp(`^${id}/[\\w.-]{1,200}$`).test(f.pathname || '')) fail(400, 'Érvénytelen fájl.');
      file.pathname = f.pathname;
    } else {
      if (!/^[a-f0-9]{32}$/.test(f.localId || '')) fail(400, 'Érvénytelen fájl.');
      file.localId = f.localId;
    }
    await db.set(`file:${file.id}`, file);
    msg.type = 'file';
    msg.file = { id: file.id, name: file.name, size: file.size, mime: file.mime };
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

// --- Fájlok ----------------------------------------------------------------
// Feltöltési engedély: a böngésző közvetlenül a privát Blob tárolóba tölt fel.
async function checkUploadPath(pathname) {
  const m = /^([a-f0-9]{10})\/[\w.-]{1,200}$/.exec(pathname || '');
  if (!m || !(await getMeetings()).some((x) => x.id === m[1])) fail(400, 'Érvénytelen feltöltési útvonal.');
}

route('POST', 'upload', async (ctx) => {
  if (STORAGE !== 'blob') fail(503, 'A fájltároló (Vercel Blob) nincs bekötve.');
  const user = await auth(ctx);
  await limit(`upload:${user.id}`, 30, 600, 'Túl sok feltöltés – várj pár percet.');
  const maximumSizeInBytes = MAX_UPLOAD_MB * 1024 * 1024;

  if (ctx.body?.type === 'blob.generate-presigned-url') {
    const { handleUploadPresigned } = require('@vercel/blob/client');
    const { issueSignedToken } = require('@vercel/blob');
    return handleUploadPresigned({
      body: ctx.body,
      request: ctx.req,
      getSignedToken: async (pathname) => {
        await checkUploadPath(pathname);
        const token = await issueSignedToken({
          pathname,
          operations: ['put'],
          maximumSizeInBytes,
          validUntil: Date.now() + 30 * 60 * 1000,
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
    onBeforeGenerateToken: async (pathname) => {
      await checkUploadPath(pathname);
      return { maximumSizeInBytes, addRandomSuffix: true, tokenPayload: JSON.stringify({ userId: user.id }) };
    },
  });
});

// Letöltés: csak belépve, és csak egy pár percig érvényes aláírt linkre irányít
route('GET', 'files/([a-f0-9]{24})', async (ctx, id) => {
  const user = await auth(ctx);
  await limit(`files:${user.id}`, 300, 600);
  const file = await db.get(`file:${id}`);
  if (!file) fail(404, 'A fájl nem található.');

  if (file.pathname) {
    const { issueSignedToken, presignUrl } = require('@vercel/blob');
    const validUntil = Date.now() + FILE_LINK_TTL_MS;
    const token = await issueSignedToken({ pathname: file.pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname: file.pathname, access: 'private', validUntil });
    ctx.res.statusCode = 302;
    ctx.res.setHeader('Location', presignedUrl);
    ctx.res.setHeader('Cache-Control', 'private, max-age=240');
    return ctx.res.end();
  }

  const filePath = path.join(UPLOAD_DIR, file.localId);
  const disposition = ctx.query.download ? 'attachment' : 'inline';
  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Type', file.mime);
  ctx.res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  ctx.res.setHeader('Cache-Control', 'private, max-age=3600');
  await new Promise((resolve) => fs.createReadStream(filePath).on('error', resolve).on('end', resolve).pipe(ctx.res));
});

// Helyi fejlesztéshez: a fájl a data/uploads mappába kerül
route('POST', 'local-upload', async (ctx) => {
  if (STORAGE !== 'local') fail(404, 'Nem elérhető.');
  const user = await auth(ctx);
  await limit(`upload:${user.id}`, 30, 600, 'Túl sok feltöltés – várj pár percet.');
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
  return { localId: id, size };
});

// ---------------------------------------------------------------------------
// Belépési pont
// ---------------------------------------------------------------------------
async function readBody(req) {
  let parsed;
  try {
    parsed = req.body; // Vercelen ez már feldolgozott JSON (hibás JSON-nál kivételt dob)
  } catch {
    fail(400, 'Hibás kérés.');
  }
  if (parsed && typeof parsed === 'object' && !Buffer.isBuffer(parsed)) return parsed;
  let raw;
  if (typeof parsed === 'string') raw = parsed;
  else if (Buffer.isBuffer(parsed)) raw = parsed.toString('utf8');
  else {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) fail(413, 'Túl nagy kérés.');
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (raw.length > MAX_BODY_BYTES) fail(413, 'Túl nagy kérés.');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    fail(400, 'Hibás kérés.');
  }
}

// Más oldalról indított kérést (CSRF) nem fogadunk el
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    fail(403, 'Tiltott kérés.');
  }
  if (originHost !== host) fail(403, 'Tiltott kérés.');
}

function send(res, status, data, cookies) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const apiPath = (query.__path ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  const method = req.method.toUpperCase();
  const ctx = { req, res, query, body: {}, cookies: [], cookieJar: parseCookies(req) };

  try {
    if (dbKind === 'missing' && apiPath !== 'config') {
      fail(503, 'Nincs adatbázis bekötve. Vercelen: Storage → Upstash for Redis → Connect, majd Redeploy.');
    }
    for (const r of routes) {
      const m = r.method === method && apiPath.match(r.pattern);
      if (!m) continue;
      const streaming = apiPath === 'local-upload';
      if (method !== 'GET') {
        checkOrigin(req);
        const type = String(req.headers['content-type'] || '');
        if (!streaming && !type.startsWith('application/json')) fail(415, 'Csak JSON kérés fogadható.');
        if (!streaming) ctx.body = await readBody(req);
      }
      const result = await r.fn(ctx, ...m.slice(1));
      if (res.writableEnded || res.headersSent) return;
      return send(res, 200, result, ctx.cookies);
    }
    fail(404, 'Ismeretlen végpont.');
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.end();
    const message = err instanceof HttpError ? err.message : 'Szerverhiba.';
    send(res, err.status || 500, { error: message, code: err.code }, ctx.cookies);
  }
};
