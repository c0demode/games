/* ============================================================
   Tetrisphere fan remake — Three.js frontend.
   Engine (public/engine.js) holds all rules; this file renders the
   layered sphere, handles input, timer, stages, HUD and sound.
   ============================================================ */
import * as THREE from "three";
import {
  COLS, ROWS, SHAPE_LIST, SHAPE_COLORS, ROTATIONS,
  newState, footprint, previewDrop, drop, grab, placeSlide,
  cancelSlide, moveCursor, rotatePiece, topLayerAt, activeShape,
} from "./engine.js";

// ---------- config ----------
const R = 2.6;                 // sphere radius
const LAYER_H = 0.085;         // radial gap between onion layers
const STAGES = [
  { layers: 1, time: 120 },
  { layers: 2, time: 150 },
  { layers: 3, time: 180 },
];
const TIME_PER_PIECE = 4;      // seconds added per blasted piece
const MAX_CELL_LAYERS = 4;     // 3 onion layers + 1 floater slot

// ---------- tiny synth ----------
let audioCtx = null;
let muted = localStorage.getItem("tetrisphere.muted") === "1";
function tone(freq, delay = 0, dur = 0.12, type = "sine", vol = 0.14) {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch { /* audio unavailable */ }
}
const sfx = {
  illegal() { tone(130, 0, 0.28, "sawtooth", 0.18); tone(92, 0.05, 0.3, "sawtooth", 0.14); },
  cleared(n) {
    const steps = [0, 4, 7, 12, 16, 19, 24];
    const k = Math.min(n, 7);
    for (let i = 0; i < k; i++) tone(523 * Math.pow(2, steps[i] / 12), i * 0.055, 0.14, "triangle", 0.16);
  },
  grab() { tone(300, 0, 0.07, "square", 0.08); },
  place() { tone(430, 0, 0.09, "square", 0.1); },
  cancel() { tone(240, 0, 0.08, "square", 0.08); },
  stageclear() { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.11, 0.22, "triangle", 0.16)); },
  gameover() { [392, 311, 247, 165].forEach((f, i) => tone(f, i * 0.16, 0.26, "sawtooth", 0.12)); },
  win() { [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, i * 0.1, 0.25, "triangle", 0.15)); },
  click() { tone(660, 0, 0.05, "sine", 0.07); },
};

// ---------- game state ----------
let state, stageIndex = 0, timeLeft = 0, best = +(localStorage.getItem("tetrisphere.best") || 0);

function newGame() {
  stageIndex = 0;
  startStage();
  hideBanner();
  document.getElementById("help").classList.add("hidden");
}

function startStage() {
  const cfg = STAGES[stageIndex];
  const keepScore = state ? state.score : 0;
  state = newState(cfg.layers, Math.random);
  state.score = keepScore;
  timeLeft = cfg.time;
  sphereGroup.rotation.set(0.25, 0, 0);
  rebuildInstances();
  updateCursor();
  updateHUD();
  hideBanner();
}

// ---------- three.js scene ----------
const wrap = document.getElementById("stageWrap");
const canvas = document.getElementById("stage3d");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(0, 0.7, 7.4);
camera.lookAt(0, 0, 0);
scene.add(new THREE.AmbientLight(0x99aacc, 1.0));
const dir = new THREE.DirectionalLight(0xffffff, 1.35);
dir.position.set(5, 4, 7);
scene.add(dir);

const sphereGroup = new THREE.Group();
scene.add(sphereGroup);

// dark body so you can't see through the sphere
const body = new THREE.Mesh(
  new THREE.SphereGeometry(R * 0.965, 48, 32),
  new THREE.MeshBasicMaterial({ color: 0x06060f })
);
sphereGroup.add(body);

// glowing core, revealed as layers peel away
const core = new THREE.Mesh(
  new THREE.SphereGeometry(R * 0.5, 32, 24),
  new THREE.MeshBasicMaterial({ color: 0xff8a2e })
);
sphereGroup.add(core);

// invisible fat sphere for tap-to-move raycasts
const rayTarget = new THREE.Mesh(
  new THREE.SphereGeometry(R + MAX_CELL_LAYERS * LAYER_H + 0.3, 24, 16),
  new THREE.MeshBasicMaterial({ visible: false })
);
sphereGroup.add(rayTarget);

// starfield
{
  const n = 500, posArr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(14 + Math.random() * 20);
    posArr.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x5566aa, size: 0.07 })));
}

