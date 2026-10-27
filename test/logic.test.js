'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/logic.js');

// 카드 번호: 모양*13 + (숫자-1). ♠ 0 · ♥ 1 · ◆ 2 · ♣ 3
const C = (suit, rank) => suit * 13 + rank - 1;
const SP = 0, HE = 1, DI = 2, CL = 3, JB = 52, JC = 53;

// 손패와 맨 위 카드를 정해 놓고 시작하는 판
function make(n, hands, top, over = {}) {
  const st = L.newGame({ players: n, seed: 1 });
  const used = new Set([top, ...hands.flat()]);
  st.hands = Array.from({ length: n }, (_, i) => (hands[i] || []).slice());
  st.draw = Array.from({ length: 54 }, (_, i) => i).filter((c) => !used.has(c));
  st.discard = [top]; st.top = top; st.suit = L.suitOf(top); st.stack = 0; st.turn = 0; st.dir = 1;
  st.alive = new Array(n).fill(true); st.winner = -1;
  return Object.assign(st, over);
}
const total = (st) => st.hands.flat().length + st.draw.length + st.discard.length;

test('card numbers map to suits ranks and attack values', () => {
  assert.strictEqual(L.suitOf(C(HE, 7)), HE);
  assert.strictEqual(L.rankOf(C(HE, 7)), 7);
  assert.strictEqual(L.rankOf(C(SP, 1)), 1);
  assert.strictEqual(L.suitOf(JB), -1);
  assert.deepStrictEqual([C(SP, 2), C(HE, 1), C(SP, 1), JB, JC, C(DI, 5), C(CL, 11)].map(L.attackOf), [2, 3, 5, 5, 7, 0, 0]);
  assert.ok(L.isRed(C(HE, 4)) && L.isRed(C(DI, 4)) && !L.isRed(C(SP, 4)) && !L.isRed(JB));
  assert.strictEqual(L.nameOf(C(SP, 1)), '♠A');
  assert.strictEqual(L.nameOf(C(HE, 12)), '♥Q');
  assert.strictEqual(L.nameOf(JC), '컬러 조커');
});

test('new game deals 7 cards to two players and 5 to three or four, with a plain start card', () => {
  for (const [n, per] of [[2, 7], [3, 5], [4, 5]]) {
    for (let seed = 1; seed <= 60; seed++) {
      const st = L.newGame({ players: n, seed });
      assert.ok(st.hands.every((h) => h.length === per));
      assert.strictEqual(total(st), 54);
      assert.strictEqual(new Set([...st.hands.flat(), ...st.draw, ...st.discard]).size, 54, 'every card exactly once');
      assert.ok([3, 4, 5, 6, 8, 9, 10].includes(L.rankOf(st.top)), 'start card is plain');
      assert.strictEqual(st.suit, L.suitOf(st.top));
    }
  }
});

test('same seed gives the same deal and players are clamped to 2 to 4', () => {
  assert.deepStrictEqual(L.newGame({ players: 3, seed: 9 }).hands, L.newGame({ players: 3, seed: 9 }).hands);
  assert.notDeepStrictEqual(L.newGame({ players: 3, seed: 9 }).hands, L.newGame({ players: 3, seed: 10 }).hands);
  assert.strictEqual(L.newGame({ players: 9, seed: 1 }).n, 4);
  assert.strictEqual(L.newGame({ players: 1, seed: 1 }).n, 2);
});

test('a card can be played on the same suit or the same rank, jokers any time', () => {
  const st = make(2, [[C(HE, 9), C(HE, 4), C(SP, 4), C(CL, 9), C(SP, 6), JB]], C(HE, 4));
  assert.ok(L.canPlay(st, 0, C(HE, 9)), 'same suit');
  assert.ok(L.canPlay(st, 0, C(SP, 4)), 'same rank');
  assert.ok(!L.canPlay(st, 0, C(CL, 9)), 'nothing in common');
  assert.ok(!L.canPlay(st, 0, C(SP, 6)));
  assert.ok(L.canPlay(st, 0, JB), 'joker always');
  assert.ok(!L.canPlay(st, 1, C(HE, 9)), 'not your turn');
  assert.ok(!L.canPlay(st, 0, C(DI, 3)), 'not in hand');
});

