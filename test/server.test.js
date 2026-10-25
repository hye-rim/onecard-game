'use strict';

// 서버 시험: 보안·안정성 회귀 + 원카드 온라인 대국 흐름 (2명 빠른 대전, 2~4명 방)
// 실행: npm test  (Node 18 이상, 별도 설치 없이 node:test)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');
const L = require('../public/logic.js');

// 운영체제가 지금 비어 있는 포트를 골라 준다 (고정 포트·범위 난수는 다른 서버와 겹쳐 가끔 실패한다)
const freePort = () => Number(require('child_process').execFileSync(process.execPath, ['-e', "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"]));
const PORT = freePort();
const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), TURN_MS: '2000' }, stdio: 'ignore' });
child.unref();
process.on('exit', () => child.kill());
const ready = (async () => {
  for (let i = 0; i < 80; i++) { try { await get('/'); return; } catch { await sleep(100); } }
  throw new Error('server did not start');
})();

const open = (name) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const c = { ws, name, msgs: [], room: null, queued: false, errors: [], closed: null };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    c.msgs.push(m);
    if (m.t === 'room') c.room = m;
    if (m.t === 'queued') c.queued = true;
    if (m.t === 'error') c.errors.push(m.msg);
  });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  ws.on('open', () => { if (name) ws.send(JSON.stringify({ t: 'hello', name })); resolve(c); });
  setTimeout(() => reject(new Error('websocket connect failed')), 3000);
});
const send = (c, t, p = {}) => c.ws.send(JSON.stringify({ t, ...p }));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };
const closeAll = (...cs) => cs.forEach((c) => c.ws.close());

// 두 손님을 빠른 대전으로 맺어 준다 (바로 시작)
async function pair() {
  const a = await open('가'), b = await open('나');
  send(a, 'quick'); await until(() => a.queued);
  send(b, 'quick');
  assert.ok(await until(() => a.room && b.room && a.room.state === 'playing' && b.room.state === 'playing'), 'quick match starts at once');
  return [a, b];
}
// 방 만들기 → n 명이 모여 방장이 시작
async function lobby(n) {
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(await open('p' + i));
  send(cs[0], 'create');
  assert.ok(await until(() => cs[0].room && cs[0].room.code));
  for (let i = 1; i < n; i++) { send(cs[i], 'join', { code: cs[0].room.code }); }
  assert.ok(await until(() => cs.every((c) => c.room && c.room.players.length === n)));
  return cs;
}
async function startRoom(n) {
  const cs = await lobby(n);
  send(cs[0], 'start');
  assert.ok(await until(() => cs.every((c) => c.room.state === 'playing')), 'host start');
  return cs;
}
// 내가 받은 알림만으로 규칙 함수가 읽는 판을 만든다 (남의 손은 장수만 아니까 빈 자리로 채운다)
const viewOf = (room) => ({
  n: room.players.length, hands: room.players.map((p, i) => (i === room.you ? room.myHand.slice() : new Array(p.count).fill(0))),
  top: room.top, suit: room.suit, stack: room.stack, turn: room.turn, dir: room.dir, alive: room.players.map((p) => p.alive), winner: room.state === 'over' ? room.winner : -1,
  draw: new Array(room.drawLeft).fill(0), discard: [room.top], rand: Math.random,
});
const onTurn = (cs) => cs.find((c) => c.room.turn === c.room.you);

// 봇이 한 번 둔다 (규칙 함수가 고른 대로 서버에 보낸다)
async function botStep(cs) {
  const m = onTurn(cs), seq = m.room.event ? m.room.event.seq : 0;
  const a = L.aiPick(viewOf(m.room), m.room.you, 'hard', Math.random);
  if (a.type === 'draw') send(m, 'draw'); else send(m, 'play', { card: a.card, suit: a.suit, one: a.one });
  await until(() => cs.every((c) => (c.room.event && c.room.event.seq > seq) || c.room.state === 'over'), 3000);
}
async function playOut(cs, max = 400) {
  let n = 0;
  while (cs[0].room.state === 'playing' && n++ < max) await botStep(cs);
  await until(() => cs.every((c) => c.room.state === 'over'), 2000);
  return n;
}

