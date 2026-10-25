'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (arcade/public/tutorial.js 가 듣는다. 튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 원카드: 화면·입력·소리·온라인. 규칙과 컴퓨터는 logic.js (LOGIC_ONECARD), 방·매칭은 server.js
(() => {
const L = LOGIC_ONECARD;
const { SUITS } = L;
const $ = (id) => document.getElementById(id);
const T = { cpu: 900, over: 1100 };                        // 시간(ms). 시험용으로 줄일 수 있다

// ---------- 저장소 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
let wins = Number(store.get('onecardWins')) || 0;
const ONLINE_KEY = 'onecardOnline', SESSION_KEY = 'onecardSession';
const loadJson = (k) => { try { return JSON.parse(store.get(k)) || {}; } catch (_) { return {}; } };
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; } }
function saveSession(s) { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const myName = () => store.get('onecardName') || '';
// 이름 뒤에 붙는 '이/가' (받침이 있으면 이)
const ga = (name) => {
  const ch = String(name).slice(-1), c = ch.charCodeAt(0) - 0xAC00;
  const batchim = /[0-9]/.test(ch) ? '013678'.includes(ch) : c >= 0 && c <= 11171 && c % 28 !== 0;      // 숫자는 읽는 소리(일·삼·육·칠·팔·영)로 받침을 본다
  return name + (batchim ? '이' : '가');
};

// ---------- 소리 ----------
let audio = null;
let muted = store.get('onecardMuted') === '1';
function tone(freq, dur, type = 'sine', vol = 0.09, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  } catch (_) {}
}
const seq = (notes, step, type = 'triangle', vol = 0.09) => notes.forEach((f, i) => setTimeout(() => tone(f, step * 0.0009, type, vol), i * step));
const sfx = {
  play: () => tone(520, 0.07, 'triangle', 0.08, 80),
  draw: () => tone(300, 0.08, 'sine', 0.08, -60),
  attack: () => seq([330, 260, 200], 70, 'sawtooth', 0.06),
  skip: () => tone(700, 0.1, 'square', 0.04, -300),
  one: () => seq([784, 988], 80, 'triangle', 0.1),
  bad: () => tone(160, 0.12, 'square', 0.04),
  found: () => seq([392, 523], 90, 'triangle', 0.08),
  win: () => seq([523, 659, 784, 1047], 110, 'triangle', 0.1),
  lose: () => seq([392, 330, 262, 196], 150, 'sawtooth', 0.06),
};
function toggleMute() { muted = !muted; store.set('onecardMuted', muted ? '1' : '0'); $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').onclick = (e) => { e.currentTarget.blur(); toggleMute(); };
$('muteBtn').textContent = muted ? '🔇' : '🔊';

// ---------- 상태 ----------
let mode = 'easy';                // 'easy' · 'hard' (컴퓨터) · 'online'
let phase = 'title';              // title · play · over
let st = null, cpuCount = 1;      // 컴퓨터 대전 판 (나는 0번)과 컴퓨터 수
let lastEvent = null;             // 컴퓨터 모드에서 마지막 행동 (온라인은 서버가 보낸 room.event)
let room = null, waitingNet = false, netDown = false, turnEnd = 0, recorded = '', seenEvent = 0;
let oneOn = false, pendingSeven = null, prevHand = new Set();
let cpuTimer = 0, overTimer = 0;
const online = () => mode === 'online';
const CPU_NAMES = ['나', '컴퓨터1', '컴퓨터2', '컴퓨터3'];

// 화면에 그릴 모양으로 (나는 you 번)
function model() {
  if (online()) {
    if (!room) return null;
    return { players: room.players, you: room.you, myHand: room.myHand, top: room.top, suit: room.suit, stack: room.stack, turn: room.turn, dir: room.dir, drawLeft: room.drawLeft,
      state: room.state, winner: room.winner, reason: room.reason, event: room.event };
  }
  if (!st) return null;
  return { players: st.hands.map((h, i) => ({ name: CPU_NAMES[i], count: h.length, alive: st.alive[i], online: true, gone: false })), you: 0, myHand: st.hands[0], top: st.top, suit: st.suit, stack: st.stack,
    turn: st.turn, dir: st.dir, drawLeft: st.draw.length, state: st.winner >= 0 ? 'over' : 'playing', winner: st.winner, reason: st.reason, event: lastEvent };
}
// 규칙 함수가 읽는 판 (남의 손은 장수만)
function viewOf(m) {
  return { n: m.players.length, hands: m.players.map((p, i) => (i === m.you ? m.myHand : new Array(p.count).fill(0))), top: m.top, suit: m.suit, stack: m.stack, turn: m.turn,
    dir: m.dir, alive: m.players.map((p) => p.alive), winner: m.state === 'over' ? m.winner : -1 };
}
const nameOf = (m, i) => (i === m.you ? '나' : m.players[i].name);
const subj = (m, i) => (i === m.you ? '내가' : ga(m.players[i].name));
const myTurn = (m) => !!m && m.state === 'playing' && m.turn === m.you && m.players[m.you].alive && !netDown;
const canAct = (m) => myTurn(m) && !waitingNet;

// ---------- 카드 그리기 ----------
const rankText = (c) => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[L.rankOf(c)] || String(L.rankOf(c)));
function cardEl(c, cls = '') {
  const d = document.createElement('div');
  if (L.isJoker(c)) {
    d.className = 'card joker ' + (c === 53 ? 'red ' : '') + cls;
    d.innerHTML = `<span class="c">JOKER</span><span class="s">🃏</span>`;
  } else {
    d.className = 'card ' + (L.isRed(c) ? 'red ' : '') + cls;
    d.innerHTML = `<span class="c">${rankText(c)}<br>${SUITS[L.suitOf(c)]}</span><span class="s">${SUITS[L.suitOf(c)]}</span>`;
  }
  d.dataset.card = String(c);
  return d;
}
const sortHand = (h) => h.slice().sort((a, b) => (L.isJoker(a) - L.isJoker(b)) || (L.suitOf(a) - L.suitOf(b)) || (L.rankOf(a) - L.rankOf(b)));

