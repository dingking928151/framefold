import { loadScenes } from './scenes.js';
import {
  encodeChallenge, decodeChallenge, buildShareURL,
  countCodePoints, clampTitle, MIN_CROP, MAX_TITLE,
} from './share.js';
import { SoundKit } from './audio.js';

const $ = (id) => document.getElementById(id);
const sound = new SoundKit();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const viewport = $('viewport');
const film = $('film');
const filmImg = $('filmImg');
const pinsEl = $('pins');
const cropOverlay = $('cropOverlay');
const cropRectEl = $('cropRect');
const preview = $('preview');
const previewFilm = $('previewFilm');
const previewImg = $('previewImg');

const state = {
  scenes: [],
  assets: new Map(),
  mode: 'guess',
  levelIndex: 0,
  scene: null,
  challenge: null,
  rect: { x: 0, y: 0, w: 1200, h: 720 },
  vote: null,
  judge: null,
  activeClue: -1,
  gridOn: false,
};

let animToken = 0;
let drag = null;
let toastTimer = 0;

/* ---------- 取景渲染 ---------- */

function applyView(filmEl, rect, W, H, scene) {
  const base = W / scene.width;
  const k = Math.min(W / rect.w, H / rect.h) / base;
  // 布局尺寸跟随 zoom(上限为源光栅分辨率),避免合成层低分辨率纹理被 transform 放大发糊
  const lk = Math.min(k, (scene.raster || 2) / base);
  const s = k / lk;
  const tx = (W - rect.w * base * k) / 2 - rect.x * base * k;
  const ty = (H - rect.h * base * k) / 2 - rect.y * base * k;
  filmEl.style.width = W * lk + 'px';
  filmEl.style.height = H * lk + 'px';
  filmEl.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  filmEl.style.setProperty('--inv', String(1 / k));
  filmEl.style.clipPath = `inset(${rect.y / scene.height * 100}% ${(scene.width - rect.x - rect.w) / scene.width * 100}% ${(scene.height - rect.y - rect.h) / scene.height * 100}% ${rect.x / scene.width * 100}%)`;
}

function applyRect(rect) {
  state.rect = rect;
  const W = viewport.clientWidth;
  const H = viewport.clientHeight;
  if (W > 0 && state.scene) applyView(film, rect, W, H, state.scene);
  $('metaFocal').textContent = Math.round(35 * state.scene.width / rect.w) + 'mm';
  if (state.mode === 'create') updateCreateUI();
}

const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

function animateTo(target, dur, ease, done) {
  const id = ++animToken;
  if (reduceMotion || dur <= 0) {
    applyRect({ ...target });
    if (done) done();
    return;
  }
  const from = { ...state.rect };
  const t0 = performance.now();
  const step = (now) => {
    if (id !== animToken) return;
    const p = Math.min(1, (now - t0) / dur);
    const e = ease(p);
    applyRect({
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
      w: from.w + (target.w - from.w) * e,
      h: from.h + (target.h - from.h) * e,
    });
    if (p < 1) requestAnimationFrame(step);
    else if (done) done();
  };
  requestAnimationFrame(step);
}

function fullRect(scene) {
  return { x: 0, y: 0, w: scene.width, h: scene.height };
}

/* ---------- 资源 ---------- */

function rasterize(url, scene) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const rs = scene.raster || 2;
        const c = document.createElement('canvas');
        c.width = scene.width * rs;
        c.height = scene.height * rs;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch {
        resolve(url);
      }
    };
    img.onerror = () => reject(new Error('插画加载失败'));
    img.src = url;
  });
}

/* ---------- 通用 UI ---------- */

function toast(msg, tone = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + tone;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function flash() {
  const el = $('flash');
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
}

function setHint(text) {
  $('stageHint').textContent = text;
}

function scrollToStage() {
  if (window.matchMedia('(max-width: 900px)').matches) {
    viewport.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }
}

function showPanel(id) {
  for (const p of ['panelGuess', 'panelReveal', 'panelCreate', 'panelError']) {
    $(p).hidden = p !== id;
  }
}

function focusPull() {
  filmImg.classList.remove('focuspull');
  void filmImg.offsetWidth;
  filmImg.classList.add('focuspull');
}

function setSceneImage(scene) {
  const url = state.assets.get(scene.id);
  filmImg.src = url;
  previewImg.src = url;
}

function buildLevelNav() {
  const nav = $('levelNav');
  nav.textContent = '';
  state.scenes.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'level-btn';
    b.textContent = String(i + 1).padStart(2, '0');
    b.setAttribute('aria-label', `第 ${i + 1} 关`);
    b.addEventListener('click', () => { sound.tick(); enterGuess(i); });
    nav.appendChild(b);
  });
}

