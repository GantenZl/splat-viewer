/* ============================================================
   Gaussian Splat Viewer  —  three.js + @mkkellogg/gaussian-splats-3d
   Fully local, offline-ready.
   ============================================================ */
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';

/* ---------- Scene framing ----------
   Provisional values; replaced by autoFrame() once the real splat centers
   are available (data-driven, robust to extreme outliers in the .ply). */
let CENTER = new THREE.Vector3(8.12, -12.44, 1.36);
let UP = new THREE.Vector3(0, -1, 0);   // 3DGS scenes are usually Y-down in view space
let RADIUS = 150;

// A pleasing 3/4 view offset, scaled by the scene radius (pre-load placeholder;
// autoFrame() takes over once real splat data is available).
function framePosition(up) {
  const back = new THREE.Vector3(0.4, 0, 1).normalize().multiplyScalar(RADIUS * 1.15);
  const lift = up.clone().multiplyScalar(RADIUS * 0.42); // elevate toward the sky (+up)
  return CENTER.clone().add(back).add(lift);
}

/* Read the actual splat centers, compute a robust (percentile) bounding box,
   and frame the camera to it. Fixes cases where hardcoded framing misses the
   subject because of far-flung outlier splats. */
function autoFrame() {
  const sm = viewer && viewer.splatMesh;
  if (!sm || !sm.getSplatCount) return;
  const count = sm.getSplatCount();
  if (!count) return;

  const step = Math.max(1, Math.floor(count / 60000)); // sample up to ~60k splats
  const xs = [], ys = [], zs = [];
  const c = new THREE.Vector3();
  for (let i = 0; i < count; i += step) {
    sm.getSplatCenter(i, c, true);
    if (!isFinite(c.x) || !isFinite(c.y) || !isFinite(c.z)) continue;
    xs.push(c.x); ys.push(c.y); zs.push(c.z);
  }
  if (xs.length < 8) return;
  const pct = (arr, p) => { const a = arr.slice().sort((m, n) => m - n); return a[Math.floor((a.length - 1) * p)]; };
  const lo = new THREE.Vector3(pct(xs, 0.02), pct(ys, 0.02), pct(zs, 0.02));
  const hi = new THREE.Vector3(pct(xs, 0.98), pct(ys, 0.98), pct(zs, 0.98));

  CENTER = lo.clone().add(hi).multiplyScalar(0.5);
  const size = hi.clone().sub(lo);                    // robust extents
  RADIUS = 0.5 * size.length();
  if (!(RADIUS > 0) || !isFinite(RADIUS)) RADIUS = 150;

  // Vertical axis = the thinnest extent (scenes are flat in the up direction).
  const ext = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)];
  const thin = ext.indexOf(Math.min(...ext));
  const sign = UP.toArray()[thin] <= 0 ? -1 : 1;      // keep current polarity if set
  UP.set(0, 0, 0); UP.setComponent(thin, sign || -1);

  // Distance to fit the sphere of radius RADIUS in the vertical FOV, with margin.
  const fitDist = (RADIUS / Math.tan((camera.fov * Math.PI / 180) / 2)) * 1.25;
  const back = new THREE.Vector3(0.4, 0, 1).normalize().multiplyScalar(fitDist);
  const lift = UP.clone().multiplyScalar(fitDist * 0.42);  // elevate toward the sky (+UP)
  camera.position.copy(CENTER).add(back).add(lift);
  camera.up.copy(UP);
  camera.near = Math.max(0.01, RADIUS * 0.002);
  camera.far = RADIUS * 40;
  camera.updateProjectionMatrix();

  if (viewer.controls) {
    viewer.controls.target.copy(CENTER);
    viewer.controls.minDistance = RADIUS * 0.15;
    viewer.controls.maxDistance = RADIUS * 12;
    viewer.controls.update();
  }
  console.log('[autoFrame] center', CENTER.toArray().map(n => +n.toFixed(2)),
              '| robust size', size.toArray().map(n => +n.toFixed(2)),
              '| radius', +RADIUS.toFixed(2), '| up', UP.toArray(),
              '| camDist', +fitDist.toFixed(2), '| splats', count, '| sampled', xs.length);
}

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const loaderEl = $('loader');
const loaderFill = $('loaderFill');
const loaderPct = $('loaderPct');
const loaderSub = $('loaderSub');
const toastEl = $('toast');