// ---------- 그리기 ----------
function render() {
  const m = model();
  if (!m) { $('opps').innerHTML = ''; $('hand').innerHTML = ''; $('topCard').innerHTML = ''; renderHud(null); return; }
  const v = viewOf(m);
  const mine = canAct(m);
  // 상대들
  $('opps').innerHTML = m.players.map((p, i) => (i === m.you ? '' : `<div class="opp${m.turn === i && m.state === 'playing' ? ' turn' : ''}${p.alive ? '' : ' out'}"><span class="nm">${esc(p.name)}</span>${p.online || p.gone ? '' : '<span class="off">끊김</span>'}<span class="ct">🂠 ${p.alive ? p.count : 0}<small>장</small></span></div>`)).join('');
  // 가운데
  $('topCard').innerHTML = '';
  if (m.top >= 0) $('topCard').appendChild(cardEl(m.top, 'big'));
  $('drawCt').textContent = m.top >= 0 ? String(m.drawLeft) : '';
  const sn = $('suitNow');
  sn.textContent = m.suit >= 0 ? SUITS[m.suit] : '★';
  sn.className = m.suit === 1 || m.suit === 2 ? 'red' : '';
  sn.title = m.suit >= 0 ? '지금 낼 수 있는 모양' : '아무 카드나 낼 수 있어요';
  $('dirNow').textContent = m.players.filter((p) => p.alive).length > 2 ? (m.dir === 1 ? '↻ 시계 방향' : '↺ 반시계') : '';
  $('atk').textContent = m.stack > 0 ? `공격 ${m.stack}장!` : '';
  // 내 손
  const hand = sortHand(m.myHand), seen = new Set(m.myHand);
  const box = $('hand');
  const scroll = box.scrollLeft;
  box.innerHTML = '';
  for (const c of hand) {
    const legal = mine && L.canPlay(v, m.you, c);
    const el = cardEl(c, (legal ? 'can ' : mine ? 'dim ' : '') + (c === pendingSeven ? 'sel ' : '') + (prevHand.size && !prevHand.has(c) ? 'new' : ''));
    el.onclick = () => onCard(c);
    box.appendChild(el);
  }
  box.scrollLeft = scroll;
  prevHand = seen;
  // 단추
  const db = $('drawBtn');
  db.disabled = !mine;
  db.classList.toggle('go', mine && L.legalPlays(v, m.you).length === 0);
  db.textContent = m.stack > 0 ? `🃏 ${m.stack}장 받기` : '🃏 한 장 뽑기';
  const ob = $('oneBtn');
  ob.style.display = mine && m.myHand.length === 2 ? '' : 'none';
  ob.classList.toggle('on', oneOn);
  ob.textContent = oneOn ? '✅ 원카드!' : '☝️ 원카드!';
  $('suitPick').style.display = pendingSeven !== null && mine ? 'flex' : 'none';
  renderHud(m);
}
function renderHud(m = model()) {
  $('wins').textContent = wins.toLocaleString('ko-KR');
  let text = '원카드';
  if (m && phase === 'play' && m.state === 'playing') {
    const sec = Math.max(0, Math.ceil((turnEnd - performance.now()) / 1000));
    if (online() && netDown) text = '연결 다시 붙이는 중…';
    else if (m.turn === m.you) text = m.stack > 0 ? `내 차례 · 막거나 ${m.stack}장 받기${online() ? ` · ${sec}초` : ''}` : `내 차례 · 카드를 내요${online() ? ` · ${sec}초` : ''}`;
    else text = `${m.players[m.turn].name} 차례${online() ? ` · ${sec}초` : '…'}`;
  }
  $('turn').textContent = text;
  $('resignBtn').style.display = online() && room && room.state === 'playing' ? '' : 'none';
}
function say(t) { $('msg').textContent = t; }

