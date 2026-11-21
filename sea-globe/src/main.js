import Globe from 'globe.gl';
import searoute from 'searoute-js';
import { feature } from 'topojson-client';
import { geoCentroid, geoArea, geoDistance } from 'd3-geo';
import world from 'world-atlas/countries-110m.json';
import './style.css';

const U = (f) => import.meta.env.BASE_URL + f; // برای دیپلوی بعداً
const isTouch = matchMedia('(pointer: coarse)').matches;

// ---------- استایل پین‌ها، شناگر و HUD ----------
const css = document.createElement('style');
css.textContent = `
  .pin, .swimmer { position: relative; pointer-events: none; }
  .pin .dot { position:absolute; left:-9px; top:-9px; width:18px; height:18px;
    border-radius:50%; border:3px solid #fff; background:var(--c);
    box-shadow:0 0 14px var(--c); }
  .pin .tag { position:absolute; left:50%; bottom:16px; transform:translateX(-50%);
    white-space:nowrap; padding:3px 10px; border-radius:999px; font:12px system-ui;
    color:#fff; background:rgba(5,8,22,.88); border:1px solid var(--c); }
  .pin .tag b { color: var(--c); letter-spacing:.05em; }
  .swimmer { font-size:22px; line-height:1; transform:translate(-50%,-50%);
    filter: drop-shadow(0 0 6px #00e5ff); }

  #hud { position:fixed; left:0; right:0; z-index:10; display:flex;
    flex-direction:column; align-items:center; gap:10px; padding:0 12px;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 18px); pointer-events:none; }
  @media (pointer: fine) { #hud { bottom: 64px; } }
  #info { pointer-events:none; padding:10px 16px; border-radius:18px;
    background:rgba(5,8,22,.85); color:#e6f6ff; font:15px/1.35 system-ui;
    max-width:min(92vw,560px); text-align:center; }
  #go { pointer-events:auto; display:none; min-height:48px; padding:12px 28px;
    border:0; border-radius:999px; font:700 16px system-ui; color:#05121f;
    cursor:pointer; background:linear-gradient(90deg,#ffd54a,#ff4d6d);
    box-shadow:0 0 22px rgba(255,120,100,.55); }
  #go:active { transform: scale(.97); }
`;
document.head.append(css);

// ---------- دیتای کشورها ----------
const countries = feature(world, world.objects.countries).features;
const labelData = countries
  .map((f) => {
    const [lng, lat] = geoCentroid(f);
    return { name: f.properties.name, lat, lng, area: geoArea(f) };
  })
  .sort((a, b) => b.area - a.area);
const TIERS = isTouch ? [20, 50, 90] : [30, 70, labelData.length];

const GREENS = ['#2f8f4e', '#3a9d5a', '#2a7f45', '#46a862'];
const greenFor = (name = '') =>
  GREENS[[...name].reduce((s, c) => s + c.charCodeAt(0), 0) % GREENS.length];

// ---------- کمکی‌ها ----------
const norm = (lng) => ((lng + 540) % 360) - 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// فاصله‌ی دوربین بر اساس نسبت صفحه، تا توی حالت عمودی کره بریده نشه
const baseAlt = () => Math.max(2.5, 1.2 / (0.4663 * (innerWidth / innerHeight)) - 1);
const ALT_OVERVIEW = () => Math.max(2.2, baseAlt() * 0.9);
const ALT_FOLLOW = () => Math.max(1.6, baseAlt() * 0.65);

// جلوگیری از پرش مسیر موقع رد شدن از خط تاریخ
function unwrap(coords) {
  const out = [coords[0].slice()];
  for (let i = 1; i < coords.length; i++) {
    let [x, y] = coords[i];
    const prev = out[i - 1][0];
    while (x - prev > 180) x -= 360;
    while (x - prev < -180) x += 360;
    out.push([x, y]);
  }
  return out;
}
// نرم کردن گوشه‌ها (Chaikin)
function smooth(pts, iterations = 2) {
  for (let k = 0; k < iterations; k++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      out.push(
        [0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1],
        [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1],
      );
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
const toPoint = (p) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
});
const fmtSwim = (km) => {
  const days = km / 3 / 24; // شنای بی‌وقفه با ۳ کیلومتر در ساعت
  return days > 365 ? `${(days / 365).toFixed(1)} years` : `${Math.round(days)} days`;
};
// طول تجمعی مسیر، برای حرکت با سرعت یکنواخت
function buildPlan(coords, km) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + geoDistance(coords[i - 1], coords[i]) * 6371);
  }
  return { coords, cum, total: cum[cum.length - 1], km, sharks: Math.max(1, Math.round(km / 500)) };
}