/* ---------- Device detection ---------- */
const IS_MOBILE = (() => {
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent);
  const smallish = Math.min(window.innerWidth, window.innerHeight) <= 820;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  return uaMobile || (coarse && touch && smallish);
})();
// Cap resolution: high-DPR phones can't afford rendering 600k splats at 3× — it
// tanks the framerate. 1.5× on mobile stays crisp while keeping it smooth.
const MAX_DPR = IS_MOBILE ? 1.5 : 2;

/* ---------- Renderer / camera (we own them for full control) ---------- */
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,                 // let the CSS studio backdrop show through
  preserveDrawingBuffer: true, // enables clean screenshots
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
renderer.setSize(window.innerWidth, window.innerHeight);
viewport.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6000);
camera.position.copy(framePosition(UP));
camera.up.copy(UP);

/* ---------- Viewer ---------- */
let viewer = null;

// Compact .ksplat variants (converted from the 148 MB source .ply). Smaller =
// faster to download (important over tunnels / slow links) and quicker to parse.
const QUALITY = [
  { file: 'splat_30000_sh1.ksplat', deg: 1, size: '24MB', meta: '611,290 splats · 1° SH 均衡', tip: '均衡 (24MB)' },
  { file: 'splat_30000_sh0.ksplat', deg: 0, size: '14MB', meta: '611,290 splats · 极速',      tip: '极速 (14MB)' },
];
// SH2 (42MB) is hosted separately (Cloudflare R2, etc.) — Pages caps single files at 25MB.
let currentQuality = 0;

function buildViewer(shDegree) {
  const v = new GaussianSplats3D.Viewer({
    renderer,
    camera,
    rootElement: viewport,
    useBuiltInControls: true,
    selfDrivenMode: true,
    dynamicScene: false,
    sharedMemoryForWorkers: false,   // avoids needing COOP/COEP headers
    gpuAcceleratedSort: false,       // CPU/WASM sort: most compatible, no silent GPU-sort failures
    enableSIMDInSort: true,
    integerBasedSort: true,
    antialiased: true,
    focalAdjustment: 1.0,
    cameraUp: [UP.x, UP.y, UP.z],
    initialCameraPosition: [camera.position.x, camera.position.y, camera.position.z],
    initialCameraLookAt: [CENTER.x, CENTER.y, CENTER.z],
    sphericalHarmonicsDegree: shDegree,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    logLevel: GaussianSplats3D.LogLevel.None,
  });
  return v;
}

function tuneControls() {
  const c = viewer.controls;
  if (!c) return;
  c.enableDamping = true;
  c.dampingFactor = 0.06;
  c.rotateSpeed = 0.7;
  c.zoomSpeed = 0.9;
  c.panSpeed = 0.7;
  c.minDistance = 12;
  c.maxDistance = 900;
  c.autoRotateSpeed = 0.9;
  c.autoRotate = autoRotate;
  c.target.copy(CENTER);
  c.update();
}

/* ---------- Load scene ---------- */
function loadScene() {
  return viewer.addSplatScene('./assets/' + QUALITY[currentQuality].file, {
    showLoadingUI: false,            // we render our own overlay
    progressiveLoad: false,          // download fully (progress bar), then reveal complete — no piecemeal "growing in"
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    onProgress: (pct) => {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      loaderFill.style.width = p + '%';
      loaderPct.textContent = p + '%';
      loaderSub.textContent = p < 100 ? '流式加载高斯基元…' : '完成';
    },
  });
}

async function start() {
  try {
    $('brandMeta').textContent = QUALITY[currentQuality].meta;
    viewer = buildViewer(QUALITY[currentQuality].deg);
    loaderSub.textContent = '连接模型数据…';
    await loadScene();
    tuneControls();
    autoFrame();          // data-driven camera framing from real splat centers
    viewer.start();
    onLoaded();
  } catch (err) {
    console.error(err);
    loaderSub.textContent = '加载失败：' + (err && err.message ? err.message : err);
    loaderSub.style.color = '#d9534f';
  }
}