function markLevelNav(i) {
  [...$('levelNav').children].forEach((b, j) => b.classList.toggle('active', j === i));
}

/* ---------- 猜题 ---------- */

function enterGuess(i) {
  animToken++;
  state.mode = 'guess';
  state.levelIndex = i;
  state.challenge = null;
  state.vote = null;
  state.judge = null;
  state.activeClue = -1;
  state.scene = state.scenes[i];
  setSceneImage(state.scene);
  pinsEl.textContent = '';
  cropOverlay.hidden = true;
  $('stageBar').hidden = true;
  $('challengeBadge').hidden = true;
  $('metaScene').textContent = 'SCENE ' + String(i + 1).padStart(2, '0');
  $('metaRect').textContent = '';
  markLevelNav(i);
  buildGuessPanel();
  showPanel('panelGuess');
  applyRect({ ...state.scene.crop });
  focusPull();
  setHint('局部 · 等待你的判断');
  scrollToStage();
}

function enterChallenge(c, scene, passed) {
  animToken++;
  state.mode = 'guess';
  state.challenge = c;
  state.scene = scene;
  state.vote = null;
  state.judge = null;
  state.activeClue = -1;
  setSceneImage(scene);
  pinsEl.textContent = '';
  cropOverlay.hidden = true;
  $('stageBar').hidden = true;
  $('challengeBadge').hidden = false;
  $('metaScene').textContent = 'CHALLENGE';
  $('metaRect').textContent = '';
  markLevelNav(-1);
  buildGuessPanel();
  showPanel('panelGuess');
  applyRect({ x: c.x, y: c.y, w: c.w, h: c.h });
  focusPull();
  setHint('朋友的局部 · 先判断再揭晓');
  scrollToStage();
  if (passed) toast('把设备交给下一位:先猜,再拉开取景框', 'info');
}

function buildGuessPanel() {
  const scene = state.scene;
  const choices = $('choices');
  choices.textContent = '';
  $('guessQuestion').textContent = scene.question;
  if (state.challenge) {
    $('guessKicker').textContent = '朋友的挑战 · 只看局部';
    $('authorQuote').hidden = false;
    $('authorTitle').textContent = state.challenge.t;
    $('guessNote').textContent = '先判断你信不信这个标题,再拉开取景框看全景。';
    const opts = [
      { letter: '信', text: '画面就是这样', cls: 'judge-yes', val: true },
      { letter: '疑', text: '框外另有真相', cls: 'judge-no', val: false },
    ];
    for (const o of opts) {
      const b = document.createElement('button');
      b.className = 'choice ' + o.cls;
      const l = document.createElement('span');
      l.className = 'letter';
      l.textContent = o.letter;
      const t = document.createElement('span');
      t.className = 'title';
      t.textContent = o.text;
      b.append(l, t);
      b.addEventListener('click', () => castJudge(o.val, b));
      choices.appendChild(b);
    }
  } else {
    $('guessKicker').textContent = `第 ${String(state.levelIndex + 1).padStart(2, '0')} 关 · 只看局部`;
    $('authorQuote').hidden = true;
    $('guessNote').textContent = '两个标题都来自画面里真实可见的证据。选一个你相信的,然后拉开取景框。';
    scene.choices.forEach((title, i) => {
      const b = document.createElement('button');
      b.className = 'choice';
      const l = document.createElement('span');
      l.className = 'letter';
      l.textContent = String.fromCharCode(65 + i);
      const t = document.createElement('span');
      t.className = 'title';
      t.textContent = title;
      b.append(l, t);
      b.addEventListener('click', () => castVote(i, b));
      choices.appendChild(b);
    });
  }
}

function lockChoices(pickedBtn) {
  for (const b of $('choices').children) {
    b.disabled = true;
    if (b === pickedBtn) b.classList.add('picked');
  }
}