// instanced blocks, one mesh per tetromino shape/color
const cellW = (2 * Math.PI * R) / COLS;
const cellH = (Math.PI * R) / ROWS;
const blockGeo = new THREE.PlaneGeometry(cellW * 0.9, cellH * 0.9);
const MAXI = COLS * ROWS * MAX_CELL_LAYERS;
const meshes = {};
for (const s of SHAPE_LIST) {
  const m = new THREE.InstancedMesh(
    blockGeo,
    new THREE.MeshLambertMaterial({ color: SHAPE_COLORS[s] }),
    MAXI
  );
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.count = 0;
  m.frustumCulled = false;
  sphereGroup.add(m);
  meshes[s] = m;
}

const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1), _d = new THREE.Object3D();

function sphPoint(r, c, rad, out) {
  const theta = ((c + 0.5) / COLS) * Math.PI * 2;
  const phi = ((r + 0.5) / ROWS) * Math.PI;
  out.set(
    rad * Math.sin(phi) * Math.cos(theta),
    rad * Math.cos(phi),
    rad * Math.sin(phi) * Math.sin(theta)
  );
  return out;
}

function rebuildInstances() {
  const counts = {};
  for (const s of SHAPE_LIST) counts[s] = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const l = topLayerAt(state, r, c);
      if (l < 0) continue;
      const pid = state.cells[l][r][c];
      const piece = state.pieces.get(pid);
      if (!piece) continue;
      const mesh = meshes[piece.shape];
      const i = counts[piece.shape]++;
      sphPoint(r, c, R + l * LAYER_H, _p);
      _n.copy(_p).normalize();
      _q.setFromUnitVectors(_z, _n);
      _d.position.copy(_p);
      _d.quaternion.copy(_q);
      _d.updateMatrix();
      mesh.setMatrixAt(i, _d.matrix);
    }
  }
  for (const s of SHAPE_LIST) {
    meshes[s].count = counts[s];
    meshes[s].instanceMatrix.needsUpdate = true;
  }
}

// ---------- cursor ----------
const cursorGeo = new THREE.PlaneGeometry(cellW * 1.04, cellH * 1.04);
const cursorMat = new THREE.MeshBasicMaterial({
  color: 0x3dff73, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
});
const cursorMeshes = [];
for (let i = 0; i < 4; i++) {
  const m = new THREE.Mesh(cursorGeo, cursorMat);
  sphereGroup.add(m);
  cursorMeshes.push(m);
}
const CURSOR_COLORS = { ok: 0x3dff73, bad: 0xff5b5b, carryOk: 0xffd23d, carryBad: 0xff5b5b };

function canPlaceSlide() {
  const fp = footprint(state);
  if (!fp) return false;
  for (const [r, c] of fp) {
    const nl = topLayerAt(state, r, c) + 1;
    if (nl > state.layers || state.cells[nl][r][c] !== 0) return false;
  }
  return true;
}

function updateCursor() {
  const fp = footprint(state);
  let status = "bad";
  if (state.carrying) status = canPlaceSlide() ? "carryOk" : "carryBad";
  else if (fp && previewDrop(state).ok) status = "ok";
  cursorMat.color.setHex(CURSOR_COLORS[status]);
  cursorMeshes.forEach((m) => (m.visible = false));
  if (!fp || state.status !== "playing") return;
  fp.forEach(([r, c], i) => {
    const m = cursorMeshes[i];
    const l = Math.min(topLayerAt(state, r, c) + 1, state.layers);
    sphPoint(r, c, R + l * LAYER_H + 0.045, _p);
    _n.copy(_p).normalize();
    m.position.copy(_p);
    m.quaternion.setFromUnitVectors(_z, _n);
    m.visible = true;
  });
}

// ---------- HUD ----------
const el = (id) => document.getElementById(id);
const heldCanvas = el("heldPreview");
function css(hex) { return "#" + hex.toString(16).padStart(6, "0"); }