test('after a joker any card can be played', () => {
  const st = make(2, [[C(CL, 9), C(SP, 6)]], C(HE, 4));
  L.play(st, 0, C(CL, 9));                                           // 당연히 안 됨 (모양·숫자 다름)
  assert.strictEqual(st.top, C(HE, 4));
  const st2 = make(2, [[JB, C(CL, 9)], [C(SP, 6), C(DI, 8)]], C(HE, 4));
  L.play(st2, 0, JB, { one: true });
  assert.strictEqual(st2.suit, -1);
  L.drawTurn(st2, 1);                                                // 공격을 받아 5장 뽑는다
  assert.strictEqual(st2.stack, 0);
  assert.strictEqual(st2.turn, 0);
  assert.ok(L.canPlay(st2, 0, C(CL, 9)), 'free play on a joker');
});

test('playing a card moves it to the discard pile and sets the new top and suit', () => {
  const st = make(3, [[C(HE, 9), C(SP, 2), C(DI, 6)], [C(SP, 3)], [C(CL, 3)]], C(HE, 4));
  const before = total(st);
  const r = L.play(st, 0, C(HE, 9), { one: true });
  assert.strictEqual(r.effect, '');
  assert.strictEqual(st.top, C(HE, 9));
  assert.strictEqual(st.suit, HE);
  assert.deepStrictEqual(st.hands[0], [C(SP, 2), C(DI, 6)]);
  assert.strictEqual(st.discard[st.discard.length - 1], C(HE, 9));
  assert.strictEqual(st.turn, 1);
  assert.strictEqual(total(st), before);
  assert.strictEqual(L.play(st, 0, C(SP, 2)), null, 'not your turn any more');
});

test('attack cards stack and the next player must defend or draw', () => {
  const st = make(3, [[C(HE, 2), C(SP, 5)], [C(DI, 2), C(HE, 9), C(SP, 1), JC], [C(CL, 5), C(CL, 6)]], C(HE, 4));
  const r = L.play(st, 0, C(HE, 2), { one: true });
  assert.strictEqual(r.effect, 'attack');
  assert.strictEqual(st.stack, 2);
  assert.strictEqual(st.turn, 1);
  assert.ok(L.canPlay(st, 1, C(DI, 2)), 'same rank defends');
  assert.ok(L.canPlay(st, 1, JC), 'joker defends');
  assert.ok(!L.canPlay(st, 1, C(SP, 1)), 'an ace of another suit is not enough');
  assert.ok(!L.canPlay(st, 1, C(HE, 9)), 'a plain card of the same suit cannot defend');
  L.play(st, 1, C(DI, 2), { one: true });
  assert.strictEqual(st.stack, 4);
  assert.strictEqual(st.turn, 2);
  const hand = st.hands[2].length;
  const d = L.drawTurn(st, 2);
  assert.strictEqual(d.n, 4);
  assert.strictEqual(st.hands[2].length, hand + 4);
  assert.strictEqual(st.stack, 0);
  assert.strictEqual(st.turn, 0);
});

test('same suit attack cards can defend each other (heart 2 is answered by heart A)', () => {
  const st = make(2, [[C(HE, 2), C(SP, 5)], [C(HE, 1), C(CL, 5)]], C(HE, 4));
  L.play(st, 0, C(HE, 2), { one: true });
  assert.ok(L.canPlay(st, 1, C(HE, 1)));
  L.play(st, 1, C(HE, 1), { one: true });
  assert.strictEqual(st.stack, 5);
});

test('jokers can only be answered by jokers and spade A hits for five', () => {
  const st = make(2, [[JB, C(SP, 5)], [JC, C(SP, 1), C(HE, 2)]], C(HE, 4));
  L.play(st, 0, JB, { one: true });
  assert.strictEqual(st.stack, 5);
  assert.ok(L.canPlay(st, 1, JC));
  assert.ok(!L.canPlay(st, 1, C(SP, 1)));
  assert.ok(!L.canPlay(st, 1, C(HE, 2)));
  L.play(st, 1, JC, { one: true });
  assert.strictEqual(st.stack, 12);
  const st2 = make(2, [[C(SP, 1), C(SP, 5)], [C(CL, 6)]], C(SP, 4));
  L.play(st2, 0, C(SP, 1), { one: true });
  assert.strictEqual(st2.stack, 5);
});

test('J skips one player, K skips two, Q reverses', () => {
  const mk = () => make(4, [[C(HE, 11), C(HE, 13), C(HE, 12), C(HE, 5)], [C(SP, 3)], [C(SP, 3)], [C(SP, 3)]], C(HE, 4));
  let st = mk();
  assert.strictEqual(L.play(st, 0, C(HE, 11), { one: true }).skipped, 1);
  assert.strictEqual(st.turn, 2);
  st = mk();
  assert.strictEqual(L.play(st, 0, C(HE, 13), { one: true }).skipped, 2);
  assert.strictEqual(st.turn, 3);
  st = mk();
  assert.ok(L.play(st, 0, C(HE, 12), { one: true }).reversed);
  assert.strictEqual(st.dir, -1);
  assert.strictEqual(st.turn, 3, 'the turn goes the other way');
});

