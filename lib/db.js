// Adattároló: Vercelen Upstash Redis, helyben egy JSON fájlba mentett
// memóriás utánzat, ami ugyanazokat a parancsokat ismeri.

const fs = require('fs');
const path = require('path');

// A Vercel Storage bekötésekor egyedi előtag is megadható (pl. STORAGE_KV_REST_API_URL),
// ezért az előtagtól függetlenül keressük a változókat.
function findEnv(suffix) {
  const key = Object.keys(process.env).find((k) => k === suffix || k.endsWith(`_${suffix}`));
  return key ? process.env[key] : undefined;
}

const REDIS_URL = findEnv('KV_REST_API_URL') || findEnv('UPSTASH_REDIS_REST_URL');
const REDIS_TOKEN = findEnv('KV_REST_API_TOKEN') || findEnv('UPSTASH_REDIS_REST_TOKEN');

function createRedis() {
  const { Redis } = require('@upstash/redis');
  return new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

function createLocal() {
  const file = path.join(process.cwd(), 'data', 'local-db.json');
  let data = {};
  let expires = {};
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = stored.data || {};
    expires = stored.expires || {};
  } catch {}

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ data, expires }));
    }, 100);
  };
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const alive = (k) => {
    if (expires[k] && expires[k] < Date.now()) {
      delete data[k];
      delete expires[k];
    }
    return k in data;
  };

  return {
    async get(k) { return alive(k) ? clone(data[k]) : null; },
    async mget(...keys) { return keys.flat().map((k) => (alive(k) ? clone(data[k]) : null)); },
    async set(k, v, opts = {}) {
      data[k] = clone(v);
      if (opts.ex) expires[k] = Date.now() + opts.ex * 1000;
      else delete expires[k];
      save();
      return 'OK';
    },
    async del(...keys) { keys.flat().forEach((k) => { delete data[k]; delete expires[k]; }); save(); return 1; },
    async incr(k) { data[k] = (alive(k) ? Number(data[k]) : 0) + 1; save(); return data[k]; },
    async expire(k, s) { if (alive(k)) expires[k] = Date.now() + s * 1000; save(); return 1; },
    async rpush(k, ...vals) { if (!alive(k)) data[k] = []; data[k].push(...vals.map(clone)); save(); return data[k].length; },
    async llen(k) { return alive(k) ? data[k].length : 0; },
    async lrange(k, start, stop) {
      if (!alive(k)) return [];
      const list = data[k];
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      return clone(list.slice(start < 0 ? Math.max(list.length + start, 0) : start, end));
    },
    async ltrim(k, start, stop) {
      if (!alive(k)) return 'OK';
      const list = data[k];
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      data[k] = list.slice(start < 0 ? Math.max(list.length + start, 0) : start, end);
      save();
      return 'OK';
    },
    async hset(k, obj) { if (!alive(k)) data[k] = {}; Object.assign(data[k], clone(obj)); save(); return 1; },
    async hgetall(k) { return alive(k) && Object.keys(data[k]).length ? clone(data[k]) : null; },
    async hdel(k, ...fields) { if (alive(k)) fields.flat().forEach((f) => delete data[k][f]); save(); return 1; },
  };
}

const kind = REDIS_URL && REDIS_TOKEN ? 'redis' : process.env.VERCEL ? 'missing' : 'local';
const db = kind === 'redis' ? createRedis() : createLocal();

module.exports = { db, kind, findEnv };
