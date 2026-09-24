'use strict';
// BLOOMCAST の画面。決まり（育ち・日差し・雨）は js/model.js にあり、ここは描く・触る・鳴らす・保存するだけ。

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'bloomcast.' で始める。
const STORE = 'bloomcast.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'BLOOMCAST', text: '空の雲を指で動かして太陽を隠し、長押しで雨を降らせて、画面の下の植物をできるだけ早く実らせる。ほしい日差しと水は朝・昼・夕と育ち具合で変わるので、動く太陽を追いかけて雲を配り直す。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----
const M = window.BloomModel;
const { CONFIG } = M;
const PLANTS = ['tomato', 'strawberry', 'cactus'];
const HOLD = 0.25;             // 雲を動かさずにこれだけ押すと雨
const $ = (id) => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// ---- 保存（知らない項目は捨て、足りない項目ははじめの値で埋める） ----
function loadSettings() {
  const v = load('settings', null);
  return { v: 1, sound: v && typeof v.sound === 'boolean' ? v.sound : true, coached: !!(v && v.coached === true) };
}
function cleanRecord(r) {
  if (!r || !Number.isFinite(r.ms) || r.ms <= 0) return null;
  const stars = [1, 2, 3].includes(r.stars) ? r.stars : 1;
  const splits = Array.isArray(r.splits) ? r.splits.filter(Number.isFinite).slice(0, 4) : [];
  return { ms: Math.round(r.ms), stars, splits };
}
function loadBest() {
  const v = load('best', null);
  const plants = {};
  for (const id of PLANTS) plants[id] = cleanRecord(v && v.plants && v.plants[id]);
  return { v: 1, plants };
}
const settings = loadSettings();
const best = loadBest();

// ---- 音（Web Audio で合成） ----
let actx = null, master = null, noiseBuf = null, rainNode = null;
function audio() {
  if (!settings.sound) return null;
  if (!actx) {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      master = actx.createGain();
      master.gain.value = 0.6;
      master.connect(actx.destination);
      noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch { actx = null; return null; }
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function unlockAudio() {
  if (!settings.sound) return;
  setAudioSession(true);
  audio();
}
function tone(freq, dur, { type = 'sine', vol = 0.12, at = 0, to = 0 } = {}) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
function puff(dur, vol, freq) {
  const a = audio(); if (!a) return;
  const t = a.currentTime;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = noiseBuf;
  f.type = 'lowpass'; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t); src.stop(t + dur + 0.02);
}
// 雨の音: 細かいノイズを降らせている間だけ流す（止めると 0.3 秒で消える）
function rainSound(on) {
  const a = on ? audio() : actx;
  if (!a) return;
  if (on && !rainNode) {
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf; src.loop = true;
    f.type = 'highpass'; f.frequency.value = 2400;
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, a.currentTime + 0.15);
    src.connect(f).connect(g).connect(master);
    src.start();
    rainNode = { src, g };
  } else if (!on && rainNode) {
    const { src, g } = rainNode;
    g.gain.cancelScheduledValues(a.currentTime);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.3);
    src.stop(a.currentTime + 0.32);
    rainNode = null;
  }
}
const notes = (list, step, opt) => list.forEach((f, i) => tone(f, step * 1.6, { ...opt, at: i * step }));
const SFX = {
  click: () => tone(1200, 0.03, { vol: 0.04, type: 'triangle' }),
  grab: () => puff(0.05, 0.12, 700),
  release: () => tone(320, 0.04, { vol: 0.05, type: 'sine' }),
  empty: () => tone(520, 0.18, { to: 240, vol: 0.08, type: 'triangle' }),
  ping: () => tone(1760, 0.09, { vol: 0.06 }),
  bad: () => notes([220, 175], 0.13, { type: 'square', vol: 0.035 }),
  phase: (p) => [
    () => notes([523, 784], 0.1, { vol: 0.07 }),
    () => tone(988, 0.2, { vol: 0.07 }),
    () => notes([784, 523], 0.1, { vol: 0.07 }),
    () => tone(262, 0.35, { vol: 0.07, type: 'triangle' }),
  ][p](),
  stage: (s) => notes([523, 659, 784].map((f) => f * (1 + 0.12 * (s - 1))), 0.08, { vol: 0.09, type: 'triangle' }),
  clear: () => notes([523, 659, 784, 1047, 1319], 0.16, { vol: 0.1, type: 'triangle' }),
  best: () => notes([1568, 2093], 0.1, { vol: 0.08, at: 0 }),
  lose: () => notes([523, 440, 370, 294], 0.15, { vol: 0.08, type: 'triangle' }),
};

// ---- 画面の大きさと座標 ----
const cv = $('sky');
let ctx = cv.getContext('2d');   // 植物のカードを描くときだけ差し替える
let W = 0, H = 0, dpr = 1, K = 1, OX = 0, OY = 0;   // 世界 (x, y) → 画面 (OX + x·K, OY + y·K)
function safe() {
  const s = getComputedStyle($('safe'));
  return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0 };
}
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const sa = safe();
  const top = Math.max(8, sa.top) + 56, bottom = Math.max(12, sa.bottom) + 70;
  K = Math.min(W, (H - top - bottom) / 1.6);
  OX = (W - K) / 2;
  OY = top + (H - top - bottom - 1.6 * K) / 2;
}
addEventListener('resize', resize);
resize();
const sx = (x) => OX + x * K, sy = (y) => OY + y * K;
const toWorld = (px, py) => ({ x: (px - OX) / K, y: (py - OY) / K });