test('malformed URLs get 400 and the server stays up', async () => {
  await ready;
  assert.strictEqual(await get('/%'), 400);
  assert.strictEqual(await get('/%00'), 400);
  assert.strictEqual(await get('/'), 200);
  assert.strictEqual(await get('/logic.js'), 200);
});

test('dotfiles and paths outside the public dir are not served', async () => {
  await ready;
  assert.strictEqual(await get('/.git/config'), 403);
  assert.ok([403, 404].includes(await get('/../server.js')));
});

test('oversized websocket message closes the connection (1009)', async () => {
  await ready;
  const c = await open();
  c.ws.send('x'.repeat(2 * 1024 * 1024));
  await sleep(500);
  assert.strictEqual(c.closed, 1009);
  assert.strictEqual(await get('/'), 200);
});

test('quick match deals 7 cards each and shows only your own hand', async () => {
  await ready;
  const [a, b] = await pair();
  assert.strictEqual(a.room.code, b.room.code);
  assert.notStrictEqual(a.room.you, b.room.you);
  for (const c of [a, b]) {
    assert.strictEqual(c.room.myHand.length, 7);
    assert.deepStrictEqual(c.room.players.map((p) => p.count), [7, 7]);
    assert.ok(!('hands' in c.room) && !('draw' in c.room), 'no hidden cards in the message');
  }
  assert.ok(a.room.myHand.every((x) => !b.room.myHand.includes(x)), 'two hands never share a card');
  assert.ok([3, 4, 5, 6, 8, 9, 10].includes(L.rankOf(a.room.top)));
  assert.strictEqual(a.room.top, b.room.top);
  assert.strictEqual(a.room.drawLeft, 54 - 14 - 1);
  closeAll(a, b);
});

test('out-of-turn and garbage plays are ignored', async () => {
  await ready;
  const [a, b] = await pair();
  const m = onTurn([a, b]), other = m === a ? b : a;
  send(other, 'play', { card: other.room.myHand[0] });                // 내 차례가 아님
  send(other, 'draw');
  const mine = m.room.myHand;
  const illegal = mine.find((c) => !L.canPlay(viewOf(m.room), m.room.you, c));
  const bads = [{}, { card: 'x' }, { card: null }, { card: 1.5 }, { card: -1 }, { card: 99 }, { card: 1e999 }, { card: [3] }, { card: other.room.myHand[0] }];
  if (illegal !== undefined) bads.push({ card: illegal });
  for (const bad of bads) send(m, 'play', bad);
  for (const bad of [{ suit: 'a' }, { suit: 9 }]) { const legal = mine.find((c) => L.canPlay(viewOf(m.room), m.room.you, c) && L.rankOf(c) !== 7); if (legal !== undefined) send(m, 'play', { card: legal, ...bad, one: true }); break; }
  await sleep(300);
  assert.ok(m.room.event && m.room.event.kind === 'play' && m.room.event.who === m.room.you, 'only the one legal play with junk options went through');
  assert.strictEqual(other.room.players[other.room.you].count, 7, 'the other player lost no card');
  closeAll(a, b);
});

test('a legal play and a draw are applied and seen by both players', async () => {
  await ready;
  const [a, b] = await pair();
  const m = onTurn([a, b]), other = m === a ? b : a;
  const v = viewOf(m.room);
  const legal = L.legalPlays(v, m.room.you).filter((c) => L.rankOf(c) !== 7 && !L.isAttack(c));
  if (legal.length) {
    send(m, 'play', { card: legal[0], one: true });
    assert.ok(await until(() => a.room.event && b.room.event && a.room.top === legal[0] && b.room.top === legal[0]));
    assert.strictEqual(a.room.event.kind, 'play');
    assert.strictEqual(a.room.event.card, legal[0]);
    assert.strictEqual(m.room.myHand.length, 6);
  } else {
    send(m, 'draw');
    assert.ok(await until(() => m.room.myHand.length === 8));
    assert.strictEqual(a.room.event.kind, 'draw');
  }
  assert.deepStrictEqual(a.room.players.map((p) => p.count), b.room.players.map((p) => p.count));
  closeAll(a, b);
});

