// Tárgyaló – privát videókonferencia szerver
// Express (REST + statikus fájlok) + Socket.IO (WebRTC jelzés, chat, jelenlét)

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 1024;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Egyszerű JSON tároló
// ---------------------------------------------------------------------------
function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch {
    return fallback;
  }
}

function persist(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(db[name], null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

const db = {
  users: load('users', []),
  sessions: load('sessions', {}), // token -> userId
  meetings: load('meetings', []),
  messages: load('messages', {}), // roomId -> [üzenet]
  files: load('files', []),
};

const COLORS = ['#7c5cff', '#22c1a4', '#ff7a59', '#3b9cff', '#f5b73b', '#e0529c'];
const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, color: u.color });
const findUser = (id) => db.users.find((u) => u.id === id);

// ---------------------------------------------------------------------------
// PIN kezelés
// ---------------------------------------------------------------------------
function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

function checkPin(user, pin) {
  const a = Buffer.from(hashPin(pin, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 4 számjegy kevés, ezért 5 rossz próbálkozás után 5 perc zárolás
const attempts = new Map(); // név -> { count, until }
const LOCK_AFTER = 5;
const LOCK_MS = 5 * 60 * 1000;

function createSession(user) {
  const token = newId(24);
  db.sessions[token] = user.id;
  persist('sessions');
  return token;
}

function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const id = db.sessions[token];
  return id ? findUser(id) : null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Lejárt a munkamenet, lépj be újra.' });
  req.user = user;
  req.token = token;
  next();
}

const bad = (res, error, status = 400) => res.status(status).json({ error });
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

app.get('/api/config', (req, res) => {
  res.json({ allowRegistration: ALLOW_REGISTRATION, maxUploadMb: MAX_UPLOAD_MB });
});

// A belépő képernyő listázza a fiókokat, hogy csak rá kelljen kattintani
app.get('/api/users', (req, res) => res.json(db.users.map(publicUser)));

app.post('/api/register', (req, res) => {
  if (!ALLOW_REGISTRATION) return bad(res, 'A regisztráció le van zárva.', 403);
  const name = clean(req.body.name, 32);
  const role = clean(req.body.role, 40);
  const { pin, pin2 } = req.body;

  if (name.length < 2) return bad(res, 'A név legalább 2 karakter legyen.');
  if (!role) return bad(res, 'Add meg a szereped.');
  if (!/^\d{4}$/.test(pin || '')) return bad(res, 'A kód pontosan 4 számjegy.');
  if (pin !== pin2) return bad(res, 'A két kód nem egyezik.');
  if (db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    return bad(res, 'Ez a név már foglalt.');
  }

  const salt = newId(16);
  const user = {
    id: newId(),
    name,
    role,
    color: COLORS[db.users.length % COLORS.length],
    salt,
    hash: hashPin(pin, salt),
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  persist('users');
  res.json({ token: createSession(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const name = clean(req.body.name, 32);
  const pin = String(req.body.pin || '');
  const key = name.toLowerCase();
  const lock = attempts.get(key);

  if (lock && lock.until > Date.now()) {
    const min = Math.ceil((lock.until - Date.now()) / 60000);
    return bad(res, `Túl sok próbálkozás. Próbáld újra ${min} perc múlva.`, 429);
  }

  const user = db.users.find((u) => u.name.toLowerCase() === key);
  if (!user || !checkPin(user, pin)) {
    const count = (lock && lock.until <= Date.now() ? 0 : lock?.count || 0) + 1;
    attempts.set(key, { count, until: count >= LOCK_AFTER ? Date.now() + LOCK_MS : 0 });
    const left = LOCK_AFTER - count;
    return bad(res, left > 0 ? `Hibás kód. Még ${left} próbálkozás.` : 'Hibás kód. 5 percre zárolva.', 401);
  }

  attempts.delete(key);
  res.json({ token: createSession(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.token];
  persist('sessions');
  res.json({ ok: true });
});

// --- Meetingek -------------------------------------------------------------
function meetingView(m) {
  const creator = findUser(m.createdBy);
  return {
    ...m,
    creator: creator ? publicUser(creator) : null,
    live: roomParticipants(m.id),
  };
}

app.get('/api/meetings', auth, (req, res) => {
  const list = [...db.meetings].sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  res.json(list.map(meetingView));
});

app.get('/api/meetings/:id', auth, (req, res) => {
  const m = db.meetings.find((x) => x.id === req.params.id);
  if (!m) return bad(res, 'Nincs ilyen meeting.', 404);
  res.json(meetingView(m));
});

app.post('/api/meetings', auth, (req, res) => {
  const instant = !!req.body.instant;
  const title = clean(req.body.title, 80) || (instant ? 'Azonnali meeting' : '');
  const description = clean(req.body.description, 600);
  const startsAt = instant ? new Date() : new Date(req.body.startsAt);
  const durationMin = Math.min(Math.max(Number(req.body.durationMin) || 30, 5), 600);

  if (!title) return bad(res, 'Adj nevet a meetingnek.');
  if (Number.isNaN(startsAt.getTime())) return bad(res, 'Érvénytelen időpont.');

  const meeting = {
    id: newId(5),
    title,
    description,
    startsAt: startsAt.toISOString(),
    durationMin,
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
  };
  db.meetings.push(meeting);
  persist('meetings');
  io.emit('meetings-changed');
  res.json(meetingView(meeting));
});

app.delete('/api/meetings/:id', auth, (req, res) => {
  const m = db.meetings.find((x) => x.id === req.params.id);
  if (!m) return bad(res, 'Nincs ilyen meeting.', 404);
  if (m.createdBy !== req.user.id) return bad(res, 'Csak a szervező törölheti.', 403);
  db.meetings = db.meetings.filter((x) => x !== m);
  persist('meetings');
  io.emit('meetings-changed');
  res.json({ ok: true });
});

// --- Chat előzmények és fájlok ---------------------------------------------
app.get('/api/rooms/:id/messages', auth, (req, res) => {
  res.json(db.messages[req.params.id] || []);
});

function pushMessage(roomId, msg) {
  const list = (db.messages[roomId] ||= []);
  list.push(msg);
  if (list.length > 1000) list.splice(0, list.length - 1000);
  persist('messages');
  io.to(roomId).emit('chat', msg);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, newId(16)),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

app.post('/api/rooms/:id/files', auth, (req, res) => {
  const meeting = db.meetings.find((x) => x.id === req.params.id);
  if (!meeting) return bad(res, 'Nincs ilyen meeting.', 404);

  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Maximum ${MAX_UPLOAD_MB} MB tölthető fel.` : 'Feltöltési hiba.';
      return bad(res, msg);
    }
    if (!req.file) return bad(res, 'Nincs fájl.');

    // a multer latin1-ként olvassa a fájlnevet – ékezetek miatt visszaalakítjuk
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const file = {
      id: req.file.filename,
      roomId: meeting.id,
      name: originalName,
      size: req.file.size,
      mime: req.file.mimetype,
      uploadedBy: req.user.id,
      createdAt: new Date().toISOString(),
    };
    db.files.push(file);
    persist('files');

    const msg = {
      id: newId(),
      type: 'file',
      user: publicUser(req.user),
      file: { id: file.id, name: file.name, size: file.size, mime: file.mime },
      ts: file.createdAt,
    };
    pushMessage(meeting.id, msg);
    res.json(msg);
  });
});

app.get('/api/files/:id', auth, (req, res) => {
  const file = db.files.find((f) => f.id === req.params.id);
  if (!file) return bad(res, 'A fájl nem található.', 404);
  const filePath = path.join(UPLOAD_DIR, file.id);
  if (req.query.inline === '1') {
    res.type(file.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return res.sendFile(filePath);
  }
  res.download(filePath, file.name);
});

// ---------------------------------------------------------------------------
// Socket.IO – jelenlét, szobák, WebRTC jelzés
// ---------------------------------------------------------------------------
const rooms = new Map(); // roomId -> Map(socketId -> { user, state })
const online = new Map(); // userId -> kapcsolatok száma

function roomParticipants(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const seen = new Map();
  for (const p of room.values()) seen.set(p.user.id, p.user);
  return [...seen.values()];
}

function broadcastRooms() {
  const live = {};
  for (const id of rooms.keys()) live[id] = roomParticipants(id);
  io.emit('rooms', live);
}

function broadcastPresence() {
  io.emit('presence', [...online.keys()]);
}

function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  return servers;
}

const cleanState = (s = {}) => ({ mic: !!s.mic, cam: !!s.cam, screen: !!s.screen });

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = publicUser(user);
  next();
});

io.on('connection', (socket) => {
  const me = socket.data.user;
  online.set(me.id, (online.get(me.id) || 0) + 1);
  broadcastPresence();
  broadcastRooms();

  function leaveRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.leave(roomId);
    socket.data.roomId = null;
    const room = rooms.get(roomId);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) rooms.delete(roomId);
    }
    socket.to(roomId).emit('peer-left', { id: socket.id });
    broadcastRooms();
  }

  socket.on('join-room', ({ roomId, state } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!db.meetings.some((m) => m.id === roomId)) return ack({ error: 'Nincs ilyen meeting.' });

    leaveRoom();
    const room = rooms.get(roomId) || new Map();
    rooms.set(roomId, room);
    const peers = [...room].map(([id, p]) => ({ id, user: p.user, state: p.state }));

    socket.join(roomId);
    socket.data.roomId = roomId;
    room.set(socket.id, { user: me, state: cleanState(state) });
    socket.to(roomId).emit('peer-joined', { id: socket.id, user: me, state: cleanState(state) });

    ack({ peers, iceServers: iceServers() });
    broadcastRooms();
  });

  socket.on('leave-room', leaveRoom);

  // A jelzést csak ugyanabban a szobában lévő félnek továbbítjuk
  socket.on('signal', ({ to, data } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.get(roomId)?.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('state', (state) => {
    const roomId = socket.data.roomId;
    const entry = roomId && rooms.get(roomId)?.get(socket.id);
    if (!entry) return;
    entry.state = cleanState(state);
    socket.to(roomId).emit('peer-state', { id: socket.id, state: entry.state });
  });

  socket.on('chat', (text) => {
    const roomId = socket.data.roomId;
    const body = clean(text, 4000);
    if (!roomId || !body) return;
    pushMessage(roomId, { id: newId(), type: 'text', user: me, text: body, ts: new Date().toISOString() });
  });

  socket.on('reaction', (emoji) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof emoji !== 'string' || emoji.length > 8) return;
    socket.to(roomId).emit('reaction', { id: socket.id, user: me, emoji });
  });

  socket.on('disconnect', () => {
    leaveRoom();
    const n = (online.get(me.id) || 1) - 1;
    if (n <= 0) online.delete(me.id);
    else online.set(me.id, n);
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`\n  Tárgyaló fut:  http://localhost:${PORT}\n`);
});