// ---------- وضعیت ----------
let points = [];
let phase = 'idle'; // idle | one | ready | swimming | done
let plan = null;
let anim = null;
let following = false;
let hovered = null;
let downPos = null;
let dragged = false;
let resumeTimer;
let lastUI = 0;
let lastPick = 0;
const swimmer = { kind: 'swimmer', lat: 0, lng: 0 };
const htmlItems = () => [
  ...points,
  ...(phase === 'swimming' || phase === 'done' ? [swimmer] : []),
];

// ---------- کره ----------
const globe = Globe()(document.getElementById('app'))
  .bumpImageUrl(U('earth-topology.png'))
  .backgroundImageUrl(U('night-sky.png'))
  .atmosphereColor('#4da6ff')
  .atmosphereAltitude(0.2);

globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
globe.globeMaterial().color.set('#0a2f5c'); // اقیانوس آبی سیر
globe.pointOfView({ lat: 30, lng: 20, altitude: baseAlt() });

// هم‌اندازه شدن با صفحه (چرخوندن گوشی و تغییر سایز)
const fit = () => globe.width(innerWidth).height(innerHeight);
fit();
addEventListener('resize', fit);
matchMedia('(orientation: portrait)').addEventListener('change', () => {
  setTimeout(() => {
    fit();
    const p = globe.pointOfView();
    globe.pointOfView({ lat: p.lat, lng: p.lng, altitude: baseAlt() }, 0);
  }, 250);
});

// کشورها
globe
  .polygonsData(countries)
  .polygonCapColor((d) => (d === hovered ? '#ffd54a' : greenFor(d.properties.name)))
  .polygonSideColor(() => 'rgba(0,0,0,0)')
  .polygonStrokeColor(() => 'rgba(255,255,255,0.4)')
  .polygonAltitude(0.006)
  .polygonsTransitionDuration(0)
  .polygonLabel(
    ({ properties: p }) => `<div style="font:600 14px system-ui;padding:2px 6px">${p.name}</div>`,
  )
  .onPolygonHover((d) => {
    hovered = d;
    globe.polygonCapColor(globe.polygonCapColor()); // فقط رنگ دوباره محاسبه می‌شه
  })
  .onPolygonClick((d, _e, c) => c && pick(c.lat, c.lng, d.properties.name))
  .onGlobeClick(({ lat, lng }) => pick(lat, lng, 'open sea'));

// اسم کشورها: هرچی بیشتر زوم کنی، بیشتر می‌شن
globe
  .labelLat('lat')
  .labelLng('lng')
  .labelText('name')
  .labelSize(0.55)
  .labelDotRadius(0)
  .labelColor(() => 'rgba(255,255,255,0.9)')
  .labelResolution(1.5)
  .labelAltitude(0.012)
  .labelsData(labelData.slice(0, TIERS[0]));

let tier = 0;
globe.onZoom(({ altitude }) => {
  const t = altitude > 2.2 ? 0 : altitude > 1.4 ? 1 : 2;
  if (t === tier) return;
  tier = t;
  globe.labelsData(labelData.slice(0, TIERS[t]));
});

// پین‌ها و شناگر
globe
  .htmlElementsData([])
  .htmlLat('lat')
  .htmlLng('lng')
  .htmlAltitude(0.012)
  .htmlElement((d) => {
    const el = document.createElement('div');
    if (d.kind === 'swimmer') {
      el.className = 'swimmer';
      el.textContent = '🏊';
      return el;
    }
    el.className = 'pin';
    el.style.setProperty('--c', d.color);
    el.innerHTML = `<div class="dot"></div><div class="tag"><b>${d.label}</b> ${d.name}</div>`;
    return el;
  });