test('in a two player game J and Q skip the other player and K skips both of you', () => {
  for (const rank of [11, 12]) {
    const st = make(2, [[C(HE, rank), C(HE, 5)], [C(SP, 3)]], C(HE, 4));
    L.play(st, 0, C(HE, rank), { one: true });
    assert.strictEqual(st.turn, 0, 'rank ' + rank);
  }
  const st = make(2, [[C(HE, 13), C(HE, 5)], [C(SP, 3)]], C(HE, 4));
  L.play(st, 0, C(HE, 13), { one: true });
  assert.strictEqual(st.turn, 1, 'K skips both of you so it is the other player again');
});

test('a seven lets you pick the next suit and a seven can follow a seven', () => {
  const st = make(3, [[C(HE, 7), C(SP, 5)], [C(CL, 9), C(DI, 7)], [C(SP, 3)]], C(HE, 4));
  const r = L.play(st, 0, C(HE, 7), { suit: CL, one: true });
  assert.strictEqual(r.effect, 'suit');
  assert.strictEqual(st.suit, CL);
  assert.ok(L.canPlay(st, 1, C(CL, 9)));
  assert.ok(L.canPlay(st, 1, C(DI, 7)), 'a seven matches the seven by rank');
  const st2 = make(2, [[C(HE, 7), C(SP, 5)], [C(SP, 3)]], C(HE, 4));
  L.play(st2, 0, C(HE, 7), { one: true });                           // 모양을 안 고르면 자기 모양 그대로
  assert.strictEqual(st2.suit, HE);
  const st3 = make(2, [[C(HE, 7), C(SP, 5)], [C(SP, 3)]], C(HE, 4));
  L.play(st3, 0, C(HE, 7), { suit: 9, one: true });                  // 엉뚱한 값도 자기 모양으로
  assert.strictEqual(st3.suit, HE);
});

test('playing the last card wins at once', () => {
  const st = make(3, [[C(HE, 9)], [C(SP, 3)], [C(SP, 4)]], C(HE, 4));
  const r = L.play(st, 0, C(HE, 9));
  assert.ok(r);
  assert.strictEqual(st.winner, 0);
  assert.strictEqual(st.reason, 'empty');
  assert.strictEqual(L.play(st, 1, C(SP, 3)), null);
  assert.strictEqual(L.drawTurn(st, 1), null);
});

test('leaving one card without calling one card costs two cards', () => {
  const st = make(2, [[C(HE, 9), C(SP, 5)], [C(SP, 3)]], C(HE, 4));
  const r = L.play(st, 0, C(HE, 9), { one: false });
  assert.strictEqual(r.penalty, 2);
  assert.strictEqual(st.hands[0].length, 3);
  assert.strictEqual(st.turn, 1);
  const ok = make(2, [[C(HE, 9), C(SP, 5)], [C(SP, 3)]], C(HE, 4));
  assert.strictEqual(L.play(ok, 0, C(HE, 9), { one: true }).penalty, 0);
  assert.strictEqual(ok.hands[0].length, 1);
  const many = make(2, [[C(HE, 9), C(SP, 5), C(SP, 6)], [C(SP, 3)]], C(HE, 4));
  assert.strictEqual(L.play(many, 0, C(HE, 9)).penalty, 0, 'no call needed with more cards left');
});

test('drawing takes one card and passes the turn', () => {
  const st = make(3, [[C(SP, 5)], [C(SP, 3)], [C(SP, 4)]], C(HE, 4));
  const d = L.drawTurn(st, 0);
  assert.strictEqual(d.n, 1);
  assert.strictEqual(st.hands[0].length, 2);
  assert.strictEqual(st.turn, 1);
  assert.strictEqual(L.drawTurn(st, 0), null, 'not your turn');
  assert.strictEqual(total(st), 54);
});

test('an empty draw pile is refilled from the discard pile keeping the top card', () => {
  const st = make(2, [[C(SP, 5)], [C(SP, 3)]], C(HE, 4));
  st.discard = [C(CL, 1), C(CL, 2), C(CL, 3), C(HE, 4)];
  st.draw = [];
  const d = L.drawTurn(st, 0);
  assert.strictEqual(d.n, 1);
  assert.strictEqual(st.discard.length, 1);
  assert.strictEqual(st.discard[0], C(HE, 4));
  assert.strictEqual(st.draw.length, 2);
  assert.ok([C(CL, 1), C(CL, 2), C(CL, 3)].includes(st.hands[0][1]));
});