function drawHeld() {
  const ctx = heldCanvas.getContext("2d");
  ctx.clearRect(0, 0, heldCanvas.width, heldCanvas.height);
  const shape = activeShape(state);
  const offs = ROTATIONS[shape][state.cursor.rot];
  const maxR = Math.max(...offs.map((o) => o[0]));
  const maxC = Math.max(...offs.map((o) => o[1]));
  const s = 15;
  const ox = (heldCanvas.width - (maxC + 1) * s) / 2;
  const oy = (heldCanvas.height - (maxR + 1) * s) / 2;
  ctx.fillStyle = css(SHAPE_COLORS[shape]);
  for (const [r, c] of offs) {
    ctx.beginPath();
    ctx.roundRect(ox + c * s + 1, oy + r * s + 1, s - 2, s - 2, 4);
    ctx.fill();
  }
  if (state.carrying) {
    ctx.fillStyle = "#ffd23d";
    ctx.font = "bold 10px system-ui";
    ctx.fillText("SLIDING", 6, 12);
  }
}

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function updateHUD() {
  el("hearts").textContent = "❤".repeat(state.hearts) + "🖤".repeat(Math.max(0, 3 - state.hearts));
  el("stage").textContent = `STAGE ${stageIndex + 1}/${STAGES.length}`;
  el("timer").textContent = "⏱ " + fmtTime(timeLeft);
  el("timer").classList.toggle("low", timeLeft < 30 && state.status === "playing");
  el("score").textContent = "⭐ " + state.score.toLocaleString();
  el("combo").textContent = state.combo >= 2 ? `🔥×${state.combo}` : "";
  el("btnSlide").classList.toggle("armed", !!state.carrying);
  el("btnSlide").textContent = state.carrying ? "✋ PLACE" : "✋ SLIDE";
  drawHeld();
}

// ---------- banner / help ----------
function showBanner(title, text, btnLabel, onClick) {
  el("bannerTitle").textContent = title;
  el("bannerText").innerHTML = text;
  const btn = el("bannerBtn");
  btn.textContent = btnLabel;
  btn.onclick = () => { sfx.click(); onClick(); };
  el("banner").classList.remove("hidden");
}
function hideBanner() { el("banner").classList.add("hidden"); }

function onStageClear() {
  sfx.stageclear();
  updateHUD();
  setTimeout(() => {
    if (stageIndex + 1 < STAGES.length) {
      showBanner(
        `Stage ${stageIndex + 1} clear!`,
        `Core exposed. Score: <b>${state.score.toLocaleString()}</b>`,
        "Next stage →",
        () => { stageIndex++; startStage(); }
      );
    } else {
      state.status = "win";
      sfx.win();
      if (state.score > best) {
        best = state.score;
        localStorage.setItem("tetrisphere.best", String(best));
      }
      showBanner(
        "🏆 You reached the core!",
        `Final score: <b>${state.score.toLocaleString()}</b><br>Best: <b>${best.toLocaleString()}</b>`,
        "Play again ↺",
        newGame
      );
    }
  }, 700);
}

function onGameOver() {
  sfx.gameover();
  if (state.score > best) {
    best = state.score;
    localStorage.setItem("tetrisphere.best", String(best));
  }
  setTimeout(() => {
    showBanner(
      "Game over",
      `The sphere got you.<br>Score: <b>${state.score.toLocaleString()}</b> · Best: <b>${best.toLocaleString()}</b>`,
      "Try again ↺",
      newGame
    );
  }, 700);
}

// ---------- actions ----------
function doDrop() {
  if (state.status !== "playing") return;
  if (state.carrying) { doPlaceSlide(); return; }
  const ev = drop(state, Math.random);
  if (ev.type === "illegal") {
    sfx.illegal();
    canvas.style.filter = "brightness(1.6) saturate(0.4)";
    setTimeout(() => (canvas.style.filter = ""), 180);
    if (ev.status === "gameover") { updateHUD(); onGameOver(); return; }
  } else if (ev.type === "cleared") {
    sfx.cleared(ev.cleared.length);
    timeLeft = Math.min(STAGES[stageIndex].time, timeLeft + ev.cleared.length * TIME_PER_PIECE);
    rebuildInstances();
    if (ev.stageClear) { updateCursor(); onStageClear(); return; }
  }
  updateCursor();
  updateHUD();
}

function doPlaceSlide() {
  const ev = placeSlide(state);
  if (ev.type !== "placed") return;
  sfx.place();
  if (ev.cleared.length) {
    sfx.cleared(ev.cleared.length);
    timeLeft = Math.min(STAGES[stageIndex].time, timeLeft + ev.cleared.length * TIME_PER_PIECE);
  }
  rebuildInstances();
  updateCursor();
  updateHUD();
  if (ev.stageClear) onStageClear();
}

function toggleSlide() {
  if (state.status !== "playing") return;
  if (state.carrying) {
    // press again = set the piece down
    doPlaceSlide();
    return;
  }
  const ev = grab(state);
  if (ev.type === "grabbed") sfx.grab();
  else sfx.cancel();
  updateCursor();
  updateHUD();
}

function cancelSlideAction() {
  if (cancelSlide(state).type === "cancelled") {
    sfx.cancel();
    updateCursor();
    updateHUD();
  }
}

