'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// 규칙·물리는 브라우저와 같은 코드를 쓴다
const L = require('./public/logic.js');

// ---------- Config ----------
const PORT = process.env.PORT || 3012;
const TURN_MS = Number(process.env.TURN_MS) || 30000;   // 한 번 둘 때마다 주어지는 제한 시간. 넘기면 자동으로 한 장 뽑고, 연달아 넘기면 빠진다. 시험에서는 환경변수로 줄인다
const MAX_SEATS = 4;
const MAX_IDLE = 2;             // 시간을 연달아 이만큼 넘기면 그 사람은 판에서 빠진다
const GRACE_MS = 30000;         // 대국 중 연결이 끊겨도 이 시간 안에 돌아오면 이어서 둔다
// 프록시가 WebSocket ping 을 대신 받아버리는 환경이 있어, 클라이언트가 보내는 pulse 로 살아있는지 본다
const HEARTBEAT_MS = 25000;
const SILENCE_TIMEOUT_MS = 90000;
// 헷갈리는 글자(0/O, 1/I)는 빼서 코드를 불러주기 쉽게 한다
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Static file server ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
// 주소 해석·파일 경로 검사: 잘못된 % 표기나 널 문자는 null, 점으로 시작하는 파일과 폴더 밖 경로는 내보내지 않는다
function safeDecode(s) {
  try {
    const d = decodeURIComponent(s);
    return d.includes('\0') ? null : d;
  } catch { return null; }
}
function isServable(filePath, baseDir) {
  const inside = filePath === baseDir || filePath.startsWith(baseDir + path.sep);
  return inside && !filePath.slice(baseDir.length).split(path.sep).some((seg) => seg.startsWith('.'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let reqPath = safeDecode(req.url.split('?')[0]);
  if (reqPath === null) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad request'); return; }
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!isServable(filePath, PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// 메시지 크기 제한: 기본값(100MB)이면 큰 메시지 하나로 서버 메모리를 먹일 수 있다. 이 게임의 메시지는 모두 이보다 훨씬 작다
const wss = new WebSocketServer({ server, maxPayload: 1024 });

// ---------- 방 코드 무차별 대입 방지 ----------
// 없는 방 코드를 짧은 시간에 여러 번 대면 잠깐 막는다 (손님 주소 기준: 로비 프록시가 붙여 주는 x-forwarded-for 의 첫 값)
const JOIN_FAIL_MAX = 8, JOIN_WINDOW_MS = 60000, JOIN_BLOCK_MS = 60000;
const joinFails = new Map();   // 주소 -> { n, since, until }
const clientIp = (req) => String((req && req.headers['x-forwarded-for']) || (req && req.socket.remoteAddress) || '').split(',')[0].trim();
function joinBlocked(ip) {
  const f = joinFails.get(ip);
  return !!f && f.until > Date.now();
}
function noteJoinFail(ip) {
  const now = Date.now();
  let f = joinFails.get(ip);
  if (!f || now - f.since > JOIN_WINDOW_MS) f = { n: 0, since: now, until: 0 };
  f.n++;
  if (f.n >= JOIN_FAIL_MAX) { f.until = now + JOIN_BLOCK_MS; f.n = 0; f.since = now; }
  joinFails.set(ip, f);
  if (joinFails.size > 2000) for (const [k, v] of joinFails) if (v.until < now && now - v.since > JOIN_WINDOW_MS) joinFails.delete(k);
}

// ---------- State ----------
const rooms = new Map();     // code -> room
const clients = new Map();   // ws -> client
let queue = null;            // 빠른 대전을 기다리는 client 하나
let nextId = 1;

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ t: type, ...payload }));
}

function makeCode() {
  for (let k = 0; k < 50; k++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

const makeToken = () => crypto.randomBytes(18).toString('base64url');   // 자리를 되찾는 열쇠: 예측할 수 없는 난수로

function sanitizeName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);
  return name || `손님${Math.floor(100 + Math.random() * 900)}`;
}