test('with no cards to take, a draw takes nothing and still passes', () => {
  const st = make(2, [[C(SP, 5)], [C(SP, 3)]], C(HE, 4));
  st.draw = []; st.discard = [C(HE, 4)];
  const d = L.drawTurn(st, 0);
  assert.strictEqual(d.n, 0);
  assert.strictEqual(st.turn, 1);
});

test('twenty cards in hand is a bust: the player drops out and the cards go to the bottom', () => {
  const big = Array.from({ length: 19 }, (_, i) => C(i % 4, 3 + Math.floor(i / 4)));
  const st = make(3, [big, [C(CL, 13)], [C(CL, 12)]], C(HE, 8));
  const drawLen = st.draw.length;
  L.drawTurn(st, 0);
  assert.ok(!st.alive[0]);
  assert.strictEqual(st.hands[0].length, 0);
  assert.strictEqual(st.draw.length, drawLen + 19, 'the bust hand went under the pile (one card was drawn first)');
  assert.strictEqual(st.winner, -1);
  assert.strictEqual(st.turn, 1);
  assert.strictEqual(total(st), 54);
  const two = make(2, [big, [C(CL, 13)]], C(HE, 8));
  L.drawTurn(two, 0);
  assert.strictEqual(two.winner, 1);
  assert.strictEqual(two.reason, 'bust');
});

test('a big attack can bust the one who has to take it', () => {
  const hand = Array.from({ length: 15 }, (_, i) => C(i % 4, 3 + Math.floor(i / 4)));
  const st = make(2, [[JC, C(HE, 9)], hand], C(HE, 4));
  L.play(st, 0, JC, { one: true });
  assert.strictEqual(st.stack, 7);
  L.drawTurn(st, 1);                                                 // 15 + 7 = 22
  assert.strictEqual(st.winner, 0);
  assert.strictEqual(st.reason, 'bust');
});

test('eliminate passes the turn on and the last player standing wins', () => {
  const st = make(3, [[C(SP, 5)], [C(SP, 3)], [C(SP, 4)]], C(HE, 4));
  assert.ok(L.eliminate(st, 0, 'left'));
  assert.strictEqual(st.turn, 1);
  assert.deepStrictEqual(st.alive, [false, true, true]);
  assert.strictEqual(st.winner, -1);
  assert.ok(L.eliminate(st, 2, 'left'));
  assert.strictEqual(st.winner, 1);
  assert.strictEqual(st.reason, 'last');
  assert.strictEqual(L.eliminate(st, 1, 'left'), false);
  assert.strictEqual(total(st), 54);
});

test('turn order skips players who dropped out', () => {
  const st = make(4, [[C(HE, 5), C(SP, 5)], [C(SP, 3)], [C(SP, 3)], [C(SP, 3)]], C(HE, 4));
  L.eliminate(st, 1, 'left');
  assert.ok(L.play(st, 0, C(HE, 5), { one: true }));
  assert.strictEqual(st.turn, 2);
  assert.strictEqual(L.stepFrom(st, 3, 1), 0);
  assert.strictEqual(L.stepFrom(st, 0, 3), 0, 'three alive players, three steps is back to you');
});

test('ai plays only legal cards and draws when it cannot play', () => {
  for (const level of ['easy', 'hard']) {
    for (let seed = 1; seed <= 80; seed++) {
      const st = L.newGame({ players: 2 + (seed % 3), seed });
      const a = L.aiPick(st, st.turn, level, Math.random);
      if (a.type === 'play') assert.ok(L.canPlay(st, st.turn, a.card), level + seed);
      else assert.strictEqual(L.legalPlays(st, st.turn).length, 0);
      assert.strictEqual(L.aiPick(st, (st.turn + 1) % st.n, level), null, 'only the player on turn');
    }
  }
});

test('hard ai defends an attack when it can instead of taking the cards', () => {
  const st = make(2, [[C(HE, 2), C(SP, 5)], [C(DI, 2), C(CL, 6), C(CL, 8), C(CL, 9)]], C(HE, 4));
  L.play(st, 0, C(HE, 2), { one: true });
  const a = L.aiPick(st, 1, 'hard', Math.random);
  assert.deepStrictEqual([a.type, a.card], ['play', C(DI, 2)]);
});