// ---- 色 ----
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mixA = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgb = (c, alpha = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
const mix = (a, b, t) => rgb(mixA(hex(a), hex(b), Math.max(0, Math.min(1, t))));

// 1 日の空の色（位置 0〜1 → 上と下の色）
const SKY = [
  [0.0, '#3b4f8a', '#f4a77a'], [0.08, '#79b8e6', '#fde2c4'], [0.24, '#4fa6e0', '#c9ecfb'], [0.55, '#4fa6e0', '#c9ecfb'],
  [0.7, '#6d93d6', '#fcd3a4'], [0.79, '#5a4b90', '#f08a6b'], [0.83, '#262c63', '#a35a7e'], [0.87, '#0f1a3d', '#253366'],
  [0.97, '#0f1a3d', '#253366'], [1.0, '#3b4f8a', '#f4a77a'],
].map(([p, a, b]) => [p, hex(a), hex(b)]);
function skyAt(pos) {
  let i = 0;
  while (i < SKY.length - 2 && pos > SKY[i + 1][0]) i++;
  const [p0, a0, b0] = SKY[i], [p1, a1, b1] = SKY[i + 1];
  const t = Math.max(0, Math.min(1, (pos - p0) / (p1 - p0)));
  return [mixA(a0, a1, t), mixA(b0, b1, t)];
}
// 夜の暗さ 0〜1（雲や地面を暗くする）
function darkAt(pos) {
  if (pos < 0.04) return 0.6 * (1 - pos / 0.04);
  if (pos < 0.76) return 0;
  if (pos < 0.86) return 0.7 * ((pos - 0.76) / 0.1);
  return 0.7;
}

const STARS = Array.from({ length: 40 }, (_, i) => [(i * 0.618034) % 1, ((i * 0.381966 * 7) % 1) * 0.8, 0.6 + ((i * 37) % 10) / 10]);

// ---- 状態 ----
let mode = 'title';        // title / play / result
let paused = false;
let g = null;              // 遊んでいるゲームの状態（js/model.js）
let plantId = 'tomato';
let demo = M.create('strawberry', (Math.random() * 1e9) | 0);
const pointers = new Map(); // pointerId → { ci, ox, oy, sx, sy, px, py, t0, mode }
let drops = [];
let look = { pale: 0, brown: 0, droop: 0, yellow: 0, dull: 0, lean: 0, puddle: 0 };
let pop = 0;               // 段階が上がったときの動き（1 → 0）
let fitWas = { l: 1, m: 1 }, pingAt = { l: -9, m: -9 };
let hintShown = false, rainedOnce = false;

// ---- 描く ----
function drawSky(s) {
  const clk = M.clock(s);
  const [top, bot] = skyAt(clk.pos);
  const grd = ctx.createLinearGradient(0, 0, 0, sy(0.95));
  grd.addColorStop(0, rgb(top)); grd.addColorStop(1, rgb(bot));
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, sy(0.95) + 1);
  const dark = darkAt(clk.pos);
  // 星と月（夜）
  if (dark > 0.05) {
    ctx.fillStyle = `rgba(255,255,255,${dark})`;
    for (const [x, y, r] of STARS) {
      ctx.beginPath(); ctx.arc(x * W, sy(0.08 + y) - OY * 0.6 * (1 - y), r * 1.2, 0, 7); ctx.fill();
    }
  }
  if (clk.phase === 3) {
    const v = (clk.pos - 0.825) / 0.175;
    const mx = sx(0.3 + 0.4 * v), my = sy(0.95 - 0.55 * Math.sin(Math.PI * v));
    ctx.save();
    ctx.beginPath(); ctx.arc(mx, my, 0.045 * K, 0, 7); ctx.clip();
    ctx.fillStyle = '#f3f0d8';
    ctx.beginPath(); ctx.rect(mx - K, my - K, 2 * K, 2 * K);
    ctx.moveTo(mx + 0.062 * K, my - 0.012 * K); ctx.arc(mx + 0.022 * K, my - 0.012 * K, 0.04 * K, 0, 7);
    ctx.fill('evenodd');
    ctx.restore();
  }
  // 太陽
  const sun = M.sunAt(clk.u);
  if (sun) {
    const x = sx(sun.x), y = sy(sun.y), r = sun.r * K;
    const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
    glow.addColorStop(0, 'rgba(255,236,160,0.55)'); glow.addColorStop(1, 'rgba(255,236,160,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 7); ctx.fill();
    ctx.fillStyle = mix('#ffb347', '#ffe066', M.sunStrength(clk.u));
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  return { clk, dark, top, bot };
}

function drawGround(dark) {
  const y0 = sy(0.95);
  const grd = ctx.createLinearGradient(0, y0, 0, H);
  grd.addColorStop(0, mix('#9fcf6e', '#1d2c3a', dark));
  grd.addColorStop(0.25, mix('#7cb85a', '#18263a', dark));
  grd.addColorStop(1, mix('#5f9a45', '#121d2e', dark));
  ctx.fillStyle = grd;
  ctx.fillRect(0, y0, W, H - y0);
  // 遠くの丘
  ctx.fillStyle = mix('#8cc463', '#1a2a3a', dark);
  ctx.beginPath();
  ctx.moveTo(0, y0 + 2);
  ctx.quadraticCurveTo(W * 0.25, y0 - 0.05 * K, W * 0.55, y0 + 2);
  ctx.quadraticCurveTo(W * 0.8, y0 - 0.035 * K, W, y0 + 2);
  ctx.lineTo(W, y0 + 3); ctx.lineTo(0, y0 + 3);
  ctx.fill();
}

// 雲: 判定は楕円、見た目は丸を重ねたもこもこ
const PUFFS = [[-0.62, 0.22, 0.62], [-0.28, -0.12, 0.92], [0.22, -0.28, 1.0], [0.6, 0.12, 0.7], [0.02, 0.28, 0.8]];
function drawCloud(c, dark, held) {
  const rx = M.cloudRx(c) * K, ry = M.cloudRy(c) * K, x = sx(c.x), y = sy(c.y);
  const rain = M.raining(c);
  const body = rain ? mix('#c3cfdf', '#4a5578', dark) : mix('#ffffff', '#5e6a8e', dark);
  const shade = rain ? mix('#9eadc4', '#3a4466', dark) : mix('#dce6f2', '#4b5679', dark);
  ctx.save();
  if (held) { ctx.shadowColor = 'rgba(20,40,80,0.35)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6; }
  ctx.fillStyle = shade;
  ctx.beginPath(); ctx.ellipse(x, y + ry * 0.25, rx, ry * 0.75, 0, 0, 7); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = body;
  for (const [px, py, pr] of PUFFS) { ctx.beginPath(); ctx.arc(x + px * rx, y + py * ry, pr * ry, 0, 7); ctx.fill(); }
  ctx.beginPath(); ctx.ellipse(x, y + ry * 0.15, rx * 0.92, ry * 0.62, 0, 0, 7); ctx.fill();
  ctx.restore();
}

function updateDrops(s, dt) {
  const many = reduced.matches ? 0.35 : 1;
  for (const c of s.clouds) {
    if (!M.raining(c)) continue;
    const rx = M.cloudRx(c);
    let n = 60 * dt * many * 1.5;
    while (n > 0) {
      if (n < 1 && Math.random() > n) break;
      drops.push({ x: c.x + (Math.random() * 2 - 1) * rx * 0.8, y: c.y + M.cloudRy(c) * 0.5, v: 1.1 + Math.random() * 0.3 });
      n--;
    }
  }
  for (const d of drops) d.y += d.v * dt;
  drops = drops.filter((d) => d.y < 1.47);
}
function drawDrops(dark) {
  ctx.strokeStyle = dark > 0.3 ? 'rgba(170,190,230,0.8)' : 'rgba(70,140,220,0.75)';
  ctx.lineWidth = Math.max(1.5, 0.004 * K);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const d of drops) { ctx.moveTo(sx(d.x), sy(d.y)); ctx.lineTo(sx(d.x), sy(d.y + 0.025)); }
  ctx.stroke();
}

// ---- 植物（顔は付けない。平らな絵） ----
function leafColor(lk) {
  let c = mixA(hex('#4f9d3a'), hex('#bcd98c'), lk.pale);
  c = mixA(c, hex('#c7b640'), lk.yellow * 0.8);
  c = mixA(c, hex('#8c9484'), lk.dull * 0.7);
  return mixA(c, hex('#1d2c3a'), (lk.night || 0) * 0.5);
}
function leaf(x, y, ang, len, wid, col, brown) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  ctx.fillStyle = rgb(col);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.5, -wid, len, 0);
  ctx.quadraticCurveTo(len * 0.5, wid, 0, 0);
  ctx.fill();
  if (brown > 0.05) {
    ctx.fillStyle = `rgba(140,88,40,${Math.min(1, brown)})`;
    ctx.beginPath();
    ctx.moveTo(len * 0.7, -wid * 0.45);
    ctx.quadraticCurveTo(len * 0.9, -wid * 0.2, len, 0);
    ctx.quadraticCurveTo(len * 0.9, wid * 0.2, len * 0.7, wid * 0.45);
    ctx.fill();
  }
  ctx.restore();
}
function flower(x, y, r, petal, center) {
  ctx.fillStyle = petal;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.5, 0, 7); ctx.fill();
  }
  ctx.fillStyle = center;
  ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, 7); ctx.fill();
}
const quad = (p0, p1, p2, t) => [(1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]];