test('drawing is always allowed on your turn and passes the turn', async () => {
  await ready;
  const [a, b] = await pair();
  const m = onTurn([a, b]), other = m === a ? b : a;
  send(m, 'draw');
  assert.ok(await until(() => m.room.myHand.length === 8 && other.room.turn === other.room.you));
  assert.strictEqual(a.room.event.kind, 'draw');
  assert.strictEqual(a.room.drawLeft, 54 - 14 - 1 - 1);
  closeAll(a, b);
});

test('two bots play a full two player game to the end', async () => {
  await ready;
  const [a, b] = await pair();
  await playOut([a, b]);
  assert.strictEqual(a.room.state, 'over');
  assert.strictEqual(a.room.winner, b.room.winner);
  assert.ok(['empty', 'bust', 'last'].includes(a.room.reason));
  if (a.room.reason === 'empty') assert.strictEqual(a.room.players[a.room.winner].count, 0);
  closeAll(a, b);
});

test('a four player room: only the host starts it, five is too many, no joining after the start', async () => {
  await ready;
  const cs = await lobby(4);
  assert.ok(cs.every((c) => c.room.state === 'waiting'));
  send(cs[1], 'start');                                              // 방장이 아님
  await sleep(250);
  assert.ok(cs.every((c) => c.room.state === 'waiting'), 'a guest cannot start');
  const fifth = await open('5');
  send(fifth, 'join', { code: cs[0].room.code });
  assert.ok(await until(() => fifth.errors.length > 0));
  assert.match(fifth.errors[0], /가득/);
  send(cs[0], 'start');
  assert.ok(await until(() => cs.every((c) => c.room.state === 'playing')));
  assert.ok(cs.every((c) => c.room.myHand.length === 5), 'five cards each with four players');
  assert.deepStrictEqual(cs.map((c) => c.room.you).sort(), [0, 1, 2, 3]);
  const late = await open('늦게');
  send(late, 'join', { code: cs[0].room.code });
  assert.ok(await until(() => late.errors.length > 0));
  assert.match(late.errors[0], /이미 시작/);
  closeAll(...cs, fifth, late);
});

test('a room needs two players to start', async () => {
  await ready;
  const a = await open('혼자');
  send(a, 'create');
  assert.ok(await until(() => a.room && a.room.code));
  send(a, 'start');
  await sleep(250);
  assert.strictEqual(a.room.state, 'waiting');
  a.ws.close();
});

test('four bots play a full game and the turn order follows the rules', async () => {
  await ready;
  const cs = await startRoom(4);
  await playOut(cs, 600);
  assert.ok(cs.every((c) => c.room.state === 'over'));
  assert.ok(cs.every((c) => c.room.winner === cs[0].room.winner));
  assert.ok(['empty', 'bust', 'last'].includes(cs[0].room.reason));
  closeAll(...cs);
});

test('running out of time draws a card for you; missing two turns in a row puts you out', async () => {
  await ready;
  const cs = await startRoom(3);
  const idle = onTurn(cs);
  const startCount = idle.room.myHand.length;
  assert.ok(await until(() => idle.room.players[idle.room.you].count > startCount, 4000), 'a card was drawn for the idle player');
  assert.strictEqual(idle.room.event.kind, 'timeout');
  // 나머지 두 명은 계속 둔다. 그러면 idle 은 다시 차례가 와서 또 넘기면 빠진다
  for (let i = 0; i < 40 && idle.room.players[idle.room.you].alive; i++) {
    const m = onTurn(cs.filter((c) => c !== idle));
    if (m && m.room.turn === m.room.you) await botStep(cs.filter((c) => c !== idle).length === 2 ? cs : cs);
    else await sleep(120);
    if (cs[0].room.state === 'over') break;
  }
  assert.ok(await until(() => !idle.room.players[idle.room.you].alive || idle.room.state === 'over', 8000), 'two missed turns put the player out');
  closeAll(...cs);
});