function castVote(i, btn) {
  if (state.mode !== 'guess' || state.challenge) return;
  state.vote = i;
  lockChoices(btn);
  sound.shutter();
  flash();
  setTimeout(doReveal, reduceMotion ? 60 : 420);
}

function castJudge(val, btn) {
  if (state.mode !== 'guess' || !state.challenge) return;
  state.judge = val;
  lockChoices(btn);
  sound.shutter();
  flash();
  setTimeout(doReveal, reduceMotion ? 60 : 420);
}

/* ---------- 揭晓 ---------- */

function doReveal() {
  const scene = state.scene;
  state.mode = 'reveal';
  sound.reveal();
  const verdict = $('verdict');
  if (state.challenge) {
    verdict.className = 'verdict neutral';
    verdict.textContent = state.judge ? '你选择了相信' : '你选择了怀疑';
    $('truthLabel').textContent = '出题人的标题';
    $('truthTitle').textContent = state.challenge.t;
    $('revealText').textContent =
      `这幅画的全景是「${scene.name}」。${scene.reveal} 现在再看看框外:这个标题是诚实的描述,还是巧妙的误导?`;
  } else {
    const right = state.vote === scene.answer;
    verdict.className = 'verdict ' + (right ? 'seen' : 'fooled');
    verdict.textContent = right ? '好眼力,你识破了取景框' : '取景框骗过了你';
    $('truthLabel').textContent = '全景真相 · ' + scene.name;
    $('truthTitle').textContent = scene.choices[scene.answer];
    $('revealText').textContent = scene.reveal;
  }
  buildClueList();
  $('sceneCredit').textContent = scene.credit || '原创插画 · 本项目绘制';
  $('clueDetail').hidden = true;
  buildRevealActions();
  showPanel('panelReveal');
  setHint('正在拉开取景框…');
  animateTo(fullRect(scene), 1150, easeInOutCubic, () => {
    showPins();
    setHint('全景 · 点编号证据可推近');
  });
}

function buildClueList() {
  const list = $('clueList');
  list.textContent = '';
  (state.scene.clues || []).forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'clue-item';
    const n = document.createElement('span');
    n.className = 'num';
    n.textContent = String(i + 1).padStart(2, '0');
    const t = document.createElement('span');
    t.textContent = c.label;
    b.append(n, t);
    b.addEventListener('click', () => zoomClue(i));
    list.appendChild(b);
  });
}

function buildRevealActions() {
  const box = $('revealActions');
  box.textContent = '';
  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  if (state.challenge) {
    mk('我也来出题', 'primary', () => { sound.tick(); enterCreate(state.scene); });
    mk('回到内置关卡', 'ghost', () => { sound.tick(); clearHash(); enterGuess(0); });
  } else {
    const last = state.levelIndex >= state.scenes.length - 1;
    if (!last) {
      mk('下一关 →', 'primary', () => { sound.tick(); enterGuess(state.levelIndex + 1); });
      mk('我来出题', 'ghost', () => { sound.tick(); enterCreate(state.scene); });
    } else {
      mk('我来出题', 'primary', () => { sound.tick(); enterCreate(state.scene); });
      mk('再玩第一关', 'ghost', () => { sound.tick(); enterGuess(0); });
    }
    mk('重看局部', 'ghost', () => { sound.tick(); enterGuess(state.levelIndex); });
  }
}

function showPins() {
  pinsEl.textContent = '';
  (state.scene.clues || []).forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'pin';
    b.textContent = String(i + 1);
    b.style.left = (c.x / state.scene.width * 100) + '%';
    b.style.top = (c.y / state.scene.height * 100) + '%';
    b.style.setProperty('--pd', (i * 0.12) + 's');
    b.setAttribute('aria-label', '证据 ' + (i + 1) + ':' + c.label);
    b.addEventListener('click', () => zoomClue(i));
    pinsEl.appendChild(b);
  });
}