function drawTomato(P, lk, bx, by, k) {
  const gr = P / 100, h = (0.05 + 0.27 * gr) * k;
  const col = leafColor(lk), stem = mixA(col, hex('#2f6b24'), 0.4);
  const p0 = [bx, by], p2 = [bx + lk.lean * h * 0.3, by - h], p1 = [bx, by - h * 0.5];
  ctx.strokeStyle = rgb(stem); ctx.lineWidth = (0.006 + 0.007 * gr) * k; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(...p0); ctx.quadraticCurveTo(...p1, ...p2); ctx.stroke();
  const n = 2 + Math.floor(gr * 8);
  const droop = lk.droop * 0.9, curl = 1 - lk.brown * 0.45;
  for (let i = 0; i < n; i++) {
    const t = n === 2 ? 1 : 0.22 + (0.72 * i) / (n - 1);
    const [x, y] = quad(p0, p1, p2, t);
    const side = i % 2 ? 1 : -1;
    const len = (0.03 + 0.035 * gr) * k * (1.1 - 0.4 * t);
    const ang = side > 0 ? -0.6 + droop : Math.PI + 0.6 - droop;
    leaf(x, y, ang, len, len * 0.32 * curl, col, lk.brown);
  }
  if (P >= 50) {
    const spots = [[-1, 0.62], [1, 0.78], [-1, 0.9]];
    for (const [side, t] of spots) {
      const [x, y] = quad(p0, p1, p2, t);
      const fx = x + side * 0.04 * k, fy = y - 0.01 * k;
      ctx.strokeStyle = rgb(stem); ctx.lineWidth = 0.004 * k;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(fx, y - 0.02 * k, fx, fy); ctx.stroke();
      if (P >= 100) {
        ctx.fillStyle = '#e5483a';
        ctx.beginPath(); ctx.arc(fx, fy + 0.02 * k, 0.022 * k, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.arc(fx - 0.007 * k, fy + 0.012 * k, 0.006 * k, 0, 7); ctx.fill();
        ctx.fillStyle = '#3e7d2a';
        ctx.beginPath(); ctx.ellipse(fx, fy + 0.0, 0.012 * k, 0.004 * k, 0, 0, 7); ctx.fill();
      } else if (P >= 75) flower(fx, fy, 0.014 * k, '#ffd23f', '#e59a1c');
      else { ctx.fillStyle = mix('#6fb04c', '#9fcf6e', (P - 50) / 25); ctx.beginPath(); ctx.arc(fx, fy, (0.005 + 0.004 * (P - 50) / 25) * k, 0, 7); ctx.fill(); }
    }
  }
}

function drawStrawberry(P, lk, bx, by, k) {
  const gr = P / 100, col = leafColor(lk), stem = mixA(col, hex('#2f6b24'), 0.35);
  const n = 2 + Math.floor(gr * 6);
  const droop = lk.droop * 0.7, curl = 1 - lk.brown * 0.4;
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1) - 0.5;
    const a = -Math.PI / 2 + f * (1.5 + droop) + lk.lean * 0.2;
    const len = (0.025 + 0.05 * gr) * k * (1 - Math.abs(f) * 0.3);
    const ex = bx + Math.cos(a) * len, ey = by + Math.sin(a) * len;
    ctx.strokeStyle = rgb(stem); ctx.lineWidth = 0.004 * k; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
    const ll = (0.02 + 0.025 * gr) * k;
    for (const d of [-0.8, 0, 0.8]) leaf(ex, ey, a + d + droop * Math.sign(f || 1) * 0.5, ll, ll * 0.62 * curl, col, lk.brown);
  }
  if (P >= 50) {
    for (const side of [-1, 1]) {
      const fx = bx + side * (0.06 + 0.02 * gr) * k, fy = by - 0.02 * k;
      ctx.strokeStyle = rgb(stem); ctx.lineWidth = 0.003 * k;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx + side * 0.03 * k, by - 0.07 * k, fx, fy); ctx.stroke();
      if (P >= 100) {
        ctx.fillStyle = '#e0303d';
        ctx.beginPath();
        ctx.moveTo(fx - 0.018 * k, fy + 0.004 * k);
        ctx.quadraticCurveTo(fx, fy - 0.004 * k, fx + 0.018 * k, fy + 0.004 * k);
        ctx.quadraticCurveTo(fx + 0.012 * k, fy + 0.03 * k, fx, fy + 0.04 * k);
        ctx.quadraticCurveTo(fx - 0.012 * k, fy + 0.03 * k, fx - 0.018 * k, fy + 0.004 * k);
        ctx.fill();
        ctx.fillStyle = '#ffe28a';
        for (const [dx, dy] of [[-0.008, 0.012], [0.006, 0.01], [-0.002, 0.022], [0.008, 0.024], [-0.006, 0.03]]) {
          ctx.beginPath(); ctx.arc(fx + dx * k, fy + dy * k, 0.0018 * k, 0, 7); ctx.fill();
        }
        ctx.fillStyle = '#3e7d2a';
        ctx.beginPath(); ctx.ellipse(fx, fy + 0.002 * k, 0.014 * k, 0.005 * k, 0, 0, 7); ctx.fill();
      } else if (P >= 75) flower(fx, fy, 0.016 * k, '#ffffff', '#f2c230');
      else { ctx.fillStyle = '#7dbb58'; ctx.beginPath(); ctx.arc(fx, fy, (0.005 + 0.004 * (P - 50) / 25) * k, 0, 7); ctx.fill(); }
    }
  }
}