// ---------- 창 ----------
const overlayOpen = () => !$('overlay').classList.contains('hidden');
function showOverlay(html) { $('overlay').innerHTML = html; $('overlay').classList.remove('hidden'); }
function hideOverlay() { $('overlay').classList.add('hidden'); }

// ---------- 행동 알리기 ----------
// ev: { who, kind: play|draw|timeout|out, card, effect, skipped, reversed, penalty, suit, n, bust, reason }
function announce(m, ev) {
  const who = ev.who, name = nameOf(m, who), s = subj(m, who);
  if (ev.kind === 'play') {
    let t = `${name} ▶ ${L.nameOf(ev.card)}`;
    if (ev.effect === 'attack') { t += ` · 공격! 쌓인 ${m.stack}장`; sfx.attack(); }
    else if (ev.effect === 'skip' || ev.effect === 'skip2') { t += ev.skipped === 2 ? ' · 두 사람 건너뛰기' : ' · 다음 사람 건너뛰기'; sfx.skip(); }
    else if (ev.effect === 'reverse') { t += ' · 방향 바꾸기'; sfx.skip(); }
    else if (ev.effect === 'suit') { t += ` · 모양을 ${SUITS[ev.suit]}로!`; sfx.play(); }
    else sfx.play();
    if (ev.penalty) t += ` · 원카드를 안 불러 ${ev.penalty}장 벌칙!`;
    if (ev.bust) t += ' · 파산!';
    if (!ev.penalty && m.players[who] && m.players[who].alive && m.players[who].count === 1) { t += ' · 원카드!'; sfx.one(); }
    say(t);
  } else if (ev.kind === 'draw') { sfx.draw(); say(`${s} ${ev.n}장을 뽑았어요${ev.bust ? ' · 파산!' : ''}`); }
  else if (ev.kind === 'timeout') { sfx.draw(); say(`${name} 시간 초과 · ${ev.n}장을 뽑았어요`); }
  else if (ev.kind === 'out') say(`${ga(name)} 빠졌어요 (${{ resign: '기권', left: '나감', timeout: '시간 초과', bust: '파산' }[ev.reason] || ev.reason})`);
}

