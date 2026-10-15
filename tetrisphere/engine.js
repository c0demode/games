/* ============================================================
   Tetrisphere remake — pure game logic (no DOM, no Three.js).
   ES module shared by the browser frontend and the node tests.

   The sphere surface is an equirectangular grid: COLS columns of
   longitude (wraps around) x ROWS rows of latitude. Blocks stack in
   LAYERS (onion-style); only the outermost block per (row, col) is
   visible/playable. Blocks are grouped into tetromino pieces.

   Core rule (faithful to the N64 original): dropping your held piece
   so it touches 2+ other pieces of the SAME SHAPE (adjacent incl.
   diagonals, or stacked across layers) clears the whole connected
   group. A drop that creates no such group costs a heart.
   ============================================================ */

export const COLS = 24;
export const ROWS = 12;

export const SHAPE_LIST = ["I", "O", "T", "S", "Z", "J", "L"];

export const SHAPE_COLORS = {
  I: 0x00d8ff, // cyan
  O: 0xffd500, // yellow
  T: 0xb14bff, // purple
  S: 0x2eff6e, // green
  Z: 0xff3b3b, // red
  J: 0x3b7bff, // blue
  L: 0xff8a1e, // orange
};

const BASE_OFFSETS = {
  I: [[0, 0], [0, 1], [0, 2], [0, 3]],
  O: [[0, 0], [0, 1], [1, 0], [1, 1]],
  T: [[0, 0], [0, 1], [0, 2], [1, 1]],
  S: [[0, 1], [0, 2], [1, 0], [1, 1]],
  Z: [[0, 0], [0, 1], [1, 1], [1, 2]],
  J: [[0, 0], [1, 0], [1, 1], [1, 2]],
  L: [[0, 2], [1, 0], [1, 1], [1, 2]],
};

function normalize(offsets) {
  const minR = Math.min(...offsets.map((o) => o[0]));
  const minC = Math.min(...offsets.map((o) => o[1]));
  return offsets.map(([r, c]) => [r - minR, c - minC]);
}

function rotateCW(offsets) {
  return normalize(offsets.map(([r, c]) => [c, -r]));
}

// ROTATIONS[shape][0..3] -> [[r,c]...] (4 blocks, normalized)
export const ROTATIONS = {};
for (const s of SHAPE_LIST) {
  const rots = [normalize(BASE_OFFSETS[s])];
  for (let i = 1; i < 4; i++) rots.push(rotateCW(rots[i - 1]));
  ROTATIONS[s] = rots;
}

// ---- deterministic RNG (injectable for tests) ----
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const wrapC = (c) => ((c % COLS) + COLS) % COLS;

// ---- state ----
// cells has layers+1 slots: `layers` fully-tiled onion layers plus one
// extra slot above the surface where dropped/slid pieces may land.
export function newState(layers, rng) {
  const cellLayers = layers + 1;
  const state = {
    layers,
    cellLayers,
    cursor: { r: Math.floor(ROWS / 2), c: 0, rot: 0 },
    held: SHAPE_LIST[Math.floor(rng() * SHAPE_LIST.length)],
    carrying: null, // { shape, cells: [[l,r,c]...] } while sliding
    hearts: 3,
    score: 0,
    combo: 0, // consecutive successful drops
    status: "playing", // playing | stageclear | gameover | win
    cells: [], // cells[l][r][c] = pid (0 = empty)
    pieces: new Map(), // pid -> { shape, cells: [[l,r,c]...] }
    nextPid: 1,
    clearedTotal: 0,
  };
  for (let l = 0; l < cellLayers; l++) {
    state.cells.push(Array.from({ length: ROWS }, () => new Array(COLS).fill(0)));
  }
  for (let l = 0; l < layers; l++) tileLayer(state, l, rng);
  return state;
}

// ---- guaranteed tiling: 2x4 blocks, each split into 2 tetrominoes ----
// Every subset of 4 cells of a 2x4 rectangle that is 4-connected is a
// tetromino; a partition is valid when both halves are 4-connected.
function shapeNameOf(offsets) {
  const norm = normalize(offsets).map(([r, c]) => r + "," + c).sort().join("|");
  for (const s of SHAPE_LIST) {
    for (let rot = 0; rot < 4; rot++) {
      const key = ROTATIONS[s][rot].map(([r, c]) => r + "," + c).sort().join("|");
      if (key === norm) return s;
    }
  }
  return null;
}

function cellsConnected(cells) {
  // cells: [[r,c]...] within the 2x4 block
  const set = new Set(cells.map(([r, c]) => r + "," + c));
  const stack = [cells[0]];
  const seen = new Set();
  while (stack.length) {
    const [r, c] = stack.pop();
    const k = r + "," + c;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nk = r + dr + "," + (c + dc);
      if (set.has(nk) && !seen.has(nk)) stack.push([r + dr, c + dc]);
    }
  }
  return seen.size === 4;
}