function capsule(x, y, w, h) {
  const r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x - r, y - h + r);
  ctx.arc(x, y - h + r, r, Math.PI, 0);
  ctx.lineTo(x + r, y);
  ctx.closePath();
}
function drawCactus(P, lk, bx, by, k) {
  const gr = P / 100;
  let col = mixA(hex('#3f9a5a'), hex('#b9d98c'), lk.pale);
  col = mixA(col, hex('#c7b640'), lk.yellow * 0.8);
  col = mixA(col, hex('#8c9484'), lk.dull * 0.7);
  col = mixA(col, hex('#1d2c3a'), (lk.night || 0) * 0.5);
  const w = (0.035 + 0.03 * gr) * k * (1 - 0.18 * lk.droop), h = (0.035 + 0.2 * gr) * k;
  const lean = lk.lean * 0.12;
  ctx.save();
  ctx.translate(bx, by);
  ctx.transform(1, 0, -lean, 1, 0, 0);
  const light = rgb(mixA(col, [255, 255, 255], 0.25)), dark = rgb(mixA(col, [20, 60, 30], 0.3));
  // 腕: 横に出て上へ曲がる（横の棒と縦のカプセル）
  const arm = (side, at, len, up) => {
    const aw = w * 0.55, ay = -h * at, ex = side * (w / 2 + len);
    ctx.fillStyle = rgb(col);
    ctx.fillRect(Math.min(0, ex), ay - aw, Math.abs(ex), aw);
    capsule(ex - side * aw / 2, ay, aw, aw + up);
    ctx.fill();
  };
  if (gr > 0.4) arm(1, 0.45, w * 0.9 * Math.min(1, (gr - 0.4) / 0.2), h * 0.28 * Math.min(1, (gr - 0.4) / 0.2));
  if (gr > 0.6) arm(-1, 0.6, w * 0.8 * Math.min(1, (gr - 0.6) / 0.2), h * 0.22 * Math.min(1, (gr - 0.6) / 0.2));
  ctx.fillStyle = rgb(col);
  capsule(0, 0, w, h); ctx.fill();
  ctx.strokeStyle = dark; ctx.lineWidth = Math.max(1, 0.003 * k);
  for (const f of [-0.22, 0.22]) { ctx.beginPath(); ctx.moveTo(f * w, -2); ctx.lineTo(f * w, -h + w * 0.45); ctx.stroke(); }
  ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, 0.002 * k);
  for (let yy = 0.12; yy < 0.95; yy += 0.14) {
    for (const f of [-0.5, 0, 0.5]) {
      const x = f * w * 0.9, y = -h * yy - (f === 0 ? 0.03 * k * 0.3 : 0);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (f < 0 ? -1 : f > 0 ? 1 : 0) * 0.006 * k, y - 0.005 * k); ctx.stroke();
    }
  }
  if (lk.brown > 0.05) {
    ctx.fillStyle = `rgba(150,95,45,${Math.min(0.8, lk.brown)})`;
    ctx.beginPath(); ctx.arc(0, -h + w / 2, w / 2, Math.PI, 0); ctx.fill();
  }
  const tx = 0, ty = -h;
  if (P >= 100) {
    ctx.fillStyle = '#d63a5c';
    ctx.beginPath(); ctx.ellipse(tx, ty - 0.012 * k, 0.014 * k, 0.02 * k, 0, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(tx - 0.005 * k, ty - 0.018 * k, 0.004 * k, 0, 7); ctx.fill();
  } else if (P >= 75) {
    flower(tx, ty - 0.008 * k, 0.02 * k, '#ff6fa3', '#ffd23f');
  } else if (P >= 50) {
    ctx.fillStyle = mix('#7dbb58', '#ff8fb8', (P - 50) / 25);
    ctx.beginPath(); ctx.ellipse(tx, ty - 0.004 * k, (0.005 + 0.004 * (P - 50) / 25) * k, (0.007 + 0.005 * (P - 50) / 25) * k, 0, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function drawPlant(id, P, lk, bx, by, k) {
  const dark = lk.night || 0;
  // 土と水たまり
  const wet = lk.wet == null ? 0.5 : lk.wet;
  ctx.fillStyle = rgb(mixA(mixA(hex('#9a6b43'), hex('#5a3a22'), wet), hex('#1a1a26'), dark * 0.8));
  ctx.beginPath(); ctx.ellipse(bx, by + 0.006 * k, 0.075 * k, 0.018 * k, 0, 0, 7); ctx.fill();
  if (lk.puddle > 0.05) {
    ctx.fillStyle = `rgba(90,160,230,${Math.min(0.75, lk.puddle)})`;
    ctx.beginPath(); ctx.ellipse(bx + 0.02 * k, by + 0.016 * k, 0.07 * k * Math.min(1, lk.puddle + 0.3), 0.013 * k, 0, 0, 7); ctx.fill();
  }
  if (id === 'tomato') drawTomato(P, lk, bx, by, k);
  else if (id === 'strawberry') drawStrawberry(P, lk, bx, by, k);
  else drawCactus(P, lk, bx, by, k);
}

// ---- ゲージ（下が 0・上が最大。緑の帯がほしい量、白い三角と塗りが今の量） ----
const GY0 = 1.0, GY1 = 1.5;
const PLANT_SCALE = 1.5;   // 植物は世界の座標より大きめに描く（見やすさのため。判定には関係しない）
function gauge(x, value, band, width, f, bad, next, icon, off, blink) {
  const w = 0.07 * K, gx = sx(x) - w / 2, top = sy(GY0), bot = sy(GY1), hh = bot - top;
  const vy = (v) => bot - Math.max(0, Math.min(1, v)) * hh;
  ctx.fillStyle = 'rgba(20,32,50,0.45)';
  roundRect(gx, top, w, hh, w * 0.35); ctx.fill();
  if (!off) {
    ctx.save();
    roundRect(gx, top, w, hh, w * 0.35); ctx.clip();
    ctx.fillStyle = 'rgba(88,214,110,0.8)';
    const b0 = vy(band + width / 2), b1 = vy(band - width / 2);
    ctx.fillRect(gx, b0, w, b1 - b0);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(gx, vy(value), w, bot - vy(value));
    if (next) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.setLineDash([4, 3]); ctx.lineWidth = 2;
      const n0 = vy(next + width / 2), n1 = vy(next - width / 2);
      ctx.strokeRect(gx + 3, n0, w - 6, n1 - n0);
      ctx.setLineDash([]);
    }
    ctx.restore();
    // 今の量の印
    const my = vy(value), side = x < 0.5 ? -1 : 1, tx = side < 0 ? gx - 2 : gx + w + 2;
    ctx.fillStyle = f >= 1 ? '#ffffff' : '#fff6d8';
    if (f >= 1) { ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = 8; }
    ctx.beginPath(); ctx.moveTo(tx, my); ctx.lineTo(tx + side * 12, my - 8); ctx.lineTo(tx + side * 12, my + 8); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(gx, my - 1.5, w, 3);
  }
  // 枠: 帯の中は緑、少し外れは黄、大きく外れは赤の点滅
  ctx.lineWidth = 3;
  ctx.strokeStyle = off ? 'rgba(255,255,255,0.35)' : f >= 1 ? '#58d66e' : bad ? (blink ? '#ff4d4d' : 'rgba(255,77,77,0.35)') : '#ffd23f';
  roundRect(gx, top, w, hh, w * 0.35); ctx.stroke();
  icon(sx(x), top - 0.035 * K, 0.022 * K);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function sunIcon(x, y, r) {
  ctx.fillStyle = '#ffc93c'; ctx.strokeStyle = '#ffc93c'; ctx.lineWidth = Math.max(2, r * 0.2); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, 7); ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.moveTo(x + Math.cos(a) * r * 0.75, y + Math.sin(a) * r * 0.75);
    ctx.lineTo(x + Math.cos(a) * r * 1.05, y + Math.sin(a) * r * 1.05);
  }
  ctx.stroke();
}
function dropIcon(x, y, r) {
  ctx.fillStyle = '#5ab4f0';
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.05);
  ctx.bezierCurveTo(x + r * 0.2, y - r * 0.5, x + r * 0.8, y, x + r * 0.8, y + r * 0.3);
  ctx.arc(x, y + r * 0.3, r * 0.8, 0, Math.PI);
  ctx.bezierCurveTo(x - r * 0.8, y, x - r * 0.2, y - r * 0.5, x, y - r * 1.05);
  ctx.fill();
}