// ---------- 내 행동 ----------
function onCard(c) {
  const m = model();
  if (!canAct(m)) return;
  const v = viewOf(m);
  if (!L.canPlay(v, m.you, c)) { sfx.bad(); say(m.stack > 0 ? '공격을 막을 수 있는 카드만 낼 수 있어요. 아니면 받아야 해요' : '모양이나 숫자가 같은 카드만 낼 수 있어요'); return; }
  if (L.rankOf(c) === 7 && !L.isJoker(c)) { pendingSeven = c; say('7! 바꿀 모양을 골라요'); render(); return; }
  doPlay(c, undefined);
}
function doPlay(c, suit) {
  const m = model();
  if (!canAct(m)) return;
  const one = oneOn;
  pendingSeven = null; oneOn = false;
  if (online()) { waitingNet = true; net.send('play', { card: c, suit, one }); render(); return; }
  const r = L.play(st, 0, c, { suit, one });
  if (!r) return;
  lastEvent = { who: 0, kind: 'play', card: c, effect: r.effect, skipped: r.skipped, reversed: r.reversed, penalty: r.penalty, suit: r.suit, bust: !st.alive[0] };
  tutorialSignal('play'); if (r.penalty) tutorialSignal('penalty');
  afterCpuAction();
}
function onDraw() {
  const m = model();
  if (!canAct(m)) return;
  pendingSeven = null; oneOn = false;
  if (online()) { waitingNet = true; net.send('draw'); render(); return; }
  const r = L.drawTurn(st, 0);
  if (!r) return;
  lastEvent = { who: 0, kind: 'draw', n: r.n, wanted: r.wanted, bust: !st.alive[0] };
  tutorialSignal('draw');
  afterCpuAction();
}
function onOne() {
  const m = model();
  if (!canAct(m) || m.myHand.length !== 2) return;
  oneOn = !oneOn; if (oneOn) { sfx.one(); tutorialSignal('one'); }
  render();
}
function onSuit(s) {
  if (pendingSeven === null) return;
  tutorialSignal('suit');
  doPlay(pendingSeven, s);
}