// ---------- Rooms ----------
function createRoom(isPrivate) {
  const room = {
    code: makeCode(),
    isPrivate,
    seats: [],               // { client, name, index, token, online, graceTimer, idle, gone } — index 는 판에서의 자리 번호
    game: null,
    state: 'waiting',        // waiting | playing | over
    winner: -1,              // 이긴 자리 번호
    reason: '',              // empty | last | bust | (게임 규칙이 정한 이유)
    deadline: 0,
    turnTimer: null,
    event: null,             // 마지막 행동 { seq, who, kind, ... } — 화면이 이걸 보고 알려 준다
    eventSeq: 0,
    rematch: new Set(),      // 한 판 더를 누른 자리 번호
    first: 0,
    games: 0,
  };
  rooms.set(room.code, room);
  return room;
}

const seatOf = (room, client) => room.seats.find((s) => s.client === client);

// 손님마다 다른 알림: 내 손패만 보내고 남의 손은 장수만 보낸다
function snapshot(room, seat) {
  const g = room.game;
  return {
    code: room.code,
    isPrivate: room.isPrivate,
    token: seat.token,
    you: seat.index,
    players: room.seats.map((s, i) => ({ name: s.name, online: s.online, gone: s.gone, count: g ? g.hands[i].length : 0, alive: g ? g.alive[i] : true })),
    state: room.state,
    myHand: g ? g.hands[seat.index].slice() : [],
    top: g ? g.top : -1,
    suit: g ? g.suit : -1,
    stack: g ? g.stack : 0,
    turn: g ? g.turn : 0,
    dir: g ? g.dir : 1,
    drawLeft: g ? g.draw.length : 0,
    event: room.event,
    games: room.games,
    winner: room.winner,
    reason: room.reason,
    remain: room.state === 'playing' ? Math.max(0, room.deadline - Date.now()) : 0,
    rematch: [...room.rematch],
  };
}

function pushRoom(room) {
  for (const s of room.seats) if (s.online) send(s.client.ws, 'room', snapshot(room, s));
}

function note(room, ev) {
  room.event = { seq: ++room.eventSeq, ...ev };
}

function sitDown(room, client) {
  const seat = { client, name: client.name, index: room.seats.length, token: makeToken(), online: true, graceTimer: null, idle: 0, gone: false };
  room.seats.push(seat);
  client.roomCode = room.code;
  if (!room.isPrivate && room.seats.length === 2) startGame(room);          // 빠른 대전은 둘이 모이면 바로
  else pushRoom(room);
}

function startGame(room) {
  room.seats = room.seats.filter((s) => !s.gone);
  room.seats.forEach((s, i) => { s.index = i; s.idle = 0; });
  const n = room.seats.length;
  room.first = room.games === 0 ? crypto.randomInt(n) : (room.first + 1) % n;
  room.game = L.newGame({ players: n, seed: crypto.randomInt(2 ** 31), first: room.first });
  room.state = 'playing';
  room.winner = -1;
  room.reason = '';
  room.event = null;
  room.rematch.clear();
  room.games++;
  armTurnTimer(room);
  pushRoom(room);
}

function armTurnTimer(room) {
  clearTimeout(room.turnTimer);
  room.deadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => onTimeout(room), TURN_MS);
}

// 시간을 넘기면 대신 한 장 뽑아 차례를 넘기고, 연달아 넘기면 판에서 뺀다
function onTimeout(room) {
  if (room.state !== 'playing') return;
  const g = room.game, who = g.turn, seat = room.seats[who];
  const d = L.drawTurn(g, who);
  seat.idle++;
  note(room, { who, kind: 'timeout', n: d ? d.n : 0, bust: !g.alive[who] });
  if (g.winner < 0 && seat.idle >= MAX_IDLE && g.alive[who]) { L.eliminate(g, who, 'timeout'); note(room, { who, kind: 'out', reason: 'timeout' }); }
  settle(room);
}