test('in a three player game a resigning player drops out and the other two play on', async () => {
  await ready;
  const cs = await startRoom(3);
  const quitter = cs[1];
  send(quitter, 'resign');
  assert.ok(await until(() => cs.every((c) => !c.room.players[quitter.room.you].alive)));
  assert.ok(cs.every((c) => c.room.state === 'playing'), 'the game goes on');
  assert.notStrictEqual(cs[0].room.turn, quitter.room.you);
  send(cs[2], 'resign');
  assert.ok(await until(() => cs[0].room.state === 'over'));
  assert.strictEqual(cs[0].room.winner, cs[0].room.you, 'the last one standing wins');
  assert.strictEqual(cs[0].room.reason, 'last');
  closeAll(...cs);
});

test('in a two player game resigning ends it at once', async () => {
  await ready;
  const [a, b] = await pair();
  send(a, 'resign');
  assert.ok(await until(() => b.room.state === 'over'));
  assert.strictEqual(b.room.winner, b.room.you);
  closeAll(a, b);
});

test('rematch needs everyone, starts a new game and changes who goes first', async () => {
  await ready;
  const [a, b] = await pair();
  const first = a.room.turn;
  send(a, 'resign');
  assert.ok(await until(() => b.room.state === 'over'));
  send(a, 'rematch');
  await sleep(200);
  assert.strictEqual(b.room.state, 'over', 'one vote is not enough');
  send(b, 'rematch');
  assert.ok(await until(() => a.room.state === 'playing' && a.room.games === 2));
  assert.notStrictEqual(a.room.turn, first, 'the first player rotates');
  assert.strictEqual(a.room.myHand.length, 7);
  assert.strictEqual(a.room.event, null);
  closeAll(a, b);
});

test('when the host leaves a waiting room the guests are sent out', async () => {
  await ready;
  const cs = await lobby(3);
  send(cs[0], 'leave');
  assert.ok(await until(() => cs[1].errors.length > 0 && cs[2].errors.length > 0));
  assert.match(cs[1].errors[0], /방장/);
  closeAll(...cs);
});

test('a guest leaving a waiting room just frees the seat', async () => {
  await ready;
  const cs = await lobby(3);
  send(cs[1], 'leave');
  assert.ok(await until(() => cs[0].room.players.length === 2 && cs[2].room.players.length === 2));
  assert.deepStrictEqual(cs[2].room.you, 1, 'seats close up');
  closeAll(...cs);
});

test('a dropped player can resume the same seat and keeps the hand', async () => {
  await ready;
  const [a, b] = await pair();
  const token = a.room.token, code = a.room.code, you = a.room.you, hand = a.room.myHand.slice();
  a.ws.close();
  assert.ok(await until(() => b.room.players.some((p) => !p.online)), 'the other side sees the drop');
  const a2 = await open('가');
  send(a2, 'resume', { code, token });
  assert.ok(await until(() => a2.room && a2.room.you === you && a2.room.state === 'playing'));
  assert.deepStrictEqual(a2.room.myHand, hand, 'same hand');
  assert.ok(await until(() => b.room.players.every((p) => p.online)));
  closeAll(a2, b);
});

// 같은 주소에서 코드를 일부러 많이 틀리므로 이 시험은 맨 뒤에 둔다 (뒤의 시험이 막히지 않게)
test('repeated wrong room codes get temporarily blocked', async () => {
  await ready;
  const c = await open();
  for (let i = 0; i < 10; i++) c.ws.send(JSON.stringify({ t: 'join', code: 'ZZZ' + 'ABCDEFGH'[i] }));
  await sleep(500);
  assert.ok(c.errors.some((x) => /그런 방이 없어요/.test(x)), 'first attempts are answered with room-not-found');
  assert.ok(c.errors.some((x) => /너무 많이 틀렸어요/.test(x)), 'many wrong codes get blocked');
  c.ws.close();
});

test('shutdown', () => { child.kill(); });