// ---------- 컴퓨터 대전 ----------
function startCpu(level, n) {
  leaveOnline();
  clearTimeout(cpuTimer); clearTimeout(overTimer);
  mode = level; cpuCount = n - 1;
  st = L.newGame({ players: n, first: Math.random() < 0.5 ? 0 : 1 + Math.floor(Math.random() * (n - 1)) });
  phase = 'play'; lastEvent = null; oneOn = false; pendingSeven = null; prevHand = new Set(); turnEnd = 0;
  hideOverlay();
  say(st.turn === 0 ? '먼저 내요! 같은 모양이나 숫자의 카드를 내요' : `${CPU_NAMES[st.turn]}이(가) 먼저 시작해요`);
  render();
  if (st.turn !== 0) cpuTimer = setTimeout(cpuTurn, T.cpu);
}
function afterCpuAction() {
  const m = model();
  announce(m, lastEvent);
  render();
  if (st.winner >= 0) { overTimer = setTimeout(showOver, T.over); return; }
  if (st.turn !== 0) cpuTimer = setTimeout(cpuTurn, T.cpu);
}
function cpuTurn() {
  if (phase !== 'play' || !st || st.winner >= 0 || st.turn === 0 || online()) return;
  const who = st.turn;
  const a = L.aiPick(st, who, mode === 'hard' ? 'hard' : 'easy');
  if (!a) return;
  if (a.type === 'draw') {
    const r = L.drawTurn(st, who);
    lastEvent = { who, kind: 'draw', n: r.n, wanted: r.wanted, bust: !st.alive[who] };
  } else {
    const r = L.play(st, who, a.card, { suit: a.suit, one: a.one });
    lastEvent = { who, kind: 'play', card: a.card, effect: r.effect, skipped: r.skipped, reversed: r.reversed, penalty: r.penalty, suit: r.suit, bust: !st.alive[who] };
  }
  afterCpuAction();
}
function showOver() {
  phase = 'over';
  const youWon = st.winner === 0;
  if (youWon) { wins++; store.set('onecardWins', String(wins)); sfx.win(); } else sfx.lose();
  const why = st.reason === 'empty' ? (youWon ? '카드를 모두 냈어요!' : `${ga(CPU_NAMES[st.winner])} 카드를 모두 냈어요`) : st.reason === 'bust' ? (youWon ? '상대가 카드 20장으로 파산했어요' : '카드가 20장이 넘어 파산했어요') : '끝까지 남았어요';
  const rows = st.hands.map((h, i) => `<dt>${CPU_NAMES[i]}</dt><dd>${st.alive[i] ? h.length + '장' : '파산'}</dd>`).join('');
  showOverlay(`
    <h2>${youWon ? '이겼어요! 🎉' : '아쉬워요! 😵'}</h2>
    <p>${esc(why)}</p>
    <dl class="stats card2">${rows}</dl>
    <p>컴퓨터 상대 승리 <b>${wins}</b>번</p>
    <div class="col"><button data-act="again">다시 하기</button><button class="sub" data-act="home">처음으로</button></div>`);
  render();
}
function showTitle() {
  leaveOnline();
  clearTimeout(cpuTimer); clearTimeout(overTimer);
  mode = 'easy'; phase = 'title'; st = null; lastEvent = null; oneOn = false; pendingSeven = null; prevHand = new Set();
  say(''); render();
  const on = loadJson(ONLINE_KEY);
  showOverlay(`
    <h1>원카드</h1>
    <p>모양이나 숫자가 같은 카드를 내서<br><b>손의 카드를 먼저 다 내면</b> 이겨요!</p>
    <div class="card2" style="font-size:12.5px"><b>2</b> 공격 2장 · <b>A</b> 3장(♠A 5장) · <b>조커</b> 5·7장<br>공격은 같은 숫자·모양의 공격 카드로 막고 쌓여요<br><b>J</b> 건너뛰기 · <b>Q</b> 방향 바꾸기 · <b>K</b> 두 명 건너뛰기 · <b>7</b> 모양 바꾸기<br>한 장 남기면 <b>원카드!</b> 안 부르면 벌칙 2장 · 20장이면 파산</div>
    <div class="col"><button data-act="cpu" data-lv="easy" data-n="2">🤖 컴퓨터랑 · 쉬움</button><button class="sub" data-act="cpu" data-lv="hard" data-n="2">🤖 컴퓨터랑 · 어려움</button>
      <div class="row"><button class="sub" data-act="cpu" data-lv="hard" data-n="3">👥 3인</button><button class="sub" data-act="cpu" data-lv="hard" data-n="4">👥 4인</button></div>
      <button class="sub" data-act="online">🌐 온라인 대전${on.w || on.l ? ` · ${on.w || 0}승 ${on.l || 0}패` : ''}</button></div>`);
}

// ---------- 온라인: 연결 ----------
const net = {
  ws: null, pulse: null, outbox: [], retry: 0,
  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${location.pathname}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw('hello', { name: myName() });
      const s = loadSession();
      if (s) this.raw('resume', s);
      for (const [t, p] of this.outbox.splice(0)) this.raw(t, p);
      clearInterval(this.pulse);
      // 프록시가 WebSocket ping 을 대신 받아버리는 환경이 있어 살아있다는 신호를 직접 보낸다
      this.pulse = setInterval(() => this.raw('pulse'), 10000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onNet(m); };
    ws.onclose = () => {
      clearInterval(this.pulse);
      if (this.ws !== ws) return;   // 일부러 닫은 연결
      this.ws = null;
      if (!online()) return;
      if (room || loadSession()) {
        // 대국 중이면 계속 다시 붙어본다. 서버는 30초 동안 자리를 비워둔다.
        netDown = true; waitingNet = false; render();
        setTimeout(() => { if (online()) this.connect(); }, Math.min(4000, 500 * 2 ** this.retry++));
      } else showOnline('서버와 연결이 끊겼어요. 다시 시도해 주세요.');
    };
  },
  send(t, p = {}) {
    if (this.ws && this.ws.readyState === 1) this.raw(t, p);
    else { this.outbox.push([t, p]); this.connect(); }
  },
  raw(t, p = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...p })); },
  close() {
    const ws = this.ws;
    this.ws = null; this.outbox = [];
    clearInterval(this.pulse);
    if (ws) ws.close();
  },
};