const PARTITIONS = (() => {
  const all = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 4; c++) all.push([r, c]);
  const out = [];
  // choose 4 of 8
  const idx = [0, 1, 2, 3, 4, 5, 6, 7];
  function* combos(arr, k, start = 0, prefix = []) {
    if (k === 0) {
      yield prefix;
      return;
    }
    for (let i = start; i <= arr.length - k; i++) {
      yield* combos(arr, k - 1, i + 1, [...prefix, arr[i]]);
    }
  }
  const seen = new Set();
  for (const combo of combos(idx, 4)) {
    const a = combo.map((i) => all[i]);
    const b = idx.filter((i) => !combo.includes(i)).map((i) => all[i]);
    if (!cellsConnected(a) || !cellsConnected(b)) continue;
    const sa = shapeNameOf(a);
    const sb = shapeNameOf(b);
    if (!sa || !sb) continue;
    const key = a.map(([r, c]) => r + "," + c).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([
      { shape: sa, cells: a },
      { shape: sb, cells: b },
    ]);
  }
  return out;
})();

export function partitionCount() {
  return PARTITIONS.length;
}

// Tile one layer with zero retries: the COLSxROWS grid factors exactly
// into 2x4 blocks (COLS % 4 === 0, ROWS % 2 === 0).
function tileLayer(state, l, rng) {
  const { cells, pieces } = state;
  const shift = Math.floor(rng() * 4); // random column offset for variety
  for (let br = 0; br < ROWS / 2; br++) {
    for (let bc = 0; bc < COLS / 4; bc++) {
      const part = PARTITIONS[Math.floor(rng() * PARTITIONS.length)];
      const halves = rng() < 0.5 ? part : [part[1], part[0]];
      for (const half of halves) {
        const pid = state.nextPid++;
        const pieceCells = half.cells.map(([rr, cc]) => [
          l,
          br * 2 + rr,
          wrapC(bc * 4 + cc + shift),
        ]);
        for (const [ll, rr, cc] of pieceCells) cells[ll][rr][cc] = pid;
        pieces.set(pid, { shape: half.shape, cells: pieceCells });
      }
    }
  }
}

// ---- cursor footprint ----
export function activeShape(state) {
  return state.carrying ? state.carrying.shape : state.held;
}

// Cells (on the OUTERNOST playable layer surface) the cursor piece would occupy.
// Returns null if any block would fall off the poles.
export function footprint(state) {
  const shape = activeShape(state);
  const offs = ROTATIONS[shape][state.cursor.rot];
  const cells = [];
  for (const [or, oc] of offs) {
    const r = state.cursor.r + or;
    if (r < 0 || r >= ROWS) return null;
    cells.push([r, wrapC(state.cursor.c + oc)]);
  }
  return cells;
}

// Outermost layer index that still has a block at (r,c), or -1 if empty.
export function topLayerAt(state, r, c) {
  for (let l = state.cellLayers - 1; l >= 0; l--) {
    if (state.cells[l][r][c] !== 0) return l;
  }
  return -1;
}

// ---- matching ----
function neighborKeys(l, r, c, layers) {
  const out = [];
  for (let dl = -1; dl <= 1; dl++) {
    const nl = l + dl;
    if (nl < 0 || nl >= layers) continue;
    for (let dr = -1; dr <= 1; dr++) {
      const nr = r + dr;
      if (nr < 0 || nr >= ROWS) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (dl === 0 && dr === 0 && dc === 0) continue;
        out.push([nl, nr, wrapC(c + dc)]);
      }
    }
  }
  return out;
}

// All piece ids of `shape` connected (26-neighborhood) to the given cells.
export function connectedGroup(state, shape, seedCells) {
  const seen = new Set();
  const group = new Set();
  const stack = seedCells.slice();
  while (stack.length) {
    const [l, r, c] = stack.pop();
    const key = l * ROWS * COLS + r * COLS + c;
    if (seen.has(key)) continue;
    seen.add(key);
    const pid = state.cells[l][r][c];
    if (!pid) continue;
    const piece = state.pieces.get(pid);
    if (!piece || piece.shape !== shape) continue;
    group.add(pid);
    for (const n of neighborKeys(l, r, c, state.cellLayers)) stack.push(n);
  }
  return [...group];
}

// Would dropping the cursor piece right now clear something?
// Returns { ok, group } — ok means the drop is legal (white cursor).
export function previewDrop(state) {
  const fp = footprint(state);
  if (!fp) return { ok: false, group: [] };
  const shape = activeShape(state);
  // find surface layer per footprint cell; all must be empty & share... 
  // piece lands on the outermost occupied-or-empty column tops:
  const placements = [];
  for (const [r, c] of fp) {
    const l = topLayerAt(state, r, c);
    const nl = l + 1; // sits on top of whatever is there
    if (nl > state.layers) return { ok: false, group: [] }; // one floater level max
    placements.push([nl, r, c]);
  }
  // target cells must be empty
  for (const [l, r, c] of placements) {
    if (state.cells[l][r][c] !== 0) return { ok: false, group: [] };
  }
  // simulate
  const tmpPid = -1;
  const tmpPiece = { shape, cells: placements };
  state.pieces.set(tmpPid, tmpPiece);
  for (const [l, r, c] of placements) state.cells[l][r][c] = tmpPid;
  const group = connectedGroup(state, shape, placements);
  // revert
  for (const [l, r, c] of placements) state.cells[l][r][c] = 0;
  state.pieces.delete(tmpPid);
  const realGroup = group.filter((pid) => pid !== tmpPid);
  // legal iff the placed piece joins 2+ other same-shape pieces
  return { ok: realGroup.length >= 2, group: realGroup };
}