test('hard ai keeps the card count honest and picks the suit it holds most after a seven', () => {
  const st = make(2, [[C(HE, 7), C(CL, 3), C(CL, 5), C(CL, 8), C(HE, 9), C(HE, 12)], [C(SP, 3), C(SP, 4)]], C(HE, 4));
  st.turn = 0;
  const a = L.aiPick(st, 0, 'hard', () => 0.5);
  if (a.card === C(HE, 7)) assert.strictEqual(a.suit, CL, 'clubs are the most common suit left in the hand');
  assert.ok(L.canPlay(st, 0, a.card));
});

// 컴퓨터끼리 끝까지 두어 보기: 끝나지 않거나 카드가 새면 여기서 걸린다
for (const level of ['easy', 'hard']) {
  test('full games with 2 3 and 4 players always end with a winner and no lost cards (' + level + ')', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const n = 2 + (seed % 3);
      const st = L.newGame({ players: n, seed });
      let g = 0;
      while (st.winner < 0) {
        assert.ok(++g < 4000, `stuck: seed ${seed}`);
        const a = L.aiPick(st, st.turn, level);
        if (a.type === 'draw') assert.ok(L.drawTurn(st, st.turn));
        else assert.ok(L.play(st, st.turn, a.card, { suit: a.suit, one: a.one }), `bad play seed ${seed}`);
        assert.strictEqual(total(st), 54, `cards lost seed ${seed}`);
        assert.ok(st.alive[st.turn] || st.winner >= 0, 'turn on an eliminated player');
        for (let p = 0; p < n; p++) assert.ok(st.hands[p].length < L.LIMIT || !st.alive[p]);
      }
      assert.ok(st.winner >= 0 && st.winner < n);
      if (st.reason === 'empty') assert.strictEqual(st.hands[st.winner].length, 0);
    }
  });
}

test('hard ai beats easy ai most of the time in two player games', () => {
  let hard = 0;
  const games = 500;
  for (let s = 1; s <= games; s++) {
    const st = L.newGame({ seed: s, players: 2, first: s % 2 });
    const level = ['hard', 'easy'];                                  // 0 번이 어려움, 1 번이 쉬움 (먼저 하는 쪽은 번갈아)
    let g = 0;
    while (st.winner < 0 && g++ < 4000) {
      const a = L.aiPick(st, st.turn, level[st.turn]);
      if (a.type === 'draw') L.drawTurn(st, st.turn); else L.play(st, st.turn, a.card, { suit: a.suit, one: a.one });
    }
    if (st.winner === 0) hard++;
  }
  assert.ok(hard / games > 0.6, 'hard won ' + hard + ' of ' + games);
});

test('dumpChain counts how many J, Q, K can be played in a row (each skips the opponent in a two player game)', () => {
  assert.strictEqual(L.dumpChain([C(HE, 11), C(HE, 12), C(HE, 13), C(CL, 5)], C(HE, 4), HE), 3, 'J, Q, K of hearts in a row');
  assert.strictEqual(L.dumpChain([C(HE, 11), C(HE, 12), C(SP, 13), C(CL, 5)], C(HE, 4), HE), 2, 'the K of spades does not follow a heart Q');
  assert.strictEqual(L.dumpChain([C(SP, 13), C(CL, 5)], C(HE, 4), HE), 0, 'a K that cannot be played at all');
  assert.strictEqual(L.dumpChain([C(SP, 11), C(HE, 11), C(SP, 12)], C(HE, 4), HE), 3, 'J of hearts, then J of spades by rank, then Q of spades by suit');
});

test('the new hard ai beats the old hard ai and easy ai over many seeded games', () => {
  const play = (a, b, games) => {
    let w = 0;
    for (let s = 1; s <= games; s++) {
      const seat = s % 2;
      const st = L.newGame({ seed: 7000 + s, players: 2, first: s % 2 });
      let g = 0;
      while (st.winner < 0 && g++ < 4000) {
        const lv = st.turn === seat ? a : b;
        const act = L.aiPick(st, st.turn, lv);
        if (act.type === 'draw') L.drawTurn(st, st.turn); else L.play(st, st.turn, act.card, { suit: act.suit, one: act.one });
      }
      if (st.winner === seat) w++;
    }
    return w / games;
  };
  const vsOld = play('hard', 'hard1', 4000);
  const vsEasy = play('hard', 'easy', 2000);
  assert.ok(vsOld > 0.52, 'new hard vs old hard ' + vsOld);
  assert.ok(vsEasy > 0.62, 'new hard vs easy ' + vsEasy);
});