function onNet(m) {
  if (m.t === 'queued') showQueued();
  else if (m.t === 'room') applyRoom(m);
  else if (m.t === 'error') { room = null; saveSession(null); showOnline(m.msg); }
  else if (m.t === 'resumeFailed') {
    saveSession(null);
    if (room) { room = null; showOnline('대국이 끝나서 이어갈 수 없어요.'); }
    netDown = false; render();
  }
}

function leaveOnline() {
  if (!online()) return;
  net.send('leave'); net.close();
  saveSession(null);
  room = null; netDown = false; waitingNet = false; mode = 'easy'; phase = 'title';
}

// ---------- 온라인: 대국 ----------
function applyRoom(r) {
  const fresh = !room || room.code !== r.code;
  const newGame = fresh || room.games !== r.games;
  room = r;
  netDown = false; waitingNet = false;
  saveSession({ code: r.code, token: r.token });
  turnEnd = performance.now() + r.remain;
  if (newGame) { seenEvent = r.event ? r.event.seq : 0; oneOn = false; pendingSeven = null; prevHand = new Set(); say(''); }
  if (r.state === 'waiting') { phase = 'title'; showWaiting(); render(); return; }
  phase = r.state === 'playing' ? 'play' : 'over';
  if (newGame && r.state === 'playing') { sfx.found(); say(r.turn === r.you ? '먼저 내요! 같은 모양이나 숫자의 카드를 내요' : `${ga(r.players[r.turn].name)} 먼저 시작해요`); }
  if (!($('overlay').dataset.screen === 'confirm') && r.state !== 'over') hideOverlay();
  const m = model();
  if (r.event && r.event.seq > seenEvent && !newGame) { seenEvent = r.event.seq; announce(m, r.event); }
  if (!myTurn(m)) { oneOn = false; pendingSeven = null; }
  render();
  if (r.state === 'over') afterOver();
}
function afterOver() {
  const r = room;
  const key = `${r.code}:${r.games}:${r.reason}:${r.winner}`;
  if (recorded !== key) {
    recorded = key;
    const rec = loadJson(ONLINE_KEY);
    if (r.winner === r.you) { rec.w = (rec.w || 0) + 1; sfx.win(); } else { rec.l = (rec.l || 0) + 1; sfx.lose(); }
    store.set(ONLINE_KEY, JSON.stringify(rec));
    setTimeout(() => { if (room && room.state === 'over') showResult(); }, T.over);
  } else if (overlayOpen()) showResult();
}

