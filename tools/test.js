'use strict';
// 決まりの自己チェック: node tools/test.js
const assert = require('node:assert/strict');
const M = require('../js/model.js');
const { run } = require('./sim.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const sun = { x: 0.5, y: 0.4, r: M.CONFIG.sunR };
const cloud = (x, y, w = 1, rain = false) => ({ x, y, w, rain, held: false });

test('雲なしで T = 1', () => near(M.transmit(sun, []), 1));
test('雲 1 枚が丸ごと重なると T = 0.3', () => near(M.transmit(sun, [cloud(0.5, 0.4)]), 0.3));
test('雲 2 枚で T = 0.09', () => near(M.transmit(sun, [cloud(0.5, 0.4), cloud(0.5, 0.4)]), 0.09));
test('雨を降らせている雲はもっと削る', () => near(M.transmit(sun, [cloud(0.5, 0.4, 1, true)]), 0.15));
test('縁ではなめらかに変わる', () => {
  let prev = 0.3;
  for (let dx = 0; dx <= 0.3; dx += 0.005) {
    const t = M.transmit(sun, [cloud(0.5 + dx, 0.4)]);
    assert.ok(t >= prev - 1e-12 && t - prev < 0.08, `dx=${dx.toFixed(3)} で段になる`);
    prev = t;
  }
  near(prev, 1);
});

test('太陽: 朝は左の地平、昼に真上、夕に右の地平、夜は無し', () => {
  const a = M.sunAt(0), b = M.sunAt(0.5), c = M.sunAt(1);
  near(a.x, 0.08); near(a.y, 0.95); near(b.x, 0.5); near(b.y, 0.2); near(c.x, 0.92, 1e-9);
  assert.equal(M.sunAt(-1), null);
  assert.equal(M.sunStrength(-1), 0);
  near(M.sunStrength(0.5), 1);
});

test('雨を降らせると雲の水が減って小さくなり、0.5 秒遅れて土がしめる', () => {
  const s = M.create('tomato', 1);
  const c = s.clouds[0];
  M.moveCloud(s, 0, 0.5, 0.85);
  c.held = true; c.rain = true;
  const rx0 = M.cloudRx(c), m0 = s.M;
  for (let i = 0; i < 29; i++) M.step(s);
  assert.ok(s.M < m0, 'まだ届いていない（乾くだけ）');
  for (let i = 0; i < 60; i++) M.step(s);
  assert.ok(s.M > m0, '届いた');
  assert.ok(c.w < 1 && M.cloudRx(c) < rx0, '雲が縮む');
  c.rain = false;
  const w = c.w;
  M.step(s);
  assert.ok(c.w > w, '降らせていない間は戻る');
});

test('雲の水が 0 になると降らない', () => {
  const s = M.create('tomato', 1);
  const c = s.clouds[0];
  M.moveCloud(s, 0, 0.5, 0.85);
  c.held = true; c.rain = true; c.w = 0;
  assert.equal(M.raining(c), false);
  for (let i = 0; i < 120; i++) M.step(s);
  assert.equal(s.rainQ.reduce((a, b) => a + b, 0), 0);
});

test('雨は植物にかかったぶんだけ', () => {
  near(M.rainCover(cloud(0.5, 0.5)), 1);
  assert.equal(M.rainCover(cloud(0.9, 0.5)), 0);
  const half = M.rainCover(cloud(0.5 + M.CONFIG.cloudRx, 0.5));
  near(half, 0.5, 1e-9);
});

test('合い具合: 帯の中 1、外は fall で 0', () => {
  near(M.fit(0.5, 0.5, 0.2, 0.2), 1);
  near(M.fit(0.6, 0.5, 0.2, 0.2), 1);
  near(M.fit(0.7, 0.5, 0.2, 0.2), 0.5);
  near(M.fit(0.9, 0.5, 0.2, 0.2), 0);
});

test('時計: 朝から始まり、朝・昼・夕・夜の順で 1 日がめぐる', () => {
  const s = M.create('tomato', 1);
  assert.equal(M.clock(s).phase, 0);
  const seen = [];
  while (s.t < 40 && !s.over) { s.H = 1; M.step(s); for (const e of s.events) if (e.type === 'phase') seen.push(e.phase); }
  assert.deepEqual(seen, [1, 2, 3, 0]);
});

test('何もしないと枯れる', () => {
  const s = M.create('tomato', 1);
  while (!s.over) M.step(s);
  assert.equal(s.over, 'dead');
  assert.ok(s.P < 25);
});

test('上手に打つとクリアし、段階ごとのタイムが 4 つ残る', () => {
  const r = run('tomato', 'greedy', 1);
  assert.equal(r.over, 'clear');
  assert.ok(r.t > 60 && r.t < 90, `${r.t}`);
  assert.equal(r.splits.length, 4);
  assert.equal(r.splits[3], r.t);
});

test('固定刻みで同じ種なら同じ結果になる', () => {
  for (const plant of ['strawberry', 'cactus']) {
    const a = run(plant, 'human', 7), b = run(plant, 'human', 7);
    assert.deepEqual(a, b);
  }
  const c = run('cactus', 'human', 8);
  assert.notDeepEqual(run('cactus', 'human', 7), c, '種を変えると変わる');
});

test('風: つかんでいない雲だけ流れ、端から出ると反対から入る', () => {
  const s = M.create('cactus', 3);
  s.clouds[0].held = true;
  const x0 = s.clouds[0].x, x1 = s.clouds[1].x;
  for (let i = 0; i < 60 * 60; i++) { M.step(s); if (s.over) break; }
  assert.equal(s.clouds[0].x, x0);
  assert.notEqual(s.clouds[1].x, x1);
  for (const c of s.clouds) assert.ok(c.x >= -M.cloudRx(c) - 1e-9 && c.x <= 1 + M.cloudRx(c) + 1e-9);
});

test('★: 目安の 1.15 倍以内で 3、1.5 倍以内で 2', () => {
  const par = M.PAR.tomato;
  assert.equal(M.stars('tomato', par), 3);
  assert.equal(M.stars('tomato', par * 1.3), 2);
  assert.equal(M.stars('tomato', par * 2), 1);
});

console.log(`\n${n} 件すべて通った`);