// 次の時間帯・段階の帯（切り替わる 3 秒前から）
function nextBands(s, clk) {
  const out = { l: null, m: null };
  const p = CONFIG.plants[s.plant];
  if (clk.toNext < 3) {
    const nb = M.bandFor(s.plant, s.stage, (clk.phase + 1) % 4);
    if (clk.phase !== 2) out.l = nb.l;
    if (nb.m !== s.bandGoal.m) out.m = nb.m;
  }
  if (s.stage < 3 && s.speed > 0.01) {
    const eta = ((s.stage + 1) * 25 - s.P) / (p.G * s.speed);
    if (eta < 3) {
      const nb = M.bandFor(s.plant, s.stage + 1, clk.phase);
      if (clk.phase !== 3) out.l = nb.l;
      out.m = nb.m;
    }
  }
  return out;
}

function updateLook(s, clk, dt) {
  const p = CONFIG.plants[s.plant], fall = p.fall || CONFIG.fall;
  const night = clk.phase === 3;
  const dl = night ? 0 : s.L - s.bandL, dm = s.M - s.band.m;
  const out = (d, w) => Math.max(0, Math.min(1, (Math.abs(d) - w / 2) / fall));
  const sun = M.sunAt(clk.u);
  const target = {
    pale: dl < 0 ? out(dl, p.bandL) : 0,
    brown: dl > 0 ? out(dl, p.bandL) : 0,
    droop: dm < 0 ? out(dm, p.bandM) : 0,
    yellow: dm > 0 ? out(dm, p.bandM) : 0,
    puddle: dm > 0 ? out(dm, p.bandM) * 1.2 : 0,
    dull: 1 - s.H,
    lean: 0, wet: s.M,
  };
  target.lean = sun && target.pale > 0 ? Math.sign(sun.x - 0.5) * target.pale : 0;
  const a = Math.min(1, dt * 3);
  for (const key in target) look[key] = (look[key] ?? 0) + (target[key] - (look[key] ?? 0)) * a;
}