// 행동 뒤: 승부가 났으면 끝내고, 아니면 다음 사람 시간을 잰다
function settle(room) {
  const g = room.game;
  if (g.winner >= 0) return endGame(room, g.winner, g.reason);
  armTurnTimer(room);
  pushRoom(room);
}

function endGame(room, winner, reason) {
  if (room.state !== 'playing') return;
  clearTimeout(room.turnTimer);
  room.state = 'over';
  room.winner = winner;
  room.reason = reason;
  pushRoom(room);
}

function closeRoom(room) {
  clearTimeout(room.turnTimer);
  for (const s of room.seats) {
    clearTimeout(s.graceTimer);
    if (s.client) s.client.roomCode = null;
  }
  rooms.delete(room.code);
}

// 대국 중에 자리를 비운다 (기권·나가기·끊긴 뒤 돌아오지 않음): 그 사람만 판에서 빠지고 나머지는 계속한다
function dropOut(room, seat, reason) {
  const g = room.game;
  if (room.state !== 'playing' || !g || !g.alive[seat.index]) return;
  L.eliminate(g, seat.index, reason);
  note(room, { who: seat.index, kind: 'out', reason });
  settle(room);
}

// 자리에서 완전히 일어난다 (나가기, 또는 끊긴 뒤 돌아오지 않음)
function vacate(room, seat, reason = 'left') {
  clearTimeout(seat.graceTimer);
  const wasHost = room.seats[0] === seat;
  if (room.state === 'playing') { dropOut(room, seat, reason); seat.gone = true; seat.online = false; seat.client = null; }
  else if (room.state === 'waiting') {
    if (wasHost) {                                      // 방장이 나가면 방이 닫힌다
      for (const s of room.seats) if (s !== seat && s.online) send(s.client.ws, 'error', { msg: '방장이 나가서 방이 닫혔어요.' });
      closeRoom(room); return;
    }
    room.seats = room.seats.filter((s) => s !== seat);
    room.seats.forEach((s, i) => { s.index = i; });
    if (seat.client) seat.client.roomCode = null;
    pushRoom(room);
    return;
  } else { seat.gone = true; seat.online = false; seat.client = null; }   // over
  if (seat.client) seat.client.roomCode = null;
  room.rematch.delete(seat.index);
  if (room.seats.every((s) => s.gone)) { closeRoom(room); return; }
  pushRoom(room);
}

function dropFromQueue(client) {
  if (queue === client) queue = null;
}