// حلقه‌های پالس
globe
  .ringsData([])
  .ringColor((d) => (t) => `${d.color}${Math.round((1 - t) * 255).toString(16).padStart(2, '0')}`)
  .ringMaxRadius(3)
  .ringPropagationSpeed(2)
  .ringRepeatPeriod(1200);

// مسیر: پیش‌نمایش محو + هاله‌ی نورانی + هسته‌ی جاری
globe
  .pathsData([])
  .pathPoints('coords')
  .pathPointLat((p) => p[1])
  .pathPointLng((p) => p[0])
  .pathPointAlt(0.012)
  .pathColor((d) =>
    d.kind === 'ghost'
      ? ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.22)']
      : d.kind === 'glow'
        ? ['rgba(255,213,74,0.25)', 'rgba(255,77,109,0.25)']
        : ['#ffd54a', '#ff4d6d'],
  )
  .pathStroke((d) => ({ ghost: 0.25, glow: 1.4, core: 0.35 })[d.kind])
  .pathDashLength((d) => (d.kind === 'core' ? 0.05 : 1))
  .pathDashGap((d) => (d.kind === 'core' ? 0.025 : 0))
  .pathDashAnimateTime((d) => (d.kind === 'core' ? 7000 : 0))
  .pathTransitionDuration(0);

const showPaths = (partial) =>
  globe.pathsData([
    { kind: 'ghost', coords: plan.coords },
    ...(partial && partial.length > 1
      ? [{ kind: 'glow', coords: partial }, { kind: 'core', coords: partial }]
      : []),
  ]);

// ---------- کنترل‌ها ----------
const controls = globe.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.4;
controls.addEventListener('start', () => {
  controls.autoRotate = false;
  following = false; // به کره دست بزنی، دوربین دیگه شناگر رو دنبال نمی‌کنه
  clearTimeout(resumeTimer);
});
controls.addEventListener('end', () => {
  if (phase === 'swimming') return;
  resumeTimer = setTimeout(() => (controls.autoRotate = true), 4000);
});

// تشخیص تپ از درگ و پینچ
const canvas = globe.renderer().domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (e.isPrimary) {
    downPos = [e.clientX, e.clientY];
    dragged = false;
  } else {
    dragged = true; // انگشت دوم = پینچ، نه تپ
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!e.isPrimary || !downPos) return;
  if (Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > (isTouch ? 14 : 10)) dragged = true;
});
canvas.addEventListener('pointerup', (e) => {
  if (e.isPrimary) downPos = null;
});
canvas.addEventListener('pointercancel', () => (downPos = null));

// ---------- HUD: پیام و دکمه ----------
const hud = document.createElement('div');
hud.id = 'hud';
const info = document.createElement('div');
info.id = 'info';
info.textContent = 'Tap the globe to set your start point';
const go = document.createElement('button');
go.id = 'go';
hud.append(go, info);
document.body.append(hud);

function syncButton() {
  go.style.display = phase === 'ready' || phase === 'swimming' || phase === 'done' ? 'block' : 'none';
  go.textContent =
    phase === 'ready' ? '🏊 Start swimming' : phase === 'swimming' ? '⏹ Cancel' : '🔁 Swim again';
}
go.addEventListener('click', () => {
  if (phase === 'swimming') return reset();
  startSwim();
});

function reset() {
  points = [];
  plan = null;
  anim = null;
  phase = 'idle';
  following = false;
  globe.pathsData([]).htmlElementsData([]).ringsData([]);
  info.textContent = 'Tap the globe to set your start point';
  syncButton();
}

// ---------- شنا ----------
function positionAt(f) {
  const target = f * plan.total;
  let i = anim.seg;
  while (i < plan.cum.length - 2 && plan.cum[i + 1] < target) i++;
  anim.seg = i;
  const span = plan.cum[i + 1] - plan.cum[i] || 1;
  const r = clamp((target - plan.cum[i]) / span, 0, 1);
  const A = plan.coords[i];
  const B = plan.coords[i + 1];
  return { i, pt: [A[0] + (B[0] - A[0]) * r, A[1] + (B[1] - A[1]) * r] };
}