function onLoaded() {
  loaderEl.classList.add('is-hidden');
  // The library can size the renderer before layout settles → force a correct
  // resize now, and again on the next frames, so the canvas is never 0×0.
  onResize();
  requestAnimationFrame(onResize);
  setTimeout(onResize, 200);
  window.addEventListener('resize', onResize);
  // Reveal the hint chip briefly.
  const hint = $('hint');
  hint.classList.add('is-show');
  setTimeout(() => hint.classList.add('is-fade'), 4200);
  window.__V = { viewer, renderer, camera, CENTER, autoFrame,
    dump() { autoFrame(); return { center: CENTER.toArray(), radius: RADIUS, up: UP.toArray(),
      cam: camera.position.toArray(), splats: viewer.splatMesh && viewer.splatMesh.getSplatCount() }; } };
}

/* ---------- Rebuild with a new SH degree (quality toggle) ---------- */
async function rebuild() {
  loaderEl.classList.remove('is-hidden');
  loaderFill.style.width = '0%';
  loaderPct.textContent = '0%';
  const camPos = camera.position.clone();
  const target = viewer.controls ? viewer.controls.target.clone() : CENTER.clone();
  try { viewer.stop(); } catch (e) {}
  try { await viewer.dispose(); } catch (e) {}
  viewer = buildViewer(QUALITY[currentQuality].deg);
  await loadScene();
  tuneControls();
  camera.position.copy(camPos);
  viewer.controls.target.copy(target);
  camera.up.copy(UP);
  viewer.controls.update();
  viewer.start();
  loaderEl.classList.add('is-hidden');
}

/* ---------- Resize ---------- */
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
}

/* ============================================================
   UI wiring
   ============================================================ */
let autoRotate = true;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('is-show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('is-show'), 1600);
}

/* Auto-rotate */
$('btnRotate').addEventListener('click', () => {
  autoRotate = !autoRotate;
  if (viewer && viewer.controls) viewer.controls.autoRotate = autoRotate;
  $('btnRotate').classList.toggle('is-active', autoRotate);
  toast(autoRotate ? '自动旋转：开' : '自动旋转：关');
});

/* Flip up axis */
$('btnFlip').addEventListener('click', () => {
  UP.multiplyScalar(-1);
  camera.up.copy(UP);
  if (viewer && viewer.controls) viewer.controls.update();
  toast('已翻转上下朝向');
});

/* Reset view — re-frame from the real data so it always matches the load view */
function resetView() {
  autoFrame();
  toast('视角已重置');
}
$('btnReset').addEventListener('click', resetView);

/* Theme toggle */
$('btnTheme').addEventListener('click', () => {
  const b = document.body;
  const next = b.dataset.theme === 'studio' ? 'gallery' : 'studio';
  b.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', next === 'studio' ? '#eef2f7' : '#000000');
  toast(next === 'studio' ? '明亮工作室' : '暗色画廊');
});

/* Quality cycle: switches between the three .ksplat variants (均衡 → 极速 → 高清) */
$('btnQuality').addEventListener('click', async () => {
  currentQuality = (currentQuality + 1) % QUALITY.length;
  $('brandMeta').textContent = QUALITY[currentQuality].meta;
  toast('画质：' + QUALITY[currentQuality].tip);
  await rebuild();
});

/* Screenshot */
$('btnShot').addEventListener('click', () => {
  try {
    renderer.render(viewer.threeScene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gaussian-splat-' + Date.now() + '.png';
    a.click();
    toast('已保存截图');
  } catch (e) {
    toast('截图失败');
  }
});

/* Fullscreen */
$('btnFull').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});

/* About modal */
$('infoBtn').addEventListener('click', () => $('modal').hidden = false);
$('modalClose').addEventListener('click', () => $('modal').hidden = true);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').hidden = true; });

/* Keyboard shortcuts */
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.key.toLowerCase()) {
    case 'r': $('btnRotate').click(); break;
    case 'f': $('btnFlip').click(); break;
    case ' ': e.preventDefault(); resetView(); break;
    case 'b': $('btnTheme').click(); break;
    case 'p': $('btnShot').click(); break;
    case 'enter': $('btnFull').click(); break;
    case 'escape': $('modal').hidden = true; break;
  }
});

/* Pause auto-rotate while the user is actively dragging, resume after idle */
let idleTimer = null;
viewport.addEventListener('pointerdown', () => {
  if (viewer && viewer.controls) viewer.controls.autoRotate = false;
  clearTimeout(idleTimer);
});
viewport.addEventListener('pointerup', () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (autoRotate && viewer && viewer.controls) viewer.controls.autoRotate = true;
  }, 2500);
});

/* Go */
start();