// ---------- Handlers ----------
const handlers = {
  hello(client, msg) {
    client.name = sanitizeName(msg.name);
  },

  quick(client) {
    if (client.roomCode) return;
    if (queue && queue !== client && queue.ws.readyState === queue.ws.OPEN) {
      const other = queue;
      queue = null;
      const room = createRoom(false);
      sitDown(room, other);
      sitDown(room, client);
    } else {
      queue = client;
      send(client.ws, 'queued');
    }
  },

  create(client) {
    if (client.roomCode) return;
    dropFromQueue(client);
    sitDown(createRoom(true), client);
  },

  join(client, msg) {
    if (client.roomCode) return;
    dropFromQueue(client);
    if (joinBlocked(client.ip)) return send(client.ws, 'error', { msg: '방 코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.' });
    const room = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!room) { noteJoinFail(client.ip); return send(client.ws, 'error', { msg: '그런 방이 없어요. 코드를 확인해 주세요.' }); }
    if (room.state !== 'waiting') return send(client.ws, 'error', { msg: '이미 시작한 방이에요.' });
    if (room.seats.length >= MAX_SEATS) return send(client.ws, 'error', { msg: '방이 가득 찼어요. (최대 4명)' });
    sitDown(room, client);
  },

  // 방장이 모인 사람들로 시작한다 (2~4명)
  start(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'waiting' || room.seats[0] !== seat || room.seats.length < 2) return;
    startGame(room);
  },

  // 새로고침·네트워크 끊김 뒤 같은 자리로 돌아온다
  resume(client, msg) {
    const room = rooms.get(String(msg.code || ''));
    const seat = room && room.seats.find((s) => s.token === msg.token && !s.gone);
    if (!seat) return send(client.ws, 'resumeFailed');
    if (seat.client && seat.client !== client && seat.client.ws.readyState === seat.client.ws.OPEN) {
      seat.client.roomCode = null;
      send(seat.client.ws, 'error', { msg: '다른 창에서 이 대국에 다시 들어왔어요.' });
    }
    clearTimeout(seat.graceTimer);
    seat.client = client;
    seat.online = true;
    client.name = seat.name;
    client.roomCode = room.code;
    pushRoom(room);
  },

  cancel(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && room.state === 'waiting') vacate(room, seat);
  },

  // 카드 내기: 내 차례에 낼 수 있는 내 카드만. 7 은 모양(0~3), 한 장이 남으면 원카드(one)를 불러야 한다. 규칙에 어긋나면 L.play 가 거절한다
  play(client, msg) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    const g = room && room.game;
    if (!seat || room.state !== 'playing' || g.turn !== seat.index || !g.alive[seat.index]) return;
    if (!Number.isInteger(msg.card)) return;
    const suit = Number.isInteger(msg.suit) ? msg.suit : undefined;
    const r = L.play(g, seat.index, msg.card, { suit, one: msg.one === true });
    if (!r) return;
    seat.idle = 0;
    note(room, { who: seat.index, kind: 'play', card: r.card, effect: r.effect, skipped: r.skipped, reversed: r.reversed, penalty: r.penalty, suit: r.suit, bust: !g.alive[seat.index] });
    settle(room);
  },

  // 한 장 뽑기 (공격을 받은 중이면 쌓인 장수만큼)
  draw(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    const g = room && room.game;
    if (!seat || room.state !== 'playing' || g.turn !== seat.index) return;
    const r = L.drawTurn(g, seat.index);
    if (!r) return;
    seat.idle = 0;
    note(room, { who: seat.index, kind: 'draw', n: r.n, wanted: r.wanted, bust: !g.alive[seat.index] });
    settle(room);
  },

  resign(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat) dropOut(room, seat, 'resign');
  },

  rematch(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'over') return;
    room.rematch.add(seat.index);
    const stay = room.seats.filter((s) => !s.gone);
    if (stay.length >= 2 && stay.every((s) => room.rematch.has(s.index))) startGame(room);
    else pushRoom(room);
  },

  leave(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat) vacate(room, seat);
  },

  pulse() {},
};

// ---------- Connections ----------
function onDisconnect(client) {
  dropFromQueue(client);
  const room = rooms.get(client.roomCode);
  const seat = room && seatOf(room, client);
  if (!seat) return;
  if (room.state !== 'playing') { vacate(room, seat); return; }
  // 대국 중이면 잠깐 기다려 준다
  seat.online = false;
  seat.client = null;
  seat.graceTimer = setTimeout(() => vacate(room, seat), GRACE_MS);
  pushRoom(room);
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, HEARTBEAT_MS);

const silenceSweep = setInterval(() => {
  const now = Date.now();
  for (const [ws, client] of clients) {
    if (now - client.lastSeen > SILENCE_TIMEOUT_MS) ws.terminate();
  }
}, 5000);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(silenceSweep); });

wss.on('connection', (ws, req) => {
  ws.on('error', () => {});   // 크기 제한 초과 같은 연결 오류는 그 손님의 연결만 끊고, 처리하지 않으면 서버 전체가 죽는다
  const client = { id: nextId++, ws, ip: clientIp(req), name: sanitizeName(''), roomCode: null, lastSeen: Date.now() };
  clients.set(ws, client);

  ws.on('message', (raw) => {
    client.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = msg && typeof msg.t === 'string' && Object.prototype.hasOwnProperty.call(handlers, msg.t) ? handlers[msg.t] : null;
    if (handler) handler(client, msg);
  });

  ws.on('close', () => {
    onDisconnect(client);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`원카드 서버 실행 중 → http://localhost:${PORT}`);
});