function startSwim() {
  if (!plan) return;
  phase = 'swimming';
  following = false;
  controls.autoRotate = false;
  clearTimeout(resumeTimer);

  const first = plan.coords[0];
  swimmer.lat = first[1];
  swimmer.lng = norm(first[0]);
  anim = {
    t0: performance.now() + 1100, // اول دوربین می‌ره سمت مبدا
    dur: clamp(plan.km / 800, 8, 22) * 1000,
    seg: 0,
  };
  globe.pointOfView({ lat: first[1], lng: norm(first[0]), altitude: ALT_FOLLOW() }, 1000);
  setTimeout(() => {
    if (phase === 'swimming') following = true;
  }, 1000);

  showPaths(null);
  globe.htmlElementsData(htmlItems());
  info.textContent = '🏊 Swimming... watch out for sharks';
  syncButton();
}

function finish() {
  phase = 'done';
  following = false;
  showPaths(plan.coords);
  const [a, b] = points;
  info.textContent =
    `Made it! ${a.name} → ${b.name}: ${Math.round(plan.km).toLocaleString()} km, ` +
    `${fmtSwim(plan.km)}, ${plan.sharks} shark encounters survived 🦈🎉`;
  const mid = plan.coords[Math.floor(plan.coords.length / 2)];
  globe.pointOfView({ lat: mid[1], lng: norm(mid[0]), altitude: ALT_OVERVIEW() }, 1200);
  syncButton();
}

function tick(ts) {
  if (phase === 'swimming' && anim && ts >= anim.t0) {
    const f = clamp((ts - anim.t0) / anim.dur, 0, 1);
    const { i, pt } = positionAt(f);
    swimmer.lng = norm(pt[0]);
    swimmer.lat = pt[1];
    globe.htmlElementsData(htmlItems());

    if (following) {
      const pov = globe.pointOfView();
      globe.pointOfView({ lat: swimmer.lat, lng: swimmer.lng, altitude: pov.altitude }, 0);
    }
    if (ts - lastUI > 60 || f >= 1) {
      lastUI = ts;
      showPaths([...plan.coords.slice(0, i + 1), pt]);
      const swum = f * plan.km;
      const sharks = Math.floor(f * plan.sharks);
      info.textContent =
        `🏊 ${Math.round(swum).toLocaleString()} km swum · ${fmtSwim(swum)} · ` +
        `${sharks} shark${sharks === 1 ? '' : 's'} dodged 🦈`;
    }
    if (f >= 1) finish();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- انتخاب مبدا و مقصد ----------
function pick(lat, lng, name) {
  if (dragged || phase === 'swimming') return;
  const now = performance.now();
  if (now - lastPick < 80) return; // جلوگیری از ثبت دوبل یک تپ
  lastPick = now;
  if (points.length === 2) reset();

  const first = points.length === 0;
  points.push({
    kind: 'pin', lat, lng, name,
    label: first ? 'START' : 'END',
    color: first ? '#ffd54a' : '#ff4d6d',
  });
  globe.htmlElementsData(htmlItems()).ringsData(points);

  if (first) {
    phase = 'one';
    info.textContent = `Start: ${name}. Now tap the destination`;
    return;
  }

  try {
    const [a, b] = points;
    const sr = searoute(toPoint(a), toPoint(b), 'kilometers');
    const km = sr.properties.length;
    if (km < 1) {
      points.pop();
      globe.htmlElementsData(htmlItems()).ringsData(points);
      info.textContent = 'Those two points are too close. Pick another destination';
      return;
    }
    const raw = [[a.lng, a.lat], ...sr.geometry.coordinates, [b.lng, b.lat]];
    plan = buildPlan(smooth(unwrap(raw), 2), km);
    phase = 'ready';
    showPaths(null);

    const mid = plan.coords[Math.floor(plan.coords.length / 2)];
    globe.pointOfView({ lat: mid[1], lng: norm(mid[0]), altitude: ALT_OVERVIEW() }, 1200);

    info.textContent =
      `${a.name} → ${b.name}: ${Math.round(km).toLocaleString()} km ` +
      `(about ${fmtSwim(km)} of swimming). Tap Start!`;
    syncButton();
  } catch (err) {
    console.error(err);
    plan = null;
    phase = 'one';
    info.textContent = 'Route error: ' + err.message;
  }
}