function showResult() {
  const r = room;
  const won = r.winner === r.you;
  const wname = r.players[r.winner] ? r.players[r.winner].name : '';
  const why = {
    empty: won ? '카드를 모두 냈어요!' : `${ga(wname)} 카드를 모두 냈어요`,
    last: won ? '끝까지 남았어요!' : `${ga(wname)} 끝까지 남았어요`,
    bust: won ? '상대가 파산했어요 (카드 20장)' : (r.players[r.you] && !r.players[r.you].alive ? '카드가 20장이 되어 파산했어요' : `${ga(wname)} 끝까지 남았어요`),
  }[r.reason] || '';
  const rec = loadJson(ONLINE_KEY);
  const stay = r.players.filter((p) => !p.gone);
  const iVoted = r.rematch.includes(r.you);
  let again;
  if (stay.length < 2) again = '<p>같이 할 사람이 나갔어요</p>';
  else if (iVoted) again = `<p>다른 사람들을 기다리는 중… (${r.rematch.length}/${stay.length})</p>`;
  else again = `${r.rematch.length ? `<p>${r.rematch.length}명이 한 판 더 하고 싶어해요!</p>` : ''}<button data-act="rematch">한 판 더</button>`;
  const rows = r.players.map((p, i) => `<dt>${esc(i === r.you ? '나' : p.name)}${i === r.winner ? ' 🏆' : ''}</dt><dd>${!p.alive ? '빠짐' : p.count + '장'}</dd>`).join('');
  showOverlay(`
    <h2>${won ? '🎉 승리!' : '😵 패배'}</h2>
    ${why ? `<p>${esc(why)}</p>` : ''}
    <dl class="stats card2">${rows}</dl>
    <span class="tag">온라인 ${rec.w || 0}승 ${rec.l || 0}패</span>
    <div class="col">${again}
      <div class="row"><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="leave">나가기</button></div>
    </div>`);
}

function showOnline(error = '') {
  leaveOnline();
  clearTimeout(cpuTimer); clearTimeout(overTimer);
  mode = 'online'; phase = 'title'; room = null; st = null; waitingNet = false;
  say(''); render();
  showOverlay(`
    <h2>🌐 온라인 대전</h2>
    <input id="nameInput" maxlength="10" placeholder="내 이름 (최대 10자)" value="${esc(myName())}" autocomplete="off">
    <div class="col">
      <button data-act="quick">⚡ 빠른 대전 (2명)</button>
      <button class="sub" data-act="create">방 만들기 (2~4명)</button>
      <div class="row join"><input id="codeInput" maxlength="4" placeholder="방 코드" autocomplete="off" autocapitalize="characters"><button class="sub" data-act="join">들어가기</button></div>
    </div>
    <span class="error">${esc(error)}</span>
    <button class="back" data-act="home">← 처음으로</button>
    <p style="font-size:12.5px">한 번 둘 때마다 30초 · 넘기면 대신 뽑고, 두 번 연달아 넘기면 빠져요</p>`);
}
function showQueued() {
  showOverlay(`
    <h2>상대를 찾는 중…</h2>
    <div class="dots"><span></span><span></span><span></span></div>
    <p>누군가 빠른 대전을 누르면 바로 시작해요</p>
    <button class="sub" data-act="cancel">취소</button>`);
}
const inviteUrl = () => `${location.origin}${location.pathname}?room=${room.code}`;
function showWaiting() {
  const host = room.you === 0, n = room.players.length;
  showOverlay(`
    <h2>친구를 기다리는 중…</h2>
    <p>방 코드</p>
    <div class="code">${esc(room.code)}</div>
    <div class="plist">${room.players.map((p, i) => `<div class="${i === room.you ? 'you' : ''}${p.online ? '' : ' off'}">${i === 0 ? '👑 ' : ''}${esc(p.name)}${i === room.you ? ' (나)' : ''}</div>`).join('')}</div>
    <p style="font-size:13px">친구가 <b>온라인 대전 → 들어가기</b>에 코드를 넣으면 들어와요 (최대 4명)</p>
    <button data-act="copy">🔗 초대 링크 복사</button>
    ${host ? `<button data-act="start"${n < 2 ? ' disabled style="opacity:.5"' : ''}>▶ 시작 (${n}명)</button>` : '<p>방장이 시작하길 기다려요</p>'}
    <button class="sub" data-act="cancel">나가기</button>`);
}
function saveName() {
  const input = $('nameInput');
  if (!input) return;
  const name = input.value.trim().slice(0, 10);
  store.set('onecardName', name);
  net.send('hello', { name });
}
function confirmResign() {
  showOverlay(`<h2>기권할까요?</h2><p>이번 판은 패배로 기록돼요<br>(3~4명이면 나만 빠지고 나머지는 계속해요)</p>
    <div class="row"><button data-act="close">계속하기</button><button class="sub" data-act="resign">🏳 기권</button></div>`);
  $('overlay').dataset.screen = 'confirm';
}