function draw(s, playing, dt) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { clk, dark } = drawSky(s);
  drawGround(dark);
  updateDrops(s, dt);
  if (playing) {
    const p = CONFIG.plants[s.plant];
    updateLook(s, clk, dt);
    const scale = 1 + (reduced.matches ? 0 : 0.1 * Math.sin(Math.min(1, pop) * Math.PI));
    ctx.save();
    ctx.translate(sx(0.5), sy(1.45)); ctx.scale(scale, scale); ctx.translate(-sx(0.5), -sy(1.45));
    look.night = dark;
    drawPlant(s.plant, s.P, look, sx(0.5), sy(1.45), K * PLANT_SCALE);
    ctx.restore();
    drawDrops(dark);
    const nb = nextBands(s, clk);
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    const night = clk.phase === 3;
    gauge(0.17, s.L, s.bandL, p.bandL, s.fL, !night && s.fL === 0, nb.l, sunIcon, night, blink);
    gauge(0.83, s.M, s.band.m, p.bandM, s.fM, s.fM === 0, nb.m, dropIcon, false, blink);
  }
  if (!playing) {
    drawDrops(dark);
    drawPlant('tomato', 40, { pale: 0, brown: 0, droop: 0, yellow: 0, dull: 0, lean: 0, puddle: 0, wet: 0.5, night: dark }, sx(0.5), sy(1.45), K * PLANT_SCALE);
  }
  for (const c of s.clouds) drawCloud(c, dark, c.held);
  // 押して止めている間の輪（0.25 秒で雨になる）
  if (playing) {
    for (const pt of pointers.values()) {
      if (pt.mode !== 'pending') continue;
      const k = Math.min(1, (s.t - pt.t0) / HOLD);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(pt.px, pt.py, 28, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); ctx.stroke();
    }
  }
}

// ---- 触る（指 2 本まで。雲ごとに pointerId で持つ） ----
function hitCloud(s, w) {
  let best = -1, br = 1;
  s.clouds.forEach((c, i) => {
    const rx = Math.max(M.cloudRx(c) * 1.2, 22 / K), ry = Math.max(M.cloudRy(c) * 1.2, 22 / K);
    const r = Math.hypot((w.x - c.x) / rx, (w.y - c.y) / ry);
    if (r < br) { br = r; best = i; }
  });
  return best;
}
cv.addEventListener('pointerdown', (e) => {
  unlockAudio();
  if (mode !== 'play' || paused || pointers.size >= 2) return;
  const w = toWorld(e.clientX, e.clientY);
  const ci = hitCloud(g, w);
  if (ci < 0 || [...pointers.values()].some((p) => p.ci === ci)) return;
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
  const c = g.clouds[ci];
  pointers.set(e.pointerId, { ci, ox: c.x - w.x, oy: c.y - w.y, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, t0: g.t, mode: 'pending' });
  c.held = true;
  SFX.grab();
});
cv.addEventListener('pointermove', (e) => {
  const pt = pointers.get(e.pointerId);
  if (!pt || !g) return;
  pt.px = e.clientX; pt.py = e.clientY;
  if (pt.mode === 'pending' && Math.hypot(e.clientX - pt.sx, e.clientY - pt.sy) > 8) pt.mode = 'drag';
  if (pt.mode !== 'pending') {
    const w = toWorld(e.clientX, e.clientY);
    M.moveCloud(g, pt.ci, w.x + pt.ox, w.y + pt.oy);
  }
});
function release(id) {
  const pt = pointers.get(id);
  if (!pt) return;
  pointers.delete(id);
  if (g) { const c = g.clouds[pt.ci]; c.held = false; c.rain = false; }
  SFX.release();
}
cv.addEventListener('pointerup', (e) => release(e.pointerId));
cv.addEventListener('pointercancel', (e) => release(e.pointerId));
function releaseAll() { for (const id of [...pointers.keys()]) release(id); }