function zoomClue(i) {
  const clues = state.scene.clues || [];
  if (!clues[i]) return;
  state.activeClue = i;
  sound.tick();
  [...$('clueList').children].forEach((el, j) => el.classList.toggle('active', j === i));
  [...pinsEl.children].forEach((el, j) => el.classList.toggle('active', j === i));
  const d = $('clueDetail');
  d.textContent = clues[i].detail;
  d.hidden = false;
  const target = clues[i].focus || { x: Math.max(0, clues[i].x - 150), y: Math.max(0, clues[i].y - 110), w: 300, h: 220 };
  animateTo(target, 800, easeOutCubic);
  const bar = $('stageBar');
  bar.textContent = '';
  const back = document.createElement('button');
  back.className = 'tool-btn cyan';
  back.textContent = '← 回到全景';
  back.addEventListener('click', backToFull);
  const label = document.createElement('span');
  label.className = 'bar-label';
  label.textContent = `证据 0${i + 1} · ${clues[i].label}`;
  bar.append(back, label);
  bar.hidden = false;
  setHint(`线索 0${i + 1} · ${clues[i].label}`);
}

function backToFull() {
  state.activeClue = -1;
  sound.tick();
  [...$('clueList').children].forEach((el) => el.classList.remove('active'));
  [...pinsEl.children].forEach((el) => el.classList.remove('active'));
  $('clueDetail').hidden = true;
  $('stageBar').hidden = true;
  animateTo(fullRect(state.scene), 700, easeOutCubic);
  setHint('全景 · 点编号证据可推近');
}

/* ---------- 出题 ---------- */

function enterCreate(scene) {
  animToken++;
  state.mode = 'create';
  state.scene = scene;
  state.challenge = null;
  state.activeClue = -1;
  setSceneImage(scene);
  pinsEl.textContent = '';
  cropOverlay.hidden = false;
  $('challengeBadge').hidden = true;
  $('metaScene').textContent = 'CREATE';
  markLevelNav(-1);
  $('titleInput').value = '';
  $('titleCount').textContent = '0/' + MAX_TITLE;
  $('titleCount').classList.remove('warn');
  buildCreateBar();
  showPanel('panelCreate');
  applyRect({ ...scene.crop });
  setHint('拖动取景框 · 手柄调整大小');
  scrollToStage();
  $('titleInput').focus({ preventScroll: true });
}

function buildCreateBar() {
  const bar = $('stageBar');
  bar.textContent = '';
  bar.hidden = false;
  const label = document.createElement('span');
  label.className = 'bar-label';
  label.textContent = '画幅';
  bar.appendChild(label);
  const aspects = [['自由', 0], ['4:3', 3 / 4], ['1:1', 1], ['16:9', 9 / 16], ['3:4', 4 / 3]];
  for (const [name, ratio] of aspects) {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.textContent = name;
    b.addEventListener('click', () => {
      sound.tick();
      if (ratio) applyAspect(ratio);
      [...bar.querySelectorAll('.tool-btn')].forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    if (name === '自由') b.classList.add('active');
    bar.appendChild(b);
  }
  const sep = document.createElement('span');
  sep.className = 'bar-sep';
  bar.appendChild(sep);
  const mk = (text, fn, title) => {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener('click', () => { sound.tick(); fn(); });
    bar.appendChild(b);
    return b;
  };
  mk('− 拉远', () => zoomRect(1.22), '扩大取景范围');
  mk('+ 推近', () => zoomRect(0.82), '缩小取景范围');
  mk('随机', randomRect);
  mk('重置', () => applyRect({ ...state.scene.crop }));
}

function clampRect(r) {
  const s = state.scene;
  const w = Math.min(Math.max(Math.round(r.w), MIN_CROP), s.width);
  const h = Math.min(Math.max(Math.round(r.h), MIN_CROP), s.height);
  const x = Math.min(Math.max(Math.round(r.x), 0), s.width - w);
  const y = Math.min(Math.max(Math.round(r.y), 0), s.height - h);
  return { x, y, w, h };
}

function applyAspect(ratio) {
  const r = state.rect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  let w = r.w;
  let h = w * ratio;
  if (h > state.scene.height) { h = state.scene.height; w = h / ratio; }
  if (w > state.scene.width) { w = state.scene.width; h = w * ratio; }
  applyRect(clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }));
}

function zoomRect(factor) {
  const r = state.rect;
  const s = state.scene;
  let f = factor;
  if (f > 1) f = Math.min(f, s.width / r.w, s.height / r.h);
  else f = Math.max(f, MIN_CROP / r.w, MIN_CROP / r.h);
  const w = r.w * f;
  const h = r.h * f;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  applyRect(clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }));
}

