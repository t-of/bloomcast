// BLOOMCAST の決まりごと（太陽・雲・日差し・雨・土の水・育ち・元気・風）。画面（DOM）に触らない。
// ブラウザ（main.js）と node（tools/sim.js・tools/test.js）で同じコードを動かす。
//
// 座標は横 0〜1、縦 0〜1.6（上が 0）。植物の根元は (0.5, 1.45)、空は縦 0.1〜0.95、地平は 0.95。
// 1 ステップ 1/60 秒の固定刻みで進める（端末の速さで結果が変わらないように）。
// 数はすべて CONFIG に集める。値は tools/sim.js のボットで測って決めた（README の「釣り合い」）。
//
// 雲を動かす・雨を降らせるのは呼ぶ側の仕事。clouds[i] の x・y・held・rain を書き換えてから step() を呼ぶ。
(function (root) {
  'use strict';

  const CONFIG = {
    dt: 1 / 60,
    timeLimit: 300,          // 秒。これを過ぎたら時間切れ
    dayStart: 0.05,          // 1 日目の朝の少しあとから始める（1 日を 0〜1 で）
    parts: [0.275, 0.275, 0.275, 0.175],   // 朝・昼・夕・夜の長さ（1 日に対する割合）
    sunR: 0.06,
    alpha: 0.7,              // ふつうの雲が日差しを削る割合
    alphaRain: 0.85,         // 雨を降らせている雲
    edge: 0.15,              // 雲の縁のぼかしの幅（楕円の半径に対する割合）
    cloudRx: 0.16, cloudRy: 0.07,
    rain: 0.12,              // 雲がまるごと植物にかかったときに土に入る水 /秒
    rainDelay: 0.5,          // 雨が土に届くまで（秒）
    plantHalf: 0.04,         // 植物の幅の半分（雨の当たり）
    drain: 0.15, refill: 0.04,   // 雲の水 /秒
    dryBase: 0.006, dryLight: 0.022,
    fall: 0.2,               // 帯から外れて合い具合が 0 になるまでの距離（植物ごとに上書き）
    loss: 0.08, gain: 0.02,  // 元気 /秒
    bandMove: 2,             // 帯が次の帯へ動く秒数
    nightGrowth: 0.5,
    plants: {
      tomato: {
        name: 'トマト', level: 'やさしい', stages: ['芽', '葉', 'つぼみ', '花'],
        G: 1.4, dry: 1.0, bandL: 0.2, bandM: 0.2, day: 40, wind: null,
        light: [[0.35, 0.50, 0.35], [0.45, 0.70, 0.45], [0.50, 0.75, 0.45], [0.55, 0.80, 0.50]],
        water: [0.55, 0.55, 0.50, 0.40],
        start: [[0.2, 0.2], [0.8, 0.26]],
      },
      strawberry: {
        name: 'イチゴ', level: 'ふつう', stages: ['芽', '葉', 'つぼみ', '花'],
        G: 1.2, dry: 1.2, bandL: 0.2, bandM: 0.2, day: 36, wind: { speed: 0.02, daily: true },
        light: [[0.50, 0.30, 0.45], [0.60, 0.35, 0.55], [0.65, 0.40, 0.60], [0.70, 0.35, 0.60]],
        water: [0.55, 0.65, 0.75, 0.60],
        start: [[0.2, 0.2], [0.8, 0.26]],
      },
      cactus: {
        name: 'サボテン', level: 'むずかしい', stages: ['芽', 'からだ', 'つぼみ', '花'],
        G: 1.0, dry: 0.5, bandL: 0.16, bandM: 0.14, fall: 0.12, day: 30, wind: { speed: 0.035, gust: 0.5 },
        light: [[0.50, 0.70, 0.50], [0.60, 0.85, 0.60], [0.65, 0.85, 0.60], [0.60, 0.80, 0.55]],
        water: [0.30, 0.20, 0.25, 0.15],
        start: [[0.15, 0.18], [0.85, 0.24], [0.5, 0.62]],
      },
    },
  };
  const PHASES = ['朝', '昼', '夕', '夜'];
  const DELAY = Math.round(CONFIG.rainDelay / CONFIG.dt);

  // 種つき乱数（mulberry32）。状態は s.rng に数で持つので、状態ごと写せば同じ続きになる。
  function rand(s) {
    let t = (s.rng = (s.rng + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // 時計: 何日目か、1 日のどこか（0〜1）、時間帯（0 朝 1 昼 2 夕 3 夜）、昼の進み u（夜は -1）、次の時間帯までの秒
  function clock(s) {
    const p = CONFIG.plants[s.plant];
    const x = CONFIG.dayStart + s.t / p.day;
    const pos = x - Math.floor(x);
    let phase = 0, edge = 0;
    for (; phase < 3; phase++) { if (pos < edge + CONFIG.parts[phase]) break; edge += CONFIG.parts[phase]; }
    const dayLen = 1 - CONFIG.parts[3];
    return {
      day: Math.floor(x) + 1, pos, phase,
      u: pos < dayLen ? pos / dayLen : -1,
      toNext: (edge + CONFIG.parts[phase] - pos) * p.day,
    };
  }

  function sunAt(u) {
    if (u < 0) return null;
    return { x: 0.5 - 0.42 * Math.cos(Math.PI * u), y: 0.95 - 0.75 * Math.sin(Math.PI * u), r: CONFIG.sunR };
  }
  const sunStrength = (u) => (u < 0 ? 0 : Math.pow(Math.sin(Math.PI * u), 0.7));

  const cloudScale = (c) => 0.6 + 0.4 * c.w;
  const cloudRx = (c) => CONFIG.cloudRx * cloudScale(c);
  const cloudRy = (c) => CONFIG.cloudRy * cloudScale(c);
  const raining = (c) => c.rain && c.w > 0;

  // 雲が点 (x, y) にかける重み: 楕円の内側 1、縁（外側 edge の幅）でなめらかに 0 へ
  function weight(c, x, y) {
    const dx = (x - c.x) / cloudRx(c), dy = (y - c.y) / cloudRy(c);
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r >= 1) return 0;
    const e = (1 - r) / CONFIG.edge;
    if (e >= 1) return 1;
    return e * e * (3 - 2 * e);
  }

  // 太陽の円の 13 点（中心 1、半径の半分に 6、0.9 倍に 6）
  const SAMPLES = [[0, 0]];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3, b = a + Math.PI / 6;
    SAMPLES.push([0.5 * Math.cos(a), 0.5 * Math.sin(a)], [0.9 * Math.cos(b), 0.9 * Math.sin(b)]);
  }

  // 通り具合 T（0〜1）: 雲 1 枚が丸ごと重なると 1 - α、2 枚で (1 - α)²
  function transmit(sun, clouds) {
    let sum = 0;
    for (const [px, py] of SAMPLES) {
      const x = sun.x + px * sun.r, y = sun.y + py * sun.r;
      let t = 1;
      for (const c of clouds) {
        const k = weight(c, x, y);
        if (k > 0) t *= 1 - (raining(c) ? CONFIG.alphaRain : CONFIG.alpha) * k;
      }
      sum += t;
    }
    return sum / SAMPLES.length;
  }

  // 雨が植物にかかる割合（雲の横の幅と植物の幅の重なり）
  function rainCover(c) {
    const rx = cloudRx(c), h = CONFIG.plantHalf;
    const over = Math.min(c.x + rx, 0.5 + h) - Math.max(c.x - rx, 0.5 - h);
    return clamp(over / (2 * h), 0, 1);
  }

  const bandFor = (plant, stage, phase) => {
    const p = CONFIG.plants[plant];
    return { l: phase < 3 ? p.light[stage][phase] : p.light[stage][1], m: p.water[stage] };
  };

  // 合い具合: 帯の中 1、外は距離 fall で 0 まで下がる
  function fit(x, center, width, fall) {
    const d = Math.max(0, Math.abs(x - center) - width / 2);
    return Math.max(0, 1 - d / fall);
  }

  function create(plant, seed = 1) {
    const p = CONFIG.plants[plant];
    if (!p) throw new Error(`知らない植物: ${plant}`);
    const s = {
      plant, seed, rng: seed >>> 0 || 1, t: 0,
      M: p.water[0], H: 1, P: 0, stage: 0,
      clouds: p.start.map(([x, y]) => ({ x, y, w: 1, held: false, rain: false })),
      rainQ: new Array(DELAY).fill(0), rainI: 0,
      band: null, bandFrom: null, bandGoal: null, bandT: CONFIG.bandMove,
      wind: { v: 0, gust: 1, next: 0, day: 0 },
      over: null, splits: [], events: [],
      miss: { lightLow: 0, lightHigh: 0, waterLow: 0, waterHigh: 0 },
      phase: 0, day: 1, S: 0, T: 1, L: 0, fL: 1, fM: 1, q: 1, speed: 1, bad: false,
    };
    const c = clock(s);
    s.phase = c.phase; s.day = c.day;
    s.band = bandFor(plant, 0, c.phase);
    s.bandL = s.band.l;
    s.bandGoal = { ...s.band };
    s.bandFrom = { ...s.band };
    windDay(s, c.day);
    light(s, c);
    return s;
  }

  function windDay(s, day) {
    const w = CONFIG.plants[s.plant].wind;
    if (!w) return;
    if (s.wind.day === 0 || w.daily) s.wind.v = w.speed * (rand(s) < 0.5 ? -1 : 1);
    s.wind.day = day;
  }

  function light(s, c) {
    const sun = sunAt(c.u);
    s.S = sunStrength(c.u);
    s.T = sun ? transmit(sun, s.clouds) : 1;
    s.L = s.S * s.T;
  }

  // 雲を空の中に置く
  function moveCloud(s, i, x, y) {
    const c = s.clouds[i];
    c.x = clamp(x, 0, 1);
    c.y = clamp(y, 0.1, 0.95);
  }

  function step(s) {
    s.events.length = 0;
    if (s.over) return s;
    const cf = CONFIG, p = cf.plants[s.plant], dt = cf.dt;
    s.t += dt;
    const c = clock(s);
    if (c.day !== s.day) { s.day = c.day; windDay(s, c.day); }
    if (c.phase !== s.phase) { s.phase = c.phase; s.events.push({ type: 'phase', phase: c.phase }); }

    // 風（つかんでいない雲だけ流れる。端から出たら反対の端から入る）
    if (p.wind) {
      if (p.wind.gust && s.t >= s.wind.next) {
        s.wind.gust = 1 + p.wind.gust * (2 * rand(s) - 1);
        s.wind.next = s.t + 2 + 3 * rand(s);
      }
      const v = s.wind.v * s.wind.gust;
      for (const cl of s.clouds) {
        if (cl.held) continue;
        cl.x += v * dt;
        const rx = cloudRx(cl);
        if (cl.x > 1 + rx) cl.x -= 1 + 2 * rx;
        else if (cl.x < -rx) cl.x += 1 + 2 * rx;
      }
    }

    // 雨と雲の水
    let inflow = 0;
    for (const cl of s.clouds) {
      if (raining(cl)) {
        inflow += cf.rain * rainCover(cl);
        cl.w = Math.max(0, cl.w - cf.drain * dt);
        if (cl.w === 0) s.events.push({ type: 'empty' });
      } else if (!cl.rain) {
        cl.w = Math.min(1, cl.w + cf.refill * dt);
      }
    }
    const arrived = s.rainQ[s.rainI];
    s.rainQ[s.rainI] = inflow;
    s.rainI = (s.rainI + 1) % DELAY;

    light(s, c);
    s.M = clamp(s.M + (arrived - p.dry * (cf.dryBase + cf.dryLight * s.L)) * dt, 0, 1);

    // 帯（時間帯・段階が変わると bandMove 秒かけて動く）
    const goal = bandFor(s.plant, s.stage, c.phase);
    if (goal.l !== s.bandGoal.l || goal.m !== s.bandGoal.m) {
      s.bandFrom = { ...s.band }; s.bandGoal = goal; s.bandT = 0;
    }
    s.bandT = Math.min(cf.bandMove, s.bandT + dt);
    const k = s.bandT / cf.bandMove;
    s.band = { l: s.bandFrom.l + (s.bandGoal.l - s.bandFrom.l) * k, m: s.bandFrom.m + (s.bandGoal.m - s.bandFrom.m) * k };

    // 合い具合・元気・育ち
    const fall = p.fall || cf.fall;
    const night = c.phase === 3;
    s.fM = fit(s.M, s.band.m, p.bandM, fall);
    // 日の出・日の入りのころは、帯を日の強さより上に置かない（雲では日差しを足せないので）
    s.bandL = Math.min(s.band.l, s.S);
    s.fL = night ? 1 : fit(s.L, s.bandL, p.bandL, fall);
    s.q = night ? cf.nightGrowth * s.fM : s.fL * s.fM;
    const bad = s.fM === 0 || (!night && s.fL === 0);
    if (bad && !s.bad) s.events.push({ type: 'bad' });
    s.bad = bad;
    s.H = clamp(s.H + (bad ? -cf.loss : cf.gain) * dt, 0, 1);
    s.speed = s.q * (0.5 + 0.5 * s.H);
    s.P = Math.min(100, s.P + p.G * s.speed * dt);

    if (!night) {
      if (s.L < s.bandL - p.bandL / 2) s.miss.lightLow += dt;
      else if (s.L > s.bandL + p.bandL / 2) s.miss.lightHigh += dt;
    }
    if (s.M < s.band.m - p.bandM / 2) s.miss.waterLow += dt;
    else if (s.M > s.band.m + p.bandM / 2) s.miss.waterHigh += dt;

    const stage = Math.min(3, Math.floor(s.P / 25));
    if (s.P >= 100) {
      s.splits.push(s.t);
      s.over = 'clear';
      s.events.push({ type: 'clear' });
    } else if (stage > s.stage) {
      s.stage = stage;
      s.splits.push(s.t);
      s.events.push({ type: 'stage', stage });
    } else if (s.H <= 0) {
      s.over = 'dead';
      s.events.push({ type: 'dead' });
    } else if (s.t >= cf.timeLimit) {
      s.over = 'timeout';
      s.events.push({ type: 'timeout' });
    }
    return s;
  }

  // 一番長く外れていたもの（失敗のときに出す）
  function worstMiss(s) {
    let best = null;
    for (const k in s.miss) if (!best || s.miss[k] > s.miss[best]) best = k;
    return best;
  }

  // ★: 目安（ボットの上手な打ち方の中央値）の 1.15 倍以内で 3、1.5 倍以内で 2、クリアで 1
  const PAR = { tomato: 79, strawberry: 90, cactus: 109 };   // 秒。tools/sim.js の greedy の中央値
  function stars(plant, seconds) {
    const par = PAR[plant];
    return seconds <= par * 1.15 ? 3 : seconds <= par * 1.5 ? 2 : 1;
  }

  const api = {
    CONFIG, PHASES, PAR, create, step, clock, sunAt, sunStrength, transmit, rainCover, raining,
    cloudRx, cloudRy, moveCloud, bandFor, fit, worstMiss, stars, rand,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BloomModel = api;
})(this);