// ---- 遊ぶ流れ ----
const show = (el, on) => { el.hidden = !on; };
const fmt = (t) => { const m = Math.floor(t / 60), r = t - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; };
const starText = (n) => '★'.repeat(n) + '<span class="off">' + '★'.repeat(3 - n) + '</span>';

function renderCards() {
  const box = $('plants');
  box.textContent = '';
  for (const id of PLANTS) {
    const p = CONFIG.plants[id], b = best.plants[id];
    const btn = document.createElement('button');
    btn.className = 'plant';
    btn.dataset.plant = id;
    const cvs = document.createElement('canvas');
    cvs.width = 144; cvs.height = 144;
    const body = document.createElement('span');
    body.className = 'plant__body';
    body.innerHTML = `<span class="plant__name">${p.name}${id === 'tomato' ? '<span class="plant__badge">はじめての人に</span>' : ''}</span>`
      + `<span class="plant__level">${p.level} · 雲 ${p.start.length} つ${p.wind ? (p.wind.gust ? ' · 強い風' : ' · 弱い風') : ''}</span>`
      + `<span class="plant__best">${b ? `ベスト ${fmt(b.ms / 1000)} <span class="star">${'★'.repeat(b.stars)}</span>` : 'まだ記録なし'}</span>`;
    btn.append(cvs, body);
    btn.addEventListener('click', () => { SFX.click(); start(id); });
    box.append(btn);
    // 植物の絵はゲームと同じ関数で描く
    const keep = ctx;
    ctx = cvs.getContext('2d');
    try { drawPlant(id, 100, { pale: 0, brown: 0, droop: 0, yellow: 0, dull: 0, lean: 0, puddle: 0, wet: 0.5 }, 72, 128, 330); } finally { ctx = keep; }
  }
}

function showToast(text, ms = 1400) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(showToast.id);
  showToast.id = setTimeout(() => { t.hidden = true; }, ms);
}

function start(id) {
  plantId = id;
  if (!settings.coached) { openCoach(() => start(id)); return; }
  unlockAudio();
  releaseAll();
  g = M.create(id, (Math.random() * 2 ** 31) | 0);
  drops = [];
  look = { pale: 0, brown: 0, droop: 0, yellow: 0, dull: 0, lean: 0, puddle: 0 };
  fitWas = { l: 1, m: 1 }; pingAt = { l: -9, m: -9 };
  rainedOnce = false;
  mode = 'play'; paused = false;
  const p = CONFIG.plants[id];
  $('growLabels').innerHTML = [...p.stages, '実'].map((n, i) => `<span style="left:${i * 25}%">${n}</span>`).join('');
  show($('title'), false); show($('result'), false); show($('pause'), false);
  show($('top'), true); show($('bottom'), true);
  acc = 0;
}

function setPaused(on) {
  if (mode !== 'play' || paused === on) return;
  paused = on;
  if (on) { releaseAll(); rainSound(false); }
  show($('pause'), on);
}

function toTitle() {
  releaseAll(); rainSound(false);
  mode = 'title'; paused = false; g = null;
  show($('pause'), false); show($('result'), false); show($('top'), false); show($('bottom'), false); $('toast').hidden = true;
  renderCards();
  show($('title'), true);
}

const REASON = {
  lightLow: '日差しが足りない時間が長かった',
  lightHigh: '日差しが強すぎた時間が長かった',
  waterLow: '水が足りない時間が長かった',
  waterHigh: '水が多すぎた時間が長かった',
};
let lastShare = '';
function finish() {
  releaseAll(); rainSound(false);
  mode = 'result';
  const p = CONFIG.plants[g.plant];
  const splits = $('resSplits');
  splits.textContent = '';
  if (g.over === 'clear') {
    const stars = M.stars(g.plant, g.t);
    const ms = Math.round(g.t * 1000);
    const old = best.plants[g.plant];
    const isBest = !old || ms < old.ms;
    if (isBest) { best.plants[g.plant] = { ms, stars, splits: g.splits.map((x) => Math.round(x * 1000)) }; save('best', best); }
    $('resKind').textContent = `${p.name}が実った`;
    $('resBig').textContent = fmt(g.t);
    $('resStars').innerHTML = starText(stars);
    $('resStars').hidden = false;
    $('resNote').textContent = isBest && old ? 'ベスト更新' : isBest ? '初めての記録' : `ベスト ${fmt(old.ms / 1000)}`;
    $('resNote').style.color = isBest ? '#2d9a4c' : '';
    const names = [...p.stages.slice(1), '実'];
    g.splits.forEach((t, i) => { const li = document.createElement('li'); li.innerHTML = `${names[i]} <b>${fmt(t)}</b>`; splits.append(li); });
    lastShare = `BLOOMCAST で${p.name}を ${fmt(g.t)} で実らせた ${'★'.repeat(stars)}`;
    SFX.clear();
    if (isBest && old) setTimeout(() => SFX.best(), 900);
  } else {
    $('resKind').textContent = g.over === 'dead' ? `${p.name}が枯れてしまった` : '時間切れ';
    $('resBig').textContent = `${Math.floor(g.P)}% まで`;
    $('resStars').hidden = true;
    $('resNote').textContent = REASON[M.worstMiss(g)];
    $('resNote').style.color = '';
    lastShare = `BLOOMCAST で${p.name}を ${Math.floor(g.P)}% まで育てた`;
    SFX.lose();
  }
  show($('bottom'), false); $('toast').hidden = true;
  show($('result'), true);
  const btns = $('result').querySelectorAll('button');
  btns.forEach((b) => { b.disabled = true; });
  setTimeout(() => btns.forEach((b) => { b.disabled = false; }), 500);
}