function randomRect() {
  const s = state.scene;
  const ratios = [3 / 4, 1, 9 / 16, 4 / 3];
  const ratio = ratios[Math.floor(Math.random() * ratios.length)];
  const w = 220 + Math.floor(Math.random() * 340);
  let h = Math.round(w * ratio);
  if (h > s.height) h = s.height;
  const x = Math.floor(Math.random() * (s.width - w + 1));
  const y = Math.floor(Math.random() * (s.height - h + 1));
  applyRect(clampRect({ x, y, w, h }));
}

function currentTitle() {
  return $('titleInput').value.trim();
}

function currentChallenge() {
  const t = currentTitle();
  if (!t) return null;
  const r = clampRect(state.rect);
  return { s: state.scene.id, x: r.x, y: r.y, w: r.w, h: r.h, t };
}

function updateCreateUI() {
  const s = state.scene;
  if (!s) return;
  const vpW = viewport.clientWidth;
  const bs = vpW / s.width;
  const r = state.rect;
  cropRectEl.style.left = (r.x * bs) + 'px';
  cropRectEl.style.top = (r.y * bs) + 'px';
  cropRectEl.style.width = (r.w * bs) + 'px';
  cropRectEl.style.height = (r.h * bs) + 'px';
  $('metaRect').textContent =
    `X${Math.round(r.x)} Y${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}`;
  const pW = preview.clientWidth;
  const pH = preview.clientHeight;
  if (pW > 0) applyView(previewFilm, r, pW, pH, s);
  const c = currentChallenge();
  const link = c ? buildShareURL(location.href, c) : '';
  $('linkOutput').value = link;
  $('copyBtn').disabled = !c;
  $('passBtn').disabled = !c;
}

/* 拖拽 */
cropOverlay.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'create') return;
  const vp = viewport.getBoundingClientRect();
  const bs = vp.width / state.scene.width;
  const ix = (e.clientX - vp.left) / bs;
  const iy = (e.clientY - vp.top) / bs;
  const h = e.target.dataset ? e.target.dataset.h : undefined;
  if (h) {
    drag = { type: 'resize', h, start: { ...state.rect } };
  } else if (e.target === cropRectEl || cropRectEl.contains(e.target)) {
    drag = { type: 'move', dx: ix - state.rect.x, dy: iy - state.rect.y };
  } else {
    const r = state.rect;
    applyRect(clampRect({ x: ix - r.w / 2, y: iy - r.h / 2, w: r.w, h: r.h }));
    drag = { type: 'move', dx: state.rect.w / 2, dy: state.rect.h / 2 };
  }
  cropOverlay.setPointerCapture(e.pointerId);
  viewport.focus({ preventScroll: true });
  e.preventDefault();
});

cropOverlay.addEventListener('pointermove', (e) => {
  if (!drag || state.mode !== 'create') return;
  const vp = viewport.getBoundingClientRect();
  const bs = vp.width / state.scene.width;
  const ix = (e.clientX - vp.left) / bs;
  const iy = (e.clientY - vp.top) / bs;
  const s = state.scene;
  if (drag.type === 'move') {
    applyRect(clampRect({ x: ix - drag.dx, y: iy - drag.dy, w: state.rect.w, h: state.rect.h }));
    return;
  }
  const st = drag.start;
  let { x, y, w, h } = st;
  const right = st.x + st.w;
  const bottom = st.y + st.h;
  if (drag.h.includes('w')) {
    const nx = Math.min(Math.max(ix, 0), right - MIN_CROP);
    x = nx; w = right - nx;
  }
  if (drag.h.includes('e')) {
    w = Math.min(Math.max(ix, st.x + MIN_CROP), s.width) - st.x;
  }
  if (drag.h.includes('n')) {
    const ny = Math.min(Math.max(iy, 0), bottom - MIN_CROP);
    y = ny; h = bottom - ny;
  }
  if (drag.h.includes('s')) {
    h = Math.min(Math.max(iy, st.y + MIN_CROP), s.height) - st.y;
  }
  applyRect(clampRect({ x, y, w, h }));
});

