'use strict';
// 釣り合いの測定: いろいろな打ち方（ボット）で植物を育てさせ、クリア率・タイム・枯れた率を表にする。
//   node tools/sim.js                                   全部（植物 3 × ボット 7 × 200 回）と合格の目安
//   node tools/sim.js --plant tomato --bot greedy --runs 200
//
// ボットは人と同じ操作しかしない: 雲をつかんで（指は greedy 2 本・human 1 本）速さの上限つきで動かし、
// 雨は動かさずに 0.25 秒押してから降る。
const M = require('../js/model.js');
const { CONFIG } = M;
const dt = CONFIG.dt;
const HOLD = 0.25;

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---- 指（雲をつかんで動かす） ----
function makeHands(n, speed, switchDelay) {
  return Array.from({ length: n }, () => ({ ci: -1, tx: 0, ty: 0, wantRain: false, raining: false, still: 0, busy: 0, speed, switchDelay }));
}
function assign(h, ci) {
  if (h.ci === ci) return;
  h.ci = ci; h.raining = false; h.still = 0; h.busy = ci >= 0 ? h.switchDelay : 0;
}
function moveHands(s, hands) {
  for (const c of s.clouds) { c.held = false; c.rain = false; }
  for (const h of hands) {
    if (h.ci < 0) continue;
    if (h.busy > 0) { h.busy -= dt; continue; }
    const c = s.clouds[h.ci];
    c.held = true;
    if (!h.wantRain) h.raining = false;
    if (h.wantRain && !h.raining) {
      h.still += dt;               // 動かさずに押し続ける
      if (h.still >= HOLD) h.raining = true;
    } else {
      const d = dist(c.x, c.y, h.tx, h.ty), m = h.speed * dt;
      if (d <= m) M.moveCloud(s, h.ci, h.tx, h.ty);
      else M.moveCloud(s, h.ci, c.x + ((h.tx - c.x) * m) / d, c.y + ((h.ty - c.y) * m) / d);
    }
    c.rain = h.raining;
  }
}

// ---- 上手な打ち方（greedy と、その変わり種） ----
// 帯の見方: 'all' ふつう / 'noTime' いつも昼の帯 / 'noStage' いつも芽の帯
function bandView(s, view) {
  const clk = M.clock(s);
  if (view === 'noTime') return M.bandFor(s.plant, s.stage, 1);
  if (view === 'noStage') return M.bandFor(s.plant, 0, clk.phase);
  return s.band;
}

