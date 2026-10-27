'use strict';

// 원카드: 규칙만 모아 둔 파일 (그리기·입력 없음). 브라우저·서버·테스트(Node)가 같이 쓴다.
//
// - 카드는 52장 + 조커 2장 (번호 0~51: 모양 = 번호 ÷ 13 (♠♥◆♣), 숫자 = 번호 % 13 + 1 (1 은 A, 11 J, 12 Q, 13 K), 52 흑백 조커, 53 컬러 조커)
// - 2~4명. 2명이면 7장씩, 3~4명이면 5장씩. 버린 더미 맨 위 카드와 모양이나 숫자가 같은 카드를 낸다 (조커는 언제든)
// - 공격 카드: 2 는 2장, A 는 3장(♠A 는 5장), 흑백 조커 5장, 컬러 조커 7장. 공격을 받으면 같은 숫자나 같은 모양의 공격 카드(조커는 언제든)로 막으며 장수가 쌓이고,
//   막지 못하면(또는 안 막고) 쌓인 장수만큼 뽑는다. 흑백·컬러 조커는 조커로만 막는다
// - J 는 다음 사람 건너뛰기, Q 는 방향 바꾸기(2명이면 J 와 같다), K 는 두 사람 건너뛰기, 7 은 모양을 골라 바꾸기
// - 낼 수 없거나 내기 싫으면 한 장 뽑고 차례를 넘긴다
// - 카드를 내고 한 장이 남으면 '원카드'를 불러야 한다. 안 부르고 낸 사람은 벌칙으로 2장을 뽑는다
// - 손에 카드가 20장 이상이 되면 파산(그 사람은 빠지고 카드는 더미 밑으로). 카드를 모두 내면 이기고, 한 명만 남아도 이긴다
const LOGIC_ONECARD = (() => {
const SUITS = ['♠', '♥', '◆', '♣'];
const NUM_CARDS = 54, LIMIT = 20;
const suitOf = (c) => (c >= 52 ? -1 : Math.floor(c / 13));
const rankOf = (c) => (c >= 52 ? 0 : (c % 13) + 1);
const isJoker = (c) => c >= 52;
const isRed = (c) => c < 52 && (suitOf(c) === 1 || suitOf(c) === 2);
// 공격 카드가 주는 장수 (공격이 아니면 0)
const attackOf = (c) => {
  if (c === 52) return 5;
  if (c === 53) return 7;
  const r = rankOf(c);
  if (r === 2) return 2;
  if (r === 1) return suitOf(c) === 0 ? 5 : 3;
  return 0;
};
const isAttack = (c) => attackOf(c) > 0;
const nameOf = (c) => (c === 52 ? '흑백 조커' : c === 53 ? '컬러 조커' : SUITS[suitOf(c)] + ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[rankOf(c)] || rankOf(c)));

function rng(seed) {                                   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// 처음 펼치는 카드는 특별한 효과가 없는 숫자 카드(3~6, 8~10)만
const plainStart = (c) => !isJoker(c) && [3, 4, 5, 6, 8, 9, 10].includes(rankOf(c));

function newGame(opts = {}) {
  const n = Math.max(2, Math.min(4, opts.players || 2));
  const seed = opts.seed == null ? (Math.random() * 2 ** 31) | 0 : opts.seed;
  const rand = rng(seed);
  const deck = shuffle(Array.from({ length: NUM_CARDS }, (_, i) => i), rand);
  const per = n === 2 ? 7 : 5;
  const hands = Array.from({ length: n }, () => []);
  for (let i = 0; i < per; i++) for (let p = 0; p < n; p++) hands[p].push(deck.pop());
  let k = deck.length - 1;
  while (!plainStart(deck[k])) k--;
  const top = deck.splice(k, 1)[0];
  return {
    seed, rand, n, hands, draw: deck, discard: [top], top, suit: suitOf(top), stack: 0,
    turn: opts.first == null ? 0 : opts.first % n, dir: 1, alive: new Array(n).fill(true), winner: -1, reason: '',
    stats: { plays: new Array(n).fill(0), draws: new Array(n).fill(0) },
  };
}

const aliveCount = (st) => st.alive.filter(Boolean).length;
// p 에서 방향대로 steps 번째로 살아 있는 사람
function stepFrom(st, p, steps) {
  let cur = p;
  for (let i = 0; i < steps; i++) {
    do { cur = (cur + st.dir + st.n) % st.n; } while (!st.alive[cur]);
  }
  return cur;
}

// 이 카드를 지금 낼 수 있는가
function canPlay(st, p, card) {
  if (st.winner >= 0 || p !== st.turn || !st.alive[p] || !st.hands[p].includes(card)) return false;
  const top = st.top;
  if (st.stack > 0) {                                   // 공격을 받은 중: 막는 카드만
    if (!isAttack(card)) return false;
    if (isJoker(top)) return isJoker(card);
    return isJoker(card) || rankOf(card) === rankOf(top) || suitOf(card) === suitOf(top);
  }
  if (isJoker(card)) return true;
  if (st.suit === -1) return true;                      // 조커가 맨 위면 아무 카드나
  return suitOf(card) === st.suit || rankOf(card) === rankOf(top);
}
const legalPlays = (st, p) => (st.winner >= 0 || p !== st.turn || !st.alive[p] ? [] : st.hands[p].filter((c) => canPlay(st, p, c)));

// 카드가 모자라면 버린 더미를 (맨 위 한 장만 남기고) 섞어 새 더미로
function refill(st) {
  if (st.draw.length > 0 || st.discard.length <= 1) return;
  const keep = st.discard.pop();
  st.draw = shuffle(st.discard, st.rand);
  st.discard = [keep];
}
function takeCards(st, p, n) {
  const got = [];
  for (let i = 0; i < n; i++) {
    refill(st);
    if (!st.draw.length) break;
    const c = st.draw.pop();
    st.hands[p].push(c); got.push(c);
  }
  st.stats.draws[p] += got.length;
  return got;
}
// 손이 너무 많으면 파산: 카드는 더미 밑으로, 한 명만 남으면 그 사람이 이긴다
function checkBust(st, p) {
  if (!st.alive[p] || st.hands[p].length < LIMIT) return false;
  eliminate(st, p, 'bust');
  return true;
}
// p 를 판에서 뺀다 (파산·시간 초과·나감). 차례가 p 였으면 다음 사람에게 넘긴다
function eliminate(st, p, reason) {
  if (!st.alive[p] || st.winner >= 0) return false;
  const wasTurn = st.turn === p;
  st.draw = st.hands[p].concat(st.draw);                // 카드는 더미 맨 밑으로
  st.hands[p] = [];
  st.alive[p] = false;
  if (aliveCount(st) === 1) { st.winner = st.alive.indexOf(true); st.reason = reason === 'bust' ? 'bust' : 'last'; return true; }
  if (wasTurn) st.turn = stepFrom(st, p, 1);
  return true;
}

// 카드를 낸다. opts.suit: 7 을 낼 때 고른 모양(0~3), opts.one: 원카드를 불렀는가
// 돌려주는 값: { card, effect, skipped, reversed, penalty, suit } (안 되면 null)
function play(st, p, card, opts = {}) {
  if (!canPlay(st, p, card)) return null;
  const rank = rankOf(card);
  let suit = opts.suit;
  if (rank === 7) { if (!Number.isInteger(suit) || suit < 0 || suit > 3) suit = suitOf(card); }
  const hand = st.hands[p];
  hand.splice(hand.indexOf(card), 1);
  st.discard.push(card);
  st.top = card;
  st.suit = isJoker(card) ? -1 : rank === 7 ? suit : suitOf(card);
  st.stats.plays[p]++;
  const res = { card, effect: '', skipped: 0, reversed: false, penalty: 0, suit: st.suit };
  if (hand.length === 0) { st.winner = p; st.reason = 'empty'; return res; }
  let steps = 1;
  const a = attackOf(card);
  if (a) { st.stack += a; res.effect = 'attack'; }
  else if (rank === 11) { steps = 2; res.effect = 'skip'; res.skipped = 1; }
  else if (rank === 12) {
    if (aliveCount(st) === 2) { steps = 2; res.effect = 'skip'; res.skipped = 1; }
    else { st.dir = -st.dir; res.effect = 'reverse'; res.reversed = true; }
  } else if (rank === 13) { steps = 3; res.effect = 'skip2'; res.skipped = 2; }
  else if (rank === 7) res.effect = 'suit';
  if (hand.length === 1 && !opts.one) {                 // 원카드를 안 부르고 한 장이 남으면 벌칙
    res.penalty = takeCards(st, p, 2).length;
    checkBust(st, p);
    if (st.winner >= 0) return res;
  }
  st.turn = stepFrom(st, st.turn, steps);
  return res;
}

// 한 장 뽑고 (공격 중이면 쌓인 장수만큼) 차례를 넘긴다. 돌려주는 값: { n, cards } (안 되면 null)
function drawTurn(st, p) {
  if (st.winner >= 0 || p !== st.turn || !st.alive[p]) return null;
  const want = st.stack > 0 ? st.stack : 1;
  const cards = takeCards(st, p, want);
  st.stack = 0;
  checkBust(st, p);
  if (st.winner < 0 && st.alive[p]) st.turn = stepFrom(st, st.turn, 1);
  return { n: cards.length, cards, wanted: want };
}

const countSuit = (hand) => { const c = [0, 0, 0, 0]; for (const x of hand) if (!isJoker(x)) c[suitOf(x)]++; return c; };

// 아직 안 보인 카드(내 손패와 버린 더미 밖) 중에서, top 카드의 공격을 막을 수 있는 카드가 상대 손(n장)에 하나라도 있을 확률
function defendChance(st, p, top, nOpp) {
  const seen = new Set(st.hands[p].concat(st.discard));
  seen.add(top);
  let unseen = 0, k = 0;
  for (let c = 0; c < NUM_CARDS; c++) {
    if (seen.has(c)) continue;
    unseen++;
    if (!isAttack(c)) continue;
    if (isJoker(top) ? isJoker(c) : (isJoker(c) || rankOf(c) === rankOf(top) || suitOf(c) === suitOf(top))) k++;
  }
  if (!unseen || nOpp <= 0) return 0;
  if (k === 0) return 0;
  // 하나도 없을 확률 = C(unseen-k, n) / C(unseen, n)
  let none = 1;
  for (let i = 0; i < Math.min(nOpp, unseen); i++) none *= Math.max(0, (unseen - k - i)) / (unseen - i);
  return 1 - none;
}

// 이 카드(모양 suit, 숫자 rank 로 보임)를 낸 뒤 상대(n장)가 낼 카드가 하나도 없을 확률 (안 보인 카드 중 모양·숫자가 맞거나 조커인 것이 없을 확률)
function stuckChance(st, p, card, suit, nOpp) {
  const seen = new Set(st.hands[p].concat(st.discard));
  seen.add(card);
  const r = isJoker(card) ? -1 : rankOf(card);
  let unseen = 0, m = 0;
  for (let c = 0; c < NUM_CARDS; c++) {
    if (seen.has(c)) continue;
    unseen++;
    if (isJoker(c) || (suit >= 0 && suitOf(c) === suit) || (r > 0 && rankOf(c) === r)) m++;
  }
  if (!unseen || nOpp <= 0) return 0;
  let none = 1;
  for (let i = 0; i < Math.min(nOpp, unseen); i++) none *= Math.max(0, (unseen - m - i)) / (unseen - i);
  return none;
}

// 연속으로 낼 수 있는 카드 수 (J·Q·K 는 상대를 건너뛰어 내가 또 두게 된다. 2명일 때). 손패에서 낼 수 있는 가장 긴 줄을 찾는다
function dumpChain(hand, top, suit, memo = new Map()) {
  const key = hand.slice().sort((x, y) => x - y).join(',') + '|' + top + '|' + suit;
  if (memo.has(key)) return memo.get(key);
  let best = 0;
  for (const c of hand) {
    const ok = isJoker(c) || suit === -1 || suitOf(c) === suit || (top < 52 && rankOf(c) === rankOf(top));
    if (!ok || isAttack(c)) continue;                      // 공격 카드는 줄을 끝낸다(여기서는 따로 센다)
    const r = rankOf(c);
    if (r !== 11 && r !== 12 && r !== 13) continue;
    const rest = hand.filter((x) => x !== c);
    best = Math.max(best, 1 + dumpChain(rest, c, suitOf(c), memo));
  }
  memo.set(key, best);
  return best;
}

// 컴퓨터가 고르기. { type:'play', card, suit, one } 또는 { type:'draw' } (할 수 없으면 null)
// level: 'easy' 는 낼 수 있는 카드를 아무거나(원카드도 가끔 깜빡), 'hard' 는 연속으로 낼 줄을 계산해 카드를 빨리 비우고 공격·조커·7 은 때에 맞춰 쓴다,
//        'hard1' 은 예전 어려움(시험에서 비교하려고 남겨 둠)
const STUCK_W = 8;                                        // 상대를 막히게 만드는 값(한 장 뽑게 하는 것의 가치)
function aiPick(st, p, level, rand = st.rand) {
  if (st.winner >= 0 || p !== st.turn || !st.alive[p]) return null;
  const legal = legalPlays(st, p);
  if (!legal.length) return { type: 'draw' };
  const hand = st.hands[p];
  if (level !== 'hard' && level !== 'hard1') {
    const card = legal[Math.floor(rand() * legal.length)];
    const cnt = countSuit(hand.filter((c) => c !== card));
    return { type: 'play', card, suit: cnt.indexOf(Math.max(...cnt)), one: rand() > 0.25 };
  }
  const nextP = stepFrom(st, p, 1);
  const nextLow = st.hands[nextP].length <= 3;
  const defending = st.stack > 0;
  const cnt = countSuit(hand);
  let best = null, bs = -Infinity;
  for (const card of legal) {
    let s = rand() * 0.5;
    const r = rankOf(card);
    if (isAttack(card)) {
      if (defending) s += 6 - attackOf(card) * 0.2;      // 막을 땐 되도록 작은 공격으로 막는다
      else s += nextLow ? 6 : 2;
      if (isJoker(card) && !defending && hand.length > 3 && !nextLow) s -= 4;   // 조커는 아껴 둔다
    }
    if (r === 11 || r === 12 || r === 13) s += nextLow ? 4 : 1;
    if (r === 7) s -= hand.length > 4 ? 1.5 : 0;
    // 손에 많은 모양의 카드를 먼저 내서 다음에 낼 길을 넓힌다
    if (!isJoker(card)) s += cnt[suitOf(card)] * 0.3;
    if (hand.length <= 2) s += 3;                        // 마무리
    if (level === 'hard') {
      // 공격: 상대가 막을 수 있을 확률(안 보인 공격 카드가 상대 손에 있을 확률)을 보고 쓴다. 못 막으면 쌓인 장수만큼 뽑게 하고, 막히면 더 커져서 돌아온다
      if (isAttack(card) && !defending) {
        const pD = defendChance(st, p, card, st.hands[nextP].length);
        const total = st.stack + attackOf(card);
        s += total * ((1 - pD) * 0.9 - pD * 0.55) - (nextLow ? 0 : 2);   // 위의 기본 가산(+2/+6)을 확률에 맞춰 고친다
      }
      // 낸 뒤 상대가 낼 카드가 없을 확률이 높을수록 좋다 (상대가 한 장 뽑게 만든다). 7 은 상대가 가장 없을 만한 모양으로 고른다
      if (!isAttack(card) && !(r === 11 || r === 12 || r === 13)) {
        let sc = isJoker(card) ? -1 : suitOf(card);
        if (r === 7) {
          let bestV = -Infinity;
          const restH = hand.filter((c) => c !== card), c2 = countSuit(restH);
          for (let su = 0; su < 4; su++) { const v = stuckChance(st, p, card, su, st.hands[nextP].length) * STUCK_W + c2[su] * 0.4; if (v > bestV) { bestV = v; sc = su; } }
        }
        s += stuckChance(st, p, card, sc, st.hands[nextP].length) * STUCK_W;
      }
      // 연속으로 낼 수 있는 줄이 길수록 좋다: 이 카드를 내고 J·Q·K 로 이어서 몇 장을 더 털 수 있는가
      const rest = hand.filter((c) => c !== card);
      const suitAfter = isJoker(card) ? -1 : r === 7 ? (() => { const c2 = countSuit(rest); return c2.indexOf(Math.max(...c2)); })() : suitOf(card);
      const skipper = r === 11 || r === 12 || r === 13;
      const chain = skipper ? 1 + dumpChain(rest, card, suitAfter) : 0;
      s += chain * 2.2;
      if (chain >= rest.length + 1) s += 50;             // 이 줄로 손패를 다 비운다
      // 한 장만 남기는 수는 상대가 막기 어렵게(공격으로 마무리)하면 더 좋다
      if (rest.length === 1 && isAttack(rest[0])) s += 2;
    }
    if (s > bs) { bs = s; best = card; }
  }
  const rest = countSuit(hand.filter((c) => c !== best));
  let suitPick = rest.indexOf(Math.max(...rest));
  if (level === 'hard' && rankOf(best) === 7 && !isJoker(best)) {
    let bestV = -Infinity;
    for (let su = 0; su < 4; su++) { const v = stuckChance(st, p, best, su, st.hands[nextP].length) * STUCK_W + rest[su] * 0.4; if (v > bestV) { bestV = v; suitPick = su; } }
  }
  return { type: 'play', card: best, suit: suitPick, one: true };
}

return { SUITS, NUM_CARDS, LIMIT, dumpChain, suitOf, rankOf, isJoker, isRed, attackOf, isAttack, nameOf, rng, newGame, aliveCount, stepFrom, canPlay, legalPlays, play, drawTurn, eliminate, aiPick };
})();
if (typeof module !== 'undefined') module.exports = LOGIC_ONECARD;