function removePieces(state, pids) {
  for (const pid of pids) {
    const piece = state.pieces.get(pid);
    if (!piece) continue;
    for (const [l, r, c] of piece.cells) state.cells[l][r][c] = 0;
    state.pieces.delete(pid);
  }
  state.clearedTotal += pids.length;
}

// Drop the held piece. Returns an event describing what happened.
export function drop(state, rng) {
  if (state.status !== "playing" || state.carrying) return { type: "noop" };
  const { ok, group } = previewDrop(state);
  if (!ok) {
    state.hearts -= 1;
    state.combo = 0;
    if (state.hearts <= 0) state.status = "gameover";
    return { type: "illegal", hearts: state.hearts, status: state.status };
  }
  const fp = footprint(state);
  const shape = state.held;
  const placements = fp.map(([r, c]) => [topLayerAt(state, r, c) + 1, r, c]);
  const pid = state.nextPid++;
  for (const [l, r, c] of placements) state.cells[l][r][c] = pid;
  state.pieces.set(pid, { shape, cells: placements });
  const fullGroup = connectedGroup(state, shape, placements);
  removePieces(state, fullGroup);
  state.combo += 1;
  const gained = fullGroup.length * 100 * state.combo;
  state.score += gained;
  state.held = SHAPE_LIST[Math.floor(rng() * SHAPE_LIST.length)];
  let stageClear = isStageClear(state);
  if (stageClear) state.status = "stageclear";
  return {
    type: "cleared",
    cleared: fullGroup,
    gained,
    combo: state.combo,
    score: state.score,
    stageClear,
  };
}

// ---- sliding: pick up the piece under the cursor, reposition, set down ----
export function grab(state) {
  if (state.status !== "playing" || state.carrying) return { type: "noop" };
  const fp = footprint(state);
  if (!fp) return { type: "noop" };
  const [r0, c0] = fp[0];
  const l = topLayerAt(state, r0, c0);
  if (l < 0) return { type: "noop" };
  const pid = state.cells[l][r0][c0];
  const piece = state.pieces.get(pid);
  if (!piece) return { type: "noop" };
  for (const [ll, rr, cc] of piece.cells) state.cells[ll][rr][cc] = 0;
  state.pieces.delete(pid);
  state.carrying = { shape: piece.shape, cells: piece.cells };
  return { type: "grabbed", shape: piece.shape };
}

export function placeSlide(state) {
  if (state.status !== "playing" || !state.carrying) return { type: "noop" };
  const fp = footprint(state);
  if (!fp) return { type: "noop" };
  const shape = state.carrying.shape;
  const placements = [];
  for (const [r, c] of fp) {
    const l = topLayerAt(state, r, c);
    const nl = l + 1;
    if (nl > state.layers || state.cells[nl][r][c] !== 0) return { type: "noop" };
    placements.push([nl, r, c]);
  }
  const pid = state.nextPid++;
  for (const [l, r, c] of placements) state.cells[l][r][c] = pid;
  state.pieces.set(pid, { shape, cells: placements });
  state.carrying = null;
  const group = connectedGroup(state, shape, placements);
  let cleared = [];
  let gained = 0;
  if (group.length >= 3) {
    removePieces(state, group);
    cleared = group;
    state.combo += 1;
    gained = group.length * 100 * state.combo;
    state.score += gained;
  }
  const stageClear = isStageClear(state);
  if (stageClear) state.status = "stageclear";
  return { type: "placed", cleared, gained, combo: state.combo, stageClear };
}

export function cancelSlide(state) {
  if (!state.carrying) return { type: "noop" };
  const { shape, cells } = state.carrying;
  const pid = state.nextPid++;
  for (const [l, r, c] of cells) state.cells[l][r][c] = pid;
  state.pieces.set(pid, { shape, cells });
  state.carrying = null;
  return { type: "cancelled" };
}

// ---- cursor ----
export function moveCursor(state, dr, dc) {
  state.cursor.r = Math.min(ROWS - 1, Math.max(0, state.cursor.r + dr));
  state.cursor.c = wrapC(state.cursor.c + dc);
}

export function rotatePiece(state) {
  state.cursor.rot = (state.cursor.rot + 1) % 4;
}

export function isStageClear(state) {
  for (let l = 0; l < state.cellLayers; l++)
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) if (state.cells[l][r][c] !== 0) return false;
  return true;
}

export function remainingBlocks(state) {
  let n = 0;
  for (let l = 0; l < state.cellLayers; l++)
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) if (state.cells[l][r][c] !== 0) n++;
  return n;
}