// ---- 遊び方（はじめての 3 枚） ----
let coachPage = 0, coachDone = null;
function openCoach(then) {
  coachPage = 0; coachDone = then;
  paintCoach();
  show($('coach'), true);
}
function paintCoach() {
  document.querySelectorAll('.coach__card').forEach((el) => { el.hidden = +el.dataset.card !== coachPage; });
  document.querySelectorAll('#coachDots i').forEach((el, i) => el.classList.toggle('on', i === coachPage));
  $('coachNext').textContent = coachPage < 2 ? '次へ' : coachDone ? 'はじめる' : 'とじる';
}
$('coachNext').addEventListener('click', () => {
  SFX.click();
  if (coachPage < 2) { coachPage++; paintCoach(); return; }
  show($('coach'), false);
  settings.coached = true; save('settings', settings);
  const then = coachDone; coachDone = null;
  if (then) then();
});

// ---- ボタン ----
$('howBtn').addEventListener('click', () => { SFX.click(); openCoach(null); });
function paintSound() {
  $('soundBtn').textContent = settings.sound ? '音 オン' : '音 オフ';
  $('soundBtn').setAttribute('aria-pressed', String(settings.sound));
}
$('soundBtn').addEventListener('click', () => {
  settings.sound = !settings.sound;
  save('settings', settings);
  setAudioSession(settings.sound);
  if (!settings.sound) { rainSound(false); if (actx) actx.suspend(); } else { audio(); SFX.click(); }
  paintSound();
});
$('pauseBtn').addEventListener('click', () => { SFX.click(); setPaused(true); });
$('resumeBtn').addEventListener('click', () => { SFX.click(); setPaused(false); });
$('restartBtn').addEventListener('click', () => { SFX.click(); start(plantId); });
$('quitBtn').addEventListener('click', () => { SFX.click(); toTitle(); });
$('againBtn').addEventListener('click', () => { SFX.click(); start(plantId); });
$('otherBtn').addEventListener('click', () => { SFX.click(); toTitle(); });
$('shareBtn').addEventListener('click', () => { SFX.click(); WebAppKit.share({ text: lastShare, url: 'https://t-of.github.io/bloomcast/' }); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') setPaused(!paused);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
document.addEventListener('pointerdown', unlockAudio, { passive: true });

// ---- 上と下の帯 ----
function hud(s) {
  const clk = M.clock(s);
  $('time').textContent = fmt(s.t);
  $('phase').textContent = `${M.PHASES[clk.phase]} · ${clk.day} 日目`;
  $('dayMark').style.left = `${clk.pos * 100}%`;
  $('growFill').style.width = `${s.P}%`;
  $('growFill').classList.toggle('shine', s.speed >= 0.999);
  document.querySelectorAll('.grow__mark').forEach((el, i) => el.classList.toggle('on', s.P >= i * 25 && i > 0));
  $('healthFill').style.width = `${s.H * 100}%`;
  $('healthFill').style.background = s.H > 0.5 ? '#8fdc6a' : s.H > 0.25 ? '#ffd23f' : '#ff6b5b';
  $('speed').textContent = `はやさ ${Math.round(s.speed * 100)}%`;
}

// 1 ステップごとのできごと（音・文字）
function events(s) {
  for (const e of s.events) {
    if (e.type === 'phase') SFX.phase(e.phase);
    else if (e.type === 'stage') {
      SFX.stage(e.stage); pop = 1;
      showToast(CONFIG.plants[s.plant].stages[e.stage]);
    } else if (e.type === 'bad') SFX.bad();
    else if (e.type === 'empty') SFX.empty();
  }
  // 帯に入った（同じゲージは 2 秒に 1 回まで）
  const night = s.phase === 3;
  for (const [k, f] of [['l', night ? 0 : s.fL], ['m', s.fM]]) {
    if (f >= 1 && fitWas[k] < 1 && s.t - pingAt[k] > 2) { SFX.ping(); pingAt[k] = s.t; }
    fitWas[k] = f;
  }
  if (!hintShown && !rainedOnce && s.M < s.band.m - CONFIG.plants[s.plant].bandM / 2) {
    hintShown = true;
    showToast('雲を押したまま止めると雨が降る', 3200);
  }
}

// ---- ループ（固定刻み 1/60 秒で進め、描くのは画面の速さで） ----
let acc = 0, last = performance.now();
function frame(now) {
  const real = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (mode === 'play' && !paused) {
    acc += real;
    while (acc >= CONFIG.dt && !g.over) {
      for (const pt of pointers.values()) {
        if (pt.mode === 'pending' && g.t - pt.t0 >= HOLD) pt.mode = 'rain';
        g.clouds[pt.ci].rain = pt.mode === 'rain';
      }
      M.step(g);
      events(g);
      acc -= CONFIG.dt;
    }
    if (g.clouds.some(M.raining)) rainedOnce = true;
    rainSound(g.clouds.some(M.raining));
    pop = Math.max(0, pop - real * 2.5);
    hud(g);
    if (g.over) finish();
  } else if (mode === 'title') {
    // タイトルの空: 太陽がゆっくり動き、雲が流れる
    let n = Math.round(real / CONFIG.dt);
    while (n-- > 0) { demo.H = 1; demo.P = 0; M.step(demo); }
    if (demo.t > 280) demo = M.create('strawberry', (Math.random() * 1e9) | 0);
  }
  draw(mode === 'title' ? demo : g, mode !== 'title', mode === 'play' && !paused ? real : 0);
  requestAnimationFrame(frame);
}

paintSound();
renderCards();
requestAnimationFrame(frame);