const endDrag = () => { drag = null; };
cropOverlay.addEventListener('pointerup', endDrag);
cropOverlay.addEventListener('pointercancel', endDrag);

/* 键盘 */
viewport.addEventListener('keydown', (e) => {
  if (state.mode !== 'create') return;
  const step = e.shiftKey ? 1 : 10;
  const r = state.rect;
  let handled = true;
  switch (e.key) {
    case 'ArrowLeft': applyRect(clampRect({ ...r, x: r.x - step })); break;
    case 'ArrowRight': applyRect(clampRect({ ...r, x: r.x + step })); break;
    case 'ArrowUp': applyRect(clampRect({ ...r, y: r.y - step })); break;
    case 'ArrowDown': applyRect(clampRect({ ...r, y: r.y + step })); break;
    case '+': case '=': zoomRect(0.82); break;
    case '-': case '_': zoomRect(1.22); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

/* 标题与分享 */
$('titleInput').addEventListener('input', () => {
  const input = $('titleInput');
  const clamped = clampTitle(input.value);
  if (clamped !== input.value) input.value = clamped;
  const n = countCodePoints(input.value);
  const counter = $('titleCount');
  counter.textContent = n + '/' + MAX_TITLE;
  counter.classList.toggle('warn', n >= MAX_TITLE);
  updateCreateUI();
});

$('copyBtn').addEventListener('click', async () => {
  const link = $('linkOutput').value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    sound.blip();
    toast('挑战链接已复制,发给朋友吧', 'good');
  } catch {
    $('linkOutput').select();
    try {
      document.execCommand('copy');
      sound.blip();
      toast('挑战链接已复制,发给朋友吧', 'good');
    } catch {
      toast('复制失败,请手动全选链接复制', 'warn');
    }
  }
});

$('passBtn').addEventListener('click', () => {
  const c = currentChallenge();
  if (!c) return;
  sound.shutter();
  history.replaceState(null, '', '#' + encodeChallenge(c));
  enterChallenge(c, state.scene, true);
});

$('backBtn').addEventListener('click', () => {
  sound.tick();
  clearHash();
  enterGuess(state.levelIndex);
});

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

/* ---------- 全局控件 ---------- */

$('gridBtn').addEventListener('click', () => {
  state.gridOn = !state.gridOn;
  $('thirds').hidden = !state.gridOn;
  $('gridBtn').setAttribute('aria-pressed', String(state.gridOn));
  sound.tick();
});

$('soundBtn').addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  $('soundBtn').setAttribute('aria-pressed', String(sound.enabled));
  $('soundOnIcon').hidden = !sound.enabled;
  $('soundOffIcon').hidden = sound.enabled;
  if (sound.enabled) sound.blip();
  toast(sound.enabled ? '声音已开启' : '声音已静音', 'info');
});

$('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
$('helpClose').addEventListener('click', () => $('helpDialog').close());
$('retryBtn').addEventListener('click', () => location.reload());
$('brandLink').addEventListener('click', (e) => {
  e.preventDefault();
  clearHash();
  sound.tick();
  enterGuess(0);
});

window.addEventListener('hashchange', routeFromHash);

const ro = new ResizeObserver(() => {
  if (!state.scene) return;
  applyRect(state.rect);
});
ro.observe(viewport);
ro.observe(preview);

/* ---------- 路由与启动 ---------- */

function routeFromHash() {
  const frag = location.hash.slice(1);
  if (!frag) {
    enterGuess(0);
    return;
  }
  const r = decodeChallenge(frag, state.scenes);
  if (r.ok) {
    enterChallenge(r.challenge, r.scene, false);
  } else {
    sound.deny();
    toast('挑战链接无效(' + r.reason + '),已回到内置关卡', 'warn');
    clearHash();
    enterGuess(0);
  }
}

async function init() {
  try {
    const data = await loadScenes();
    state.scenes = data.scenes;
    await Promise.all(state.scenes.map(async (s) => {
      const url = await rasterize(new URL(s.image, document.baseURI).href, s);
      state.assets.set(s.id, url);
    }));
    buildLevelNav();
    $('loader').hidden = true;
    routeFromHash();
  } catch (err) {
    $('loader').hidden = true;
    $('errorText').textContent = err && err.message ? err.message : '资源加载出错';
    showPanel('panelError');
  }
}

init();