$('overlay').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  btn.blur();
  $('overlay').dataset.screen = '';
  const act = btn.dataset.act;
  if (act === 'cpu') { lastCpu = { lv: btn.dataset.lv, n: Number(btn.dataset.n) }; startCpu(lastCpu.lv, lastCpu.n); }
  else if (act === 'again') startCpu(lastCpu.lv, lastCpu.n);
  else if (act === 'home') showTitle();
  else if (act === 'online') showOnline();
  else if (act === 'quick') { saveName(); net.send('quick'); }
  else if (act === 'create') { saveName(); net.send('create'); }
  else if (act === 'start') net.send('start');
  else if (act === 'join') {
    const code = ($('codeInput').value || '').trim().toUpperCase();
    if (code.length !== 4) { $('overlay').querySelector('.error').textContent = '방 코드 4자리를 넣어 주세요.'; return; }
    saveName();
    net.send('join', { code });
  } else if (act === 'cancel') { net.send('cancel'); showOnline(); }
  else if (act === 'copy') {
    const url = inviteUrl();
    const done = () => { btn.textContent = '✅ 복사했어요'; setTimeout(() => { btn.textContent = '🔗 초대 링크 복사'; }, 1500); };
    if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: '원카드 한 판 해요!', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('링크를 복사하세요', url));
    else prompt('링크를 복사하세요', url);
  } else if (act === 'rematch') { net.send('rematch'); }
  else if (act === 'view') hideOverlay();
  else if (act === 'leave') showOnline();
  else if (act === 'resign') { net.send('resign'); hideOverlay(); }
  else if (act === 'close') hideOverlay();
});
let lastCpu = { lv: 'easy', n: 2 };
$('overlay').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'codeInput') $('overlay').querySelector('[data-act="join"]').click();
  if (e.target.id === 'nameInput') $('overlay').querySelector('[data-act="quick"]').click();
  e.stopPropagation();
});
$('resignBtn').onclick = (e) => { e.currentTarget.blur(); if (online() && room && room.state === 'playing') confirmResign(); };
$('drawBtn').onclick = (e) => { e.currentTarget.blur(); onDraw(); };
$('draw').onclick = () => onDraw();
$('oneBtn').onclick = (e) => { e.currentTarget.blur(); onOne(); };
for (let s = 0; s < 4; s++) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = SUITS[s]; if (s === 1 || s === 2) b.className = 'red';
  b.onclick = () => onSuit(s);
  $('suitPick').appendChild(b);
}
addEventListener('keydown', (e) => { if (e.target.tagName !== 'INPUT' && e.code === 'KeyM') toggleMute(); });
setInterval(() => { if (online() && room && room.state === 'playing' && !netDown) renderHud(); }, 500);

// ---------- 시작 ----------
// 초대 링크(?room=CODE)로 들어왔거나, 새로고침 전에 하던 대국이 있으면 온라인으로 바로 간다
const invite = new URLSearchParams(location.search).get('room');
if (invite) { try { window.history.replaceState(null, '', location.pathname); } catch (_) {} }
function joinInvite(code) { showOnline(); net.send('join', { code: code.toUpperCase() }); }
if (loadSession()) {
  mode = 'online';
  showOverlay('<h2>대국으로 돌아가는 중…</h2>');
  net.connect();
  const until = setInterval(() => {
    if (room || !loadSession()) { clearInterval(until); if (!room) invite ? joinInvite(invite) : showOnline(); }
  }, 100);
} else if (invite) joinInvite(invite);
else showTitle();

/* @test-hooks:start */
window.__oc = { get st() { return st; }, get mode() { return mode; }, get phase() { return phase; }, get room() { return room; }, T, onCard, onDraw, onOne, onSuit, startCpu, render };
/* @test-hooks:end */
})();