// 雲 ci を太陽から横に dx ずらしたときの通り具合（ほかの shade 雲も入れて）
function tAt(s, sun, ci, x, y, others) {
  const c = { ...s.clouds[ci], x, y, rain: false };
  return M.transmit(sun, [c, ...others.map((j) => s.clouds[j])]);
}
// 通り具合が target になる横のずらし幅を二分探索（ずらすほど T は増える）
function offsetFor(s, sun, ci, target, others, side) {
  const x0 = sun.x, far = M.cloudRx(s.clouds[ci]) + sun.r + 0.02;
  if (tAt(s, sun, ci, x0, sun.y, others) >= target) return 0;
  let lo = 0, hi = far;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (tAt(s, sun, ci, x0 + side * mid, sun.y, others) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// 太陽の近くにいるか（どけないと日差しを削る・削りそう）
function nearSun(c, sun) {
  if (!sun) return false;
  const dx = (c.x - sun.x) / (M.cloudRx(c) + sun.r + 0.06), dy = (c.y - sun.y) / (M.cloudRy(c) + sun.r + 0.06);
  return dx * dx + dy * dy < 1;
}

const PARK = [[0.08, 0.14], [0.92, 0.14], [0.08, 0.8], [0.92, 0.8], [0.5, 0.14]];

function planGreedy(s, mem, view) {
  const p = CONFIG.plants[s.plant];
  const band = bandView(s, view);
  const clk = M.clock(s);
  const sun = M.sunAt(clk.u);
  const n = s.clouds.length;
  const pending = s.rainQ.reduce((a, b) => a + b, 0) * dt;
  const Mp = s.M + pending;
  const mlo = band.m - p.bandM / 2;
  if (Mp < mlo + 0.3 * p.bandM) mem.water = true;
  if (Mp >= band.m) mem.water = false;

  const tasks = [];   // { ci, tx, ty, rain, pri }
  const used = new Set();

  // ① 水: 日かげに使っていない雲のうち水の多いもの
  if (mem.water) {
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (n > 1 && mem.shade && mem.shade[0] === i) continue;
      if (s.clouds[i].w < 0.05) continue;
      if (best < 0 || s.clouds[i].w > s.clouds[best].w) best = i;
    }
    if (best >= 0) {
      used.add(best);
      tasks.push({ ci: best, tx: 0.5, ty: 0.85, rain: dist(s.clouds[best].x, s.clouds[best].y, 0.5, 0.85) < 0.03 || s.clouds[best].rain, pri: 3 });
    } else mem.water = false;
  }

  // ② 日差し: 帯の中心より強いときだけ太陽の前へ
  const shade = [];
  if (sun) {
    const target = band.l / Math.max(1e-6, s.S);
    if (target < 1) {
      const free = [];
      for (let i = 0; i < n; i++) if (!used.has(i)) free.push(i);
      // 今 shade の雲を先に、次に太陽に近い雲
      free.sort((a, b) => {
        const pa = mem.shade && mem.shade.includes(a) ? 0 : 1, pb = mem.shade && mem.shade.includes(b) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return dist(s.clouds[a].x, s.clouds[a].y, sun.x, sun.y) - dist(s.clouds[b].x, s.clouds[b].y, sun.x, sun.y);
      });
      const side = sun.x < 0.5 ? 1 : -1;
      if (free.length) {
        const a = free[0];
        const t0 = tAt(s, sun, a, sun.x, sun.y, []);
        if (t0 > target + 0.02 && free.length > 1) {
          // 1 枚では足りない: a を太陽に重ね、b をずらして合わせる
          const b = free[1];
          shade.push(a, b);
          tasks.push({ ci: a, tx: sun.x, ty: sun.y, rain: false, pri: 2 });
          tasks.push({ ci: b, tx: sun.x + side * offsetFor2(s, sun, b, a, target, side), ty: sun.y, rain: false, pri: 2 });
        } else {
          const dx = offsetFor(s, sun, a, target, [], side);
          shade.push(a);
          tasks.push({ ci: a, tx: sun.x + side * dx, ty: sun.y, rain: false, pri: 2 });
        }
      }
    }
  }
  mem.shade = shade;
  for (const i of shade) used.add(i);

  // ③ 残りは太陽から遠い所へ。太陽にかかりそうな雲は急いでどける
  const spots = sun ? PARK.slice().sort((a, b) => dist(b[0], b[1], sun.x, sun.y) - dist(a[0], a[1], sun.x, sun.y)) : PARK;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const c = s.clouds[i];
    const [tx, ty] = spots[k++ % spots.length];
    if (nearSun(c, sun)) tasks.push({ ci: i, tx, ty, rain: false, pri: 4 });
    else if (!p.wind && dist(c.x, c.y, tx, ty) > 0.02 && sun && tAt(s, sun, i, c.x, c.y, []) < 0.999) tasks.push({ ci: i, tx, ty, rain: false, pri: 1 });
  }
  return tasks;
}