// ---------- input: keyboard ----------
addEventListener("keydown", (e) => {
  if (!el("help").classList.contains("hidden")) {
    if (e.key === "Escape") el("help").classList.add("hidden");
    return;
  }
  switch (e.code) {
    case "ArrowLeft": case "KeyA": moveCursor(state, 0, -1); break;
    case "ArrowRight": case "KeyD": moveCursor(state, 0, 1); break;
    case "ArrowUp": case "KeyW": moveCursor(state, -1, 0); break;
    case "ArrowDown": case "KeyS": moveCursor(state, 1, 0); break;
    case "Space": case "Enter": e.preventDefault(); doDrop(); return;
    case "KeyR": rotatePiece(state); break;
    case "KeyX": toggleSlide(); break;
    case "KeyM": toggleMute(); return;
    case "KeyN": newGame(); return;
    case "Escape":
      if (state.carrying) cancelSlideAction();
      else el("help").classList.add("hidden");
      break;
    default: return;
  }
  updateCursor();
  updateHUD();
});

// ---------- input: pointer (drag to spin, tap to move cursor) ----------
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let pDown = null;

function setPointer(e) {
  const rect = canvas.getBoundingClientRect();
  pointerNDC.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
}

function tapToCursor(e) {
  setPointer(e);
  raycaster.setFromCamera(pointerNDC, camera);
  const hit = raycaster.intersectObject(rayTarget, false)[0];
  if (!hit) return;
  const local = sphereGroup.worldToLocal(hit.point.clone());
  const rad = local.length();
  const phi = Math.acos(THREE.MathUtils.clamp(local.y / rad, -1, 1));
  let theta = Math.atan2(local.z, local.x);
  if (theta < 0) theta += Math.PI * 2;
  const c = Math.floor((theta / (Math.PI * 2)) * COLS) % COLS;
  const r = Math.min(ROWS - 1, Math.max(0, Math.floor((phi / Math.PI) * ROWS)));
  state.cursor.r = r;
  state.cursor.c = c;
  updateCursor();
  updateHUD();
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pDown = { x: e.clientX, y: e.clientY, t: performance.now(), dragged: false };
});
canvas.addEventListener("pointermove", (e) => {
  if (!pDown) return;
  const dx = e.clientX - pDown.x, dy = e.clientY - pDown.y;
  if (!pDown.dragged && Math.hypot(dx, dy) > 8) pDown.dragged = true;
  if (pDown.dragged) {
    sphereGroup.rotation.y += dx * 0.008;
    sphereGroup.rotation.x = THREE.MathUtils.clamp(sphereGroup.rotation.x + dy * 0.008, -1.15, 1.15);
    pDown.x = e.clientX;
    pDown.y = e.clientY;
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (pDown && !pDown.dragged && performance.now() - pDown.t < 500) tapToCursor(e);
  pDown = null;
});
canvas.addEventListener("dblclick", () => doDrop());
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (state.carrying) cancelSlideAction();
  else toggleSlide();
});

// ---------- input: buttons ----------
el("btnDrop").onclick = () => doDrop();
el("btnRotate").onclick = () => { rotatePiece(state); sfx.click(); updateCursor(); drawHeld(); };
el("btnSlide").onclick = () => toggleSlide();
el("btnNew").onclick = () => newGame();
el("btnHelp").onclick = () => el("help").classList.remove("hidden");
el("helpClose").onclick = () => el("help").classList.add("hidden");
el("help").addEventListener("click", (e) => {
  if (e.target === el("help")) el("help").classList.add("hidden");
});
function toggleMute() {
  muted = !muted;
  localStorage.setItem("tetrisphere.muted", muted ? "1" : "0");
  el("btnMute").textContent = muted ? "🔇" : "🔊";
}
el("btnMute").onclick = toggleMute;
el("btnMute").textContent = muted ? "🔇" : "🔊";

// ---------- resize + main loop ----------
function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

let last = performance.now();
let hudAcc = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.status === "playing") {
    timeLeft -= dt;
    if (timeLeft <= 0) {
      state.hearts -= 1;
      state.combo = 0;
      if (state.hearts <= 0) {
        state.status = "gameover";
        updateHUD();
        onGameOver();
      } else {
        timeLeft = 60;
        sfx.illegal();
      }
    }
    hudAcc += dt;
    if (hudAcc > 0.25) { hudAcc = 0; updateHUD(); }
  }
  const pulse = 1 + Math.sin(now * 0.003) * 0.06;
  core.scale.setScalar(pulse);
  renderer.render(scene, camera);
}

// ---------- boot ----------
resize();
newGame();
requestAnimationFrame(loop);