// 2 枚目: 1 枚目（a）を太陽に重ねたうえで、合計の通り具合が target になる b のずらし幅
function offsetFor2(s, sun, b, a, target, side) {
  const ca = { ...s.clouds[a], x: sun.x, y: sun.y, rain: false };
  const T = (dx) => M.transmit(sun, [ca, { ...s.clouds[b], x: sun.x + side * dx, y: sun.y, rain: false }]);
  if (T(0) >= target) return 0;
  let lo = 0, hi = M.cloudRx(s.clouds[b]) + sun.r + 0.02;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (T(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// タスクを指に割り当てる（今持っている雲は、まだ上位にいれば持ち続ける）
function applyTasks(s, hands, tasks, noise) {
  tasks.sort((a, b) => b.pri - a.pri);
  const top = tasks.slice(0, hands.length);
  const free = hands.filter((h) => !top.some((t) => t.ci === h.ci));
  for (const t of top) {
    let h = hands.find((x) => x.ci === t.ci);
    if (!h) { h = free.shift(); assign(h, t.ci); }
    const nz = noise ? noise(t.ci) : [0, 0];
    h.tx = t.tx + nz[0]; h.ty = t.ty + nz[1]; h.wantRain = t.rain;
  }
  for (const h of free) assign(h, -1);
}

function greedyBot(view = 'all') {
  const hands = makeHands(2, 2.0, 0);
  const mem = {};
  let tick = 0;
  return (s) => {
    if (tick++ % 6 === 0) applyTasks(s, hands, planGreedy(s, mem, view));
    moveHands(s, hands);
  };
}

// 人らしい: 0.4 秒遅れ、位置のぶれ ± 0.02（1 秒ごとに変わる）、速さ 1.2、指 1 本、持ち替え 0.3 秒
function humanBot() {
  const hands = makeHands(1, 1.2, 0.3);
  const mem = {};
  const queue = [];
  const nz = [];
  let tick = 0, nzAt = -1;
  return (s) => {
    if (tick % 6 === 0) queue.push({ at: s.t + 0.4, tasks: planGreedy(s, mem, 'all') });
    tick++;
    if (s.t >= nzAt) {
      nzAt = s.t + 1;
      for (let i = 0; i < s.clouds.length; i++) nz[i] = [(M.rand(s._bot) * 2 - 1) * 0.02, (M.rand(s._bot) * 2 - 1) * 0.02];
    }
    while (queue.length && queue[0].at <= s.t) applyTasks(s, hands, queue.shift().tasks, (ci) => nz[ci]);
    moveHands(s, hands);
  };
}

// でたらめ: 1.5 秒ごとに雲を 1 つ選び、0.5 秒かけてでたらめな所へ。25% でそのあと 1.5 秒降らせる
function randomBot() {
  const hands = makeHands(1, 0, 0);
  let next = 0, rainUntil = -1, moveUntil = -1;
  return (s) => {
    const r = s._bot, h = hands[0];
    if (s.t >= next) {
      const ci = Math.floor(M.rand(r) * s.clouds.length);
      assign(h, ci);
      const c = s.clouds[ci];
      h.tx = M.rand(r); h.ty = 0.1 + 0.85 * M.rand(r); h.wantRain = false;
      h.speed = dist(c.x, c.y, h.tx, h.ty) / 0.5;
      moveUntil = s.t + 0.5;
      rainUntil = M.rand(r) < 0.25 ? moveUntil + HOLD + 1.5 : -1;
      next = s.t + Math.max(1.5, rainUntil - s.t);
    }
    if (s.t >= moveUntil) {
      if (s.t < rainUntil) h.wantRain = true;
      else assign(h, -1);
    }
    moveHands(s, hands);
  };
}

const idleBot = () => () => {};

// 雲を全部、いつも太陽に重ねる（指の数は問わない）
const coverBot = () => (s) => {
  const sun = M.sunAt(M.clock(s).u);
  s.clouds.forEach((c, i) => {
    c.held = true; c.rain = false;
    if (sun) M.moveCloud(s, i, sun.x, sun.y);
  });
};

// 雲 1 つをいつも植物の上で降らせ続ける
const rainBot = () => (s) => {
  const c = s.clouds[0];
  M.moveCloud(s, 0, 0.5, 0.85);
  c.held = true;
  c.rain = s.t >= HOLD;
};

const BOTS = {
  greedy: () => greedyBot('all'),
  human: humanBot,
  random: randomBot,
  idle: idleBot,
  cover: coverBot,
  rain: rainBot,
  'no-time': () => greedyBot('noTime'),
  'no-stage': () => greedyBot('noStage'),
};

function run(plant, bot, seed) {
  const s = M.create(plant, seed);
  s._bot = { rng: (seed * 7919 + 13) >>> 0 };   // ボット用の乱数（遊びの乱数とは別）
  const act = BOTS[bot]();
  while (!s.over) { act(s); M.step(s); }
  return { over: s.over, t: s.t, P: s.P, H: s.H, splits: s.splits };
}

function median(a) {
  const b = a.slice().sort((x, y) => x - y);
  if (!b.length) return Infinity;
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

function measure(plant, bot, runs) {
  const rs = [];
  for (let i = 1; i <= runs; i++) rs.push(run(plant, bot, i));
  const clears = rs.filter((r) => r.over === 'clear');
  return {
    clear: clears.length / runs,
    dead: rs.filter((r) => r.over === 'dead').length / runs,
    median: median(clears.map((r) => r.t)),
    // 失敗を無限に遅いとした中央値（枯れる打ち方と比べるため）
    medianAll: median(rs.map((r) => (r.over === 'clear' ? r.t : Infinity))),
    P: rs.reduce((a, r) => a + r.P, 0) / runs,
  };
}

const TARGET = { tomato: [65, 85], strawberry: [80, 110], cactus: [90, 130] };

function checks(plant, m) {
  const g = m.greedy.median;
  const [lo, hi] = TARGET[plant];
  const hl = plant === 'cactus' ? 1.6 : 1.4, hd = plant === 'cactus' ? 0.15 : 0.05;
  const out = [];
  const ok = (name, cond, note) => out.push({ name, ok: !!cond, note });
  ok('greedy', g >= lo && g <= hi && m.greedy.clear > 0.95, `${g.toFixed(1)} 秒（${lo}〜${hi}）`);
  ok('human', m.human.medianAll <= g * hl && m.human.dead < hd, `${(m.human.medianAll / g).toFixed(2)} 倍（${hl} 以内）、枯れ ${(m.human.dead * 100).toFixed(0)}%（${hd * 100}% 未満）`);
  ok('random', m.random.clear < 0.2 || m.random.medianAll >= g * 2.5, `クリア ${(m.random.clear * 100).toFixed(0)}%`);
  for (const b of ['idle', 'cover', 'rain']) ok(b, m[b].clear === 0, `クリア ${(m[b].clear * 100).toFixed(0)}%`);
  for (const b of ['no-time', 'no-stage']) ok(b, m[b].medianAll >= g * 1.2, `${(m[b].medianAll / g).toFixed(2)} 倍（1.2 以上）`);
  return out;
}

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const runs = +get('--runs', 200);
  const plants = get('--plant') ? [get('--plant')] : Object.keys(CONFIG.plants);
  const bots = get('--bot') ? [get('--bot')] : Object.keys(BOTS);
  let fails = 0;
  for (const plant of plants) {
    const m = {};
    console.log(`\n${plant}（${runs} 回）`);
    console.log('| ボット | クリア | 枯れた | タイム中央値 | 失敗込みの中央値 | 平均の育ち |');
    console.log('|---|---|---|---|---|---|');
    for (const bot of bots) {
      m[bot] = measure(plant, bot, runs);
      const r = m[bot];
      console.log(`| ${bot} | ${(r.clear * 100).toFixed(0)}% | ${(r.dead * 100).toFixed(0)}% | ${fmt(r.median)} | ${fmt(r.medianAll)} | ${r.P.toFixed(0)}% |`);
    }
    if (bots.length === Object.keys(BOTS).length) {
      for (const c of checks(plant, m)) {
        if (!c.ok) fails++;
        console.log(`  ${c.ok ? 'ok' : 'NG'} ${c.name}: ${c.note}`);
      }
    }
  }
  if (bots.length === Object.keys(BOTS).length) console.log(fails ? `\n${fails} 件が目安の外` : '\nすべて目安の中');
  process.exitCode = fails ? 1 : 0;
}

module.exports = { run, measure, BOTS };
if (require.main === module) main();
