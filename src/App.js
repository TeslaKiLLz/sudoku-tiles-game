import React, { useEffect, useMemo, useState } from "react";

/**
 * Waffle-Sudoku (React + plain JavaScript)
 *
 * Core rules:
 * - Conceptual number-grid is 7x7 with digits 1..7 (Latin square style).
 * - We REMOVE cells where (row is odd AND col is odd) (0-indexed: r%2==1 && c%2==1).
 * - UI is a 13x13 waffle grid:
 *   - (even, even) => number positions (including removed junction positions)
 *   - (odd, odd)   => corner holes (visual only)
 *   - others       => spacer slots (visual only)
 *
 * Junction sum clues:
 * - A sum pill sits in a REMOVED number position.
 * - It targets EXACTLY TWO number tiles in an L-shape:
 *     one adjacent in row direction and one adjacent in column direction.
 * - A number tile may be used by AT MOST ONE sum pill.
 * - A removed junction may host AT MOST ONE sum pill.
 *
 * Start state rule:
 * - ONLY the lockCount tiles start in their correct positions (and are locked as givens ●).
 * - Every other active tile is scrambled and MUST start incorrect.
 *
 * Interaction:
 * - Drag any movable tile onto any other movable tile to swap.
 * - Tiles are immovable if locked.
 * - After a swap, any tile that lands in its correct position locks and turns green (✓).
 *
 * Lose conditions:
 * - Optional move limit and/or timer.
 * - Auto-balanced per puzzle using "par moves" (estimated optimal swaps for THIS start).
 * - When you win/lose, the board becomes inert; closing the modal only hides the modal.
 *
 * Visuals:
 * - Green: locked tiles (givens ● or earned ✓)
 * - Light gray: all movable tiles AND rule violations (same color; no hint)
 * - Empty/non-used board positions are transparent/flush with the backdrop.
 */

const N = 7;
const UI = N * 2 - 1; // 13

// Auto-balance tuning: keep moves only a bit higher than par.
// (Small wiggle room; you can tweak these later.)
const AUTO = {
  easy: { wiggleMoves: 12, secPerMove: 6.5, timeBuf: 45 },
  medium: { wiggleMoves: 10, secPerMove: 6.0, timeBuf: 40 },
  hard: { wiggleMoves: 8, secPerMove: 5.5, timeBuf: 35 },
  expert: { wiggleMoves: 5, secPerMove: 5.0, timeBuf: 30 },
};

const DIFFICULTY_PRESETS = {
  easy: { lockCount: 10, sumCount: 16 },
  medium: { lockCount: 8, sumCount: 8 },
  hard: { lockCount: 4, sumCount: 5 },
  expert: { lockCount: 2, sumCount: 5 },
};

const LOSE_MODES = {
  none: "None",
  moves: "Move limit",
  timer: "Timer",
  both: "Moves + Timer",
};

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function clampInt(x, lo, hi) {
  const v = Math.floor(x);
  return Math.max(lo, Math.min(hi, v));
}

function keyOf(r, c) {
  return `${r},${c}`;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randPerm(n) {
  return shuffled(Array.from({ length: n }, (_, i) => i));
}

function isActiveNumberCell(r, c) {
  return !(r % 2 === 1 && c % 2 === 1);
}

function cloneGrid(grid) {
  return grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
}

function activePositions() {
  const ps = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!isActiveNumberCell(r, c)) continue;
      ps.push({ r, c });
    }
  }
  return ps;
}

function makeBaseLatinSquare() {
  const sol = [];
  for (let r = 0; r < N; r++) {
    const row = [];
    for (let c = 0; c < N; c++) row.push(((r + c) % N) + 1);
    sol.push(row);
  }
  return sol;
}

function makeRandomSolution() {
  // Randomize the base Latin square by permuting rows, columns, and symbols.
  // This keeps validity but removes the obvious 1..7 / rotation structure.
  const base = makeBaseLatinSquare();

  const rowP = randPerm(N);
  const colP = randPerm(N);
  const symP = randPerm(N).map((x) => x + 1);

  const sol = Array.from({ length: N }, () => Array.from({ length: N }, () => 1));
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = base[rowP[r]][colP[c]];
      sol[r][c] = symP[v - 1];
    }
  }
  return sol;
}

function countLockedCells(grid) {
  let n = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const cell = grid[r][c];
      if (cell && cell.locked) n++;
    }
  }
  return n;
}

function rowValuesActive(grid, r) {
  const vals = [];
  for (let c = 0; c < N; c++) {
    if (!isActiveNumberCell(r, c)) continue;
    const cell = grid[r][c];
    if (cell) vals.push(cell.value);
  }
  return vals;
}

function colValuesActive(grid, c) {
  const vals = [];
  for (let r = 0; r < N; r++) {
    if (!isActiveNumberCell(r, c)) continue;
    const cell = grid[r][c];
    if (cell) vals.push(cell.value);
  }
  return vals;
}

function isStraightRun(vals) {
  // Detect exact 1..7 or any rotation like 3456712 (also reverse rotations)
  if (vals.length < 6) return false;
  const inc = [1, 2, 3, 4, 5, 6, 7];
  const dec = [7, 6, 5, 4, 3, 2, 1];

  function isRotationOf(seq, target) {
    if (seq.length !== target.length) return false;
    const s = seq.join(",");
    const t = target.join(",");
    return (t + "," + t).includes(s);
  }

  const full = vals.length === 7;
  if (full) return isRotationOf(vals, inc) || isRotationOf(vals, dec);

  const inc2 = inc.concat(inc).join(",");
  const dec2 = dec.concat(dec).join(",");
  const s = vals.join(",");
  return inc2.includes(s) || dec2.includes(s);
}

function looksTooPatterned(grid) {
  // Reject starts that look like obvious straight runs in many rows/cols.
  // Keep lenient to avoid excessive retries.
  let bad = 0;
  for (let r = 0; r < N; r++) if (isStraightRun(rowValuesActive(grid, r))) bad++;
  for (let c = 0; c < N; c++) if (isStraightRun(colValuesActive(grid, c))) bad++;
  return bad >= 2;
}

function computeParMoves(grid) {
  // Par moves = minimum swaps to restore the UNIQUE tile identities to their home cells.
  // We assign each tile an id that represents its home position "r,c".
  // With all tiles uniquely labeled, min swaps = movableCount - cycles in permutation.
  const posToId = new Map();
  const movableIds = [];

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!isActiveNumberCell(r, c)) continue;
      const cell = grid[r][c];
      if (!cell) continue;

      const posKey = keyOf(r, c);
      posToId.set(posKey, cell.id);
      if (!cell.locked) movableIds.push(cell.id);
    }
  }

  const visited = new Set();
  let cycles = 0;

  for (const startId of movableIds) {
    if (visited.has(startId)) continue;
    cycles++;

    let curId = startId;
    while (!visited.has(curId)) {
      visited.add(curId);
      const homePos = curId; // since id is "r,c"
      const nextId = posToId.get(homePos);
      curId = nextId;
    }
  }

  return movableIds.length - cycles;
}

function makeStartGridFromSolution(solution, opts = {}) {
  // Requirement: ONLY the lockCount tiles start correct (locked).
  // Every other active tile must start incorrect.
  // Each tile carries a stable identity id = its home position "r,c".
  const lockCount = opts.lockCount ?? 12;
  const maxAttempts = opts.maxAttempts ?? 1800;

  const actives = activePositions();
  const lockable = shuffled(actives).slice(0, Math.min(lockCount, actives.length));
  const lockedSet = new Set(lockable.map((p) => keyOf(p.r, p.c)));

  const unlockedPositions = actives.filter((p) => !lockedSet.has(keyOf(p.r, p.c)));
  const unlockedPool = unlockedPositions.map((p) => ({
    value: solution[p.r][p.c],
    id: keyOf(p.r, p.c),
  }));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const perm = shuffled(unlockedPool);

    const grid = Array.from({ length: N }, (_, r) =>
      Array.from({ length: N }, (_, c) => (isActiveNumberCell(r, c) ? { value: 1, id: keyOf(r, c) } : null))
    );

    // Place locked givens
    for (const p of lockable) {
      grid[p.r][p.c] = { value: solution[p.r][p.c], id: keyOf(p.r, p.c), locked: true, given: true };
    }

    // Place unlocked tiles (value + id travel together)
    for (let i = 0; i < unlockedPositions.length; i++) {
      const p = unlockedPositions[i];
      grid[p.r][p.c] = { value: perm[i].value, id: perm[i].id, locked: false };
    }

    // Ensure no unlocked tile starts correct (by VALUE vs solution)
    let anyUnlockedCorrect = false;
    for (const p of unlockedPositions) {
      if (grid[p.r][p.c].value === solution[p.r][p.c]) {
        anyUnlockedCorrect = true;
        break;
      }
    }
    if (anyUnlockedCorrect) continue;

    if (looksTooPatterned(grid)) continue;

    return grid;
  }

  // Fallback: best-effort (still guarantees givens are correct)
  const grid = Array.from({ length: N }, (_, r) =>
    Array.from({ length: N }, (_, c) =>
      isActiveNumberCell(r, c) ? { value: (solution[r][c] % N) + 1, id: keyOf(r, c), locked: false } : null
    )
  );
  for (const p of lockable)
    grid[p.r][p.c] = { value: solution[p.r][p.c], id: keyOf(p.r, p.c), locked: true, given: true };
  return grid;
}

function lockNewlyCorrectTiles(grid, solution) {
  const next = cloneGrid(grid);
  let lockedAny = false;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!isActiveNumberCell(r, c)) continue;
      const cell = next[r][c];
      if (!cell || cell.locked) continue;
      if (cell.value === solution[r][c]) {
        next[r][c] = { ...cell, locked: true, earned: true };
        lockedAny = true;
      }
    }
  }
  return lockedAny ? next : grid;
}

function validateRowCol(grid) {
  // Still computed (useful for debugging), but does not influence visuals.
  const rowDup = new Set();
  const colDup = new Set();

  for (let r = 0; r < N; r++) {
    const seen = new Map();
    for (let c = 0; c < N; c++) {
      const cell = grid[r][c];
      if (!cell) continue;
      const v = cell.value;
      const prevC = seen.get(v);
      if (prevC !== undefined) {
        rowDup.add(keyOf(r, prevC));
        rowDup.add(keyOf(r, c));
      } else {
        seen.set(v, c);
      }
    }
  }

  for (let c = 0; c < N; c++) {
    const seen = new Map();
    for (let r = 0; r < N; r++) {
      const cell = grid[r][c];
      if (!cell) continue;
      const v = cell.value;
      const prevR = seen.get(v);
      if (prevR !== undefined) {
        colDup.add(keyOf(prevR, c));
        colDup.add(keyOf(r, c));
      } else {
        seen.set(v, r);
      }
    }
  }

  return { rowDup, colDup };
}

// --- UI helpers ---

function isNumberTile(uiR, uiC) {
  return uiR % 2 === 0 && uiC % 2 === 0;
}

function isHoleTile(uiR, uiC) {
  return uiR % 2 === 1 && uiC % 2 === 1;
}

function uiToNum(uiR, uiC) {
  return { r: Math.floor(uiR / 2), c: Math.floor(uiC / 2) };
}

function numToUi(pos) {
  return { r: 2 * pos.r, c: 2 * pos.c };
}

function centerOfUiVar(uiPos, colSizes, rowSizes, gap) {
  let x = 0;
  for (let c = 0; c < uiPos.c; c++) x += colSizes[c] + gap;
  x += colSizes[uiPos.c] / 2;

  let y = 0;
  for (let r = 0; r < uiPos.r; r++) y += rowSizes[r] + gap;
  y += rowSizes[uiPos.r] / 2;

  return { x, y };
}

function sumTrackSizes(sizes, gap) {
  return sizes.reduce((acc, s) => acc + s, 0) + gap * (sizes.length - 1);
}

// --- Junction sum clues (placed on REMOVED number tiles) ---

function makeJunctionSumsFromSolution(solution, count = 12) {
  const candidates = [];

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (isActiveNumberCell(r, c)) continue; // only removed junctions

      const ui = { r: 2 * r, c: 2 * c };
      const combos = [
        { a: { r: r - 1, c }, b: { r, c: c - 1 } },
        { a: { r: r - 1, c }, b: { r, c: c + 1 } },
        { a: { r: r + 1, c }, b: { r, c: c - 1 } },
        { a: { r: r + 1, c }, b: { r, c: c + 1 } },
      ];

      for (const k of combos) {
        if (k.a.r < 0 || k.a.r >= N || k.a.c < 0 || k.a.c >= N) continue;
        if (k.b.r < 0 || k.b.r >= N || k.b.c < 0 || k.b.c >= N) continue;
        if (!isActiveNumberCell(k.a.r, k.a.c)) continue;
        if (!isActiveNumberCell(k.b.r, k.b.c)) continue;
        candidates.push({ ui, a: k.a, b: k.b });
      }
    }
  }

  const chosen = [];
  const usedTiles = new Set();
  const usedJunctions = new Set();

  for (const e of shuffled(candidates)) {
    if (chosen.length >= count) break;

    const junctionKey = `${e.ui.r},${e.ui.c}`;
    if (usedJunctions.has(junctionKey)) continue;

    const ka = keyOf(e.a.r, e.a.c);
    const kb = keyOf(e.b.r, e.b.c);
    if (usedTiles.has(ka) || usedTiles.has(kb)) continue;

    usedJunctions.add(junctionKey);
    usedTiles.add(ka);
    usedTiles.add(kb);

    chosen.push(e);
  }

  return chosen.map((e, i) => ({
    id: `S${i}`,
    ui: e.ui,
    a: e.a,
    b: e.b,
    sum: solution[e.a.r][e.a.c] + solution[e.b.r][e.b.c],
  }));
}

function validateJunctionSums(grid, sums) {
  const badSums = new Set();
  const badCells = new Set();

  for (const s of sums) {
    const a = grid[s.a.r][s.a.c];
    const b = grid[s.b.r][s.b.c];
    if (!a || !b) continue;
    if (a.value + b.value !== s.sum) {
      badSums.add(s.id);
      badCells.add(keyOf(s.a.r, s.a.c));
      badCells.add(keyOf(s.b.r, s.b.c));
    }
  }

  return { badSums, badCells };
}

function allActiveLocked(grid) {
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!isActiveNumberCell(r, c)) continue;
      const cell = grid[r][c];
      if (!cell || !cell.locked) return false;
    }
  }
  return true;
}

function SumClue({ sum }) {
  return (
    <div
      className="flex items-center justify-center rounded-full bg-neutral-200 text-[12px] font-semibold text-neutral-800 shadow-sm"
      style={{ width: 52, height: 26 }}
      aria-hidden
    >
      {sum}
    </div>
  );
}

function NumberTile({ tileSize, cell, movable, dragging, onDragStart, onDragEnd, onDrop, onDragOver, inert }) {
  const base = cell.locked ? "bg-green-200 text-green-900" : "bg-neutral-300 text-neutral-900";
  const ring = dragging ? " ring-4 ring-white/15" : "";
  const cursor = inert ? " cursor-not-allowed" : movable ? " cursor-grab active:cursor-grabbing" : " cursor-not-allowed";
  const opacity = inert ? " opacity-60" : movable ? "" : " opacity-90";

  return (
    <div
      draggable={!inert && movable}
      onDragStart={(e) => {
        if (inert || !movable) return;
        e.dataTransfer.setData("text/plain", "tile");
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={() => {
        if (inert) return;
        onDragEnd();
      }}
      onDragOver={(e) => {
        if (inert) return;
        onDragOver(e);
      }}
      onDrop={() => {
        if (inert) return;
        onDrop();
      }}
      className={
        "relative flex select-none items-center justify-center rounded-2xl shadow-sm transition " +
        base +
        ring +
        cursor +
        opacity
      }
      style={{ width: tileSize, height: tileSize }}
      title={cell.locked ? (cell.given ? "Locked (given)" : "Locked (earned)") : movable ? "Drag to swap" : "Not movable"}
    >
      <span className="text-2xl font-extrabold">{cell.value}</span>
      {cell.locked ? (
        <span className="absolute bottom-1 right-1 text-[10px] text-green-900/80">{cell.given ? "●" : "✓"}</span>
      ) : null}
    </div>
  );
}

// --- Tiny self-tests (run once) ---
function runSelfTests() {
  // 1) active cells partition
  let active = 0;
  let removed = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (isActiveNumberCell(r, c)) active++;
      else removed++;
    }
  }
  console.assert(active + removed === N * N, "Cell mask should partition the grid");

  // 2) solution validity: each row/col has 7 unique numbers
  const sol = makeRandomSolution();
  for (let r = 0; r < N; r++) console.assert(new Set(sol[r]).size === N, "Solution row should be unique");
  for (let c = 0; c < N; c++) {
    const col = [];
    for (let r = 0; r < N; r++) col.push(sol[r][c]);
    console.assert(new Set(col).size === N, "Solution col should be unique");
  }

  // 3) lockCount respected + no unlocked correct
  const g = makeStartGridFromSolution(sol, { lockCount: 4, maxAttempts: 2500 });
  console.assert(countLockedCells(g) === 4, "Expected lockCount locked cells");
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!isActiveNumberCell(r, c)) continue;
      const cell = g[r][c];
      if (!cell) continue;
      console.assert(typeof cell.id === "string", "Each tile should carry an id");
      if (!cell.locked) console.assert(cell.value !== sol[r][c], "Unlocked tile must not start correct");
    }
  }

  // 4) par moves sanity
  const par = computeParMoves(g);
  console.assert(par >= 0, "Par moves should be non-negative");

  // 5) sum pills uniqueness: no tile used twice
  const sums = makeJunctionSumsFromSolution(sol, 12);
  const used = new Set();
  for (const s of sums) {
    const a = keyOf(s.a.r, s.a.c);
    const b = keyOf(s.b.r, s.b.c);
    console.assert(!used.has(a), "Sum pills must not reuse a tile (a)");
    console.assert(!used.has(b), "Sum pills must not reuse a tile (b)");
    used.add(a);
    used.add(b);
  }
}

export default function App() {
  const [difficulty, setDifficulty] = useState("medium");

  const [lockCount, setLockCount] = useState(DIFFICULTY_PRESETS.medium.lockCount);
  const [sumCount, setSumCount] = useState(DIFFICULTY_PRESETS.medium.sumCount);

  // Lose-condition controls
  const [loseMode, setLoseMode] = useState("moves"); // none | moves | timer | both

  // Auto-balanced limits (derived from current puzzle par moves)
  const [parMoves, setParMoves] = useState(0);
  const [moveLimit, setMoveLimit] = useState(70);
  const [timeLimitSec, setTimeLimitSec] = useState(10 * 60);

  const [movesLeft, setMovesLeft] = useState(70);
  const [movesMade, setMovesMade] = useState(0);
  const [timeLeft, setTimeLeft] = useState(10 * 60);

  // End states (separate from modals so Close doesn't unfreeze the board)
  const [won, setWon] = useState(false);
  const [lost, setLost] = useState(false);
  const [showWinModal, setShowWinModal] = useState(false);
  const [showLoseModal, setShowLoseModal] = useState(false);
  const [loseReason, setLoseReason] = useState("");

  const [solution, setSolution] = useState(() => {
    runSelfTests();
    return makeRandomSolution();
  });

  const [junctionSums, setJunctionSums] = useState(() =>
    makeJunctionSumsFromSolution(solution, DIFFICULTY_PRESETS.medium.sumCount)
  );
  const [grid, setGrid] = useState(() =>
    makeStartGridFromSolution(solution, { lockCount: DIFFICULTY_PRESETS.medium.lockCount })
  );

  const [message, setMessage] = useState("Drag tiles to swap. ● givens are locked. Landing correct locks ✓.");
  const [dragFrom, setDragFrom] = useState(null);
  const [draggingKey, setDraggingKey] = useState(null);

  const inert = won || lost;

  const sumsByUi = useMemo(() => {
    const m = new Map();
    for (const s of junctionSums) m.set(`${s.ui.r},${s.ui.c}`, s);
    return m;
  }, [junctionSums]);

  // Still computed (kept for future debugging / enhancements)
  const { rowDup, colDup } = useMemo(() => validateRowCol(grid), [grid]);
  const { badSums, badCells } = useMemo(() => validateJunctionSums(grid, junctionSums), [grid, junctionSums]);
  void rowDup;
  void colDup;
  void badSums;
  void badCells;

  function isMovable(r, c) {
    const cell = grid[r][c];
    if (!cell) return false;
    return !cell.locked;
  }

  function computeLimits(difficultyKey, par) {
    const a = AUTO[difficultyKey] || AUTO.medium;
    const moves = clampInt(par + a.wiggleMoves, 5, 999);
    const time = clampInt(Math.ceil(par * a.secPerMove + a.timeBuf), 30, 60 * 60);
    return { moves, time };
  }

  function newGame(cfg = null) {
    const conf = cfg || { lockCount, sumCount, difficultyKey: difficulty };

    const sol = makeRandomSolution();
    const g = makeStartGridFromSolution(sol, { lockCount: conf.lockCount });
    const sums = makeJunctionSumsFromSolution(sol, conf.sumCount);

    // Auto-balance based on this puzzle
    const par = computeParMoves(g);
    const lim = computeLimits(conf.difficultyKey || difficulty, par);

    setSolution(sol);
    setGrid(g);
    setJunctionSums(sums);

    setParMoves(par);
    setMoveLimit(lim.moves);
    setTimeLimitSec(lim.time);

    // reset counters
    setMovesLeft(lim.moves);
    setMovesMade(0);
    setTimeLeft(lim.time);

    // reset end states
    setWon(false);
    setLost(false);
    setShowWinModal(false);
    setShowLoseModal(false);
    setLoseReason("");

    setDragFrom(null);
    setDraggingKey(null);
    setMessage("New puzzle. Drag tiles to swap.");
  }

  // Initialize auto limits for the initial grid once
  useEffect(() => {
    const par = computeParMoves(grid);
    const lim = computeLimits(difficulty, par);
    setParMoves(par);
    setMoveLimit(lim.moves);
    setTimeLimitSec(lim.time);
    setMovesLeft(lim.moves);
    setMovesMade(0);
    setTimeLeft(lim.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function endLose(reason) {
    setLost(true);
    setShowLoseModal(true);
    setLoseReason(reason);
    setMessage(reason);
  }

  function endWin() {
    setWon(true);
    setShowWinModal(true);
    setMessage("Solved! 🎉");
  }

  function swapTiles(a, b) {
    if (inert) return;
    if (a.r === b.r && a.c === b.c) return;

    const ca = grid[a.r][a.c];
    const cb = grid[b.r][b.c];
    if (!ca || !cb) {
      setMessage("You can only swap on active number tiles.");
      return;
    }

    if (!isMovable(a.r, a.c) || !isMovable(b.r, b.c)) {
      setMessage("Can’t move a locked tile.");
      return;
    }

    const next = cloneGrid(grid);

    // Swap BOTH value and id (tile identity)
    const tmpV = next[a.r][a.c].value;
    const tmpI = next[a.r][a.c].id;

    next[a.r][a.c].value = next[b.r][b.c].value;
    next[a.r][a.c].id = next[b.r][b.c].id;

    next[b.r][b.c].value = tmpV;
    next[b.r][b.c].id = tmpI;

    const afterLock = lockNewlyCorrectTiles(next, solution);

    // If this move completes the puzzle, win overrides lose checks.
    if (allActiveLocked(afterLock)) {
      setGrid(afterLock);
      endWin();
      return;
    }

    setGrid(afterLock);

    // Count a move (always) because a valid swap occurred
    setMovesMade((x) => x + 1);

    // Decrement remaining moves if that lose mode is enabled
    // (movesLeft is budget remaining; movesMade is total used)
    //
    // Decrement remaining moves if that lose mode is enabled
    if (loseMode === "moves" || loseMode === "both") {
      setMovesLeft((m) => {
        const nm = m - 1;
        if (nm <= 0) {
          endLose("Out of moves");
          return 0;
        }
        return nm;
      });
    }

    if (afterLock !== next) setMessage("Swapped — and some tiles locked in! ✓");
    else setMessage("Swapped.");
  }

  // Win detection (kept for safety; does NOT reopen modal if you close it)
  useEffect(() => {
    if (!won && !lost && allActiveLocked(grid)) {
      endWin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, won, lost]);

  // Countdown timer
  useEffect(() => {
    if (inert) return;
    if (loseMode !== "timer" && loseMode !== "both") return;

    const id = setInterval(() => {
      setTimeLeft((t) => {
        const nt = t - 1;
        if (nt <= 0) {
          endLose("Time ran out");
          return 0;
        }
        return nt;
      });
    }, 1000);

    return () => clearInterval(id);
  }, [loseMode, inert]);

  // Layout tuning
  const tile = 66; // number tiles + sum junction tiles (even UI indices)
  const spacer = 18; // spacer/holes tracks (odd UI indices)
  const gap = 4; // small gap between tracks
  const pad = 14; // tray padding

  const colSizes = useMemo(() => Array.from({ length: UI }, (_, i) => (i % 2 === 0 ? tile : spacer)), [tile, spacer]);
  const rowSizes = useMemo(() => Array.from({ length: UI }, (_, i) => (i % 2 === 0 ? tile : spacer)), [tile, spacer]);

  const W = sumTrackSizes(colSizes, gap);
  const H = sumTrackSizes(rowSizes, gap);
  const Wp = W + pad * 2;
  const Hp = H + pad * 2;

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-50">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold tracking-tight text-neutral-50">Waffle-Sudoku (junction sums)</h1>
            <p className="text-neutral-300">
              All movable tiles are the same light gray (no hints). Any tile that reaches its correct position locks and
              turns green (✓). Starting givens are marked with ●.
            </p>
          </header>

          <div className="flex flex-wrap items-center gap-3">
            <button
              className="rounded-xl bg-neutral-50/10 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-neutral-50/15"
              onClick={() => newGame()}
            >
              New puzzle
            </button>

            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-700 bg-neutral-800/60 px-3 py-2">
              <label className="text-xs font-semibold text-neutral-200">Difficulty</label>
              <select
                className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
                value={difficulty}
                onChange={(e) => {
                  const d = e.target.value;
                  setDifficulty(d);
                  const p = DIFFICULTY_PRESETS[d];
                  setLockCount(p.lockCount);
                  setSumCount(p.sumCount);
                  newGame({ ...p, difficultyKey: d });
                }}
              >
                {Object.keys(DIFFICULTY_PRESETS).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>

              <div className="hidden md:block h-5 w-px bg-neutral-700" />

              <label className="text-xs text-neutral-200">Locked</label>
              <input
                type="range"
                min={0}
                max={24}
                value={lockCount}
                onChange={(e) => setLockCount(parseInt(e.target.value, 10))}
              />
              <span className="text-xs tabular-nums text-neutral-200 w-6">{lockCount}</span>

              <label className="text-xs text-neutral-200">Sums</label>
              <input
                type="range"
                min={0}
                max={24}
                value={sumCount}
                onChange={(e) => setSumCount(parseInt(e.target.value, 10))}
              />
              <span className="text-xs tabular-nums text-neutral-200 w-6">{sumCount}</span>

              <div className="hidden md:block h-5 w-px bg-neutral-700" />

              <label className="text-xs font-semibold text-neutral-200">Lose</label>
              <select
                className="rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
                value={loseMode}
                onChange={(e) => setLoseMode(e.target.value)}
                title="Choose how you can lose"
              >
                {Object.entries(LOSE_MODES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>

              {(loseMode === "moves" || loseMode === "both") && (
                <>
                  <label className="text-xs text-neutral-200">Moves</label>
                  <input type="range" min={5} max={200} value={moveLimit} disabled title="Auto-balanced" />
                  <span className="text-xs tabular-nums text-neutral-200 w-10">{movesLeft}</span>
                </>
              )}

              {(loseMode === "timer" || loseMode === "both") && (
                <>
                  <label className="text-xs text-neutral-200">Time</label>
                  <input type="range" min={60} max={30 * 60} step={30} value={timeLimitSec} disabled title="Auto-balanced" />
                  <span className="text-xs tabular-nums text-neutral-200 w-12">{fmtTime(timeLeft)}</span>
                </>
              )}

              <button
                className="ml-1 rounded-lg bg-neutral-900 px-2 py-1 text-xs font-semibold text-neutral-100 shadow-sm border border-neutral-700 hover:bg-neutral-800"
                onClick={() => newGame({ lockCount, sumCount, difficultyKey: difficulty })}
                title="Apply the current slider settings (auto-balances moves/time for this puzzle)"
              >
                Apply
              </button>
            </div>

            <div className="text-sm text-neutral-200">
              {message}
              <span className="ml-3 text-xs text-neutral-300">Par: {parMoves} swaps</span>
              {(loseMode === "moves" || loseMode === "both") && (
                <span className="ml-3 text-xs text-neutral-300">
                  Moves: {movesMade}/{moveLimit} (Δ {movesMade - parMoves >= 0 ? "+" : ""}{movesMade - parMoves} vs par)
                </span>
              )}
              {(loseMode === "timer" || loseMode === "both") && (
                <span className="ml-3 text-xs text-neutral-300">Time left: {fmtTime(timeLeft)}</span>
              )}
              {inert ? <span className="ml-3 text-xs text-neutral-400">(Board frozen)</span> : null}
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-700 bg-neutral-800/60 p-4 shadow-sm">
            <div className="text-sm text-neutral-300">
              <span className="font-medium text-neutral-100">Drag rules:</span> Swap any two tiles anywhere, as long as
              neither tile is locked.
            </div>

            <div className="mt-4">
              <div
                className="relative rounded-3xl bg-neutral-700/50 shadow-inner ring-1 ring-neutral-600"
                style={{ width: Wp, height: Hp, padding: pad }}
              >
                {/* Always-on pointers for every sum */}
                <svg
                  className="pointer-events-none absolute left-0 top-0 z-0"
                  width={Wp}
                  height={Hp}
                  viewBox={`0 0 ${Wp} ${Hp}`}
                >
                  <defs>
                    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.55)" />
                    </marker>
                  </defs>

                  {junctionSums.map((s) => {
                    const sumCenter0 = centerOfUiVar(s.ui, colSizes, rowSizes, gap);
                    const aCenter0 = centerOfUiVar(numToUi(s.a), colSizes, rowSizes, gap);
                    const bCenter0 = centerOfUiVar(numToUi(s.b), colSizes, rowSizes, gap);

                    const sumCenter = { x: sumCenter0.x + pad, y: sumCenter0.y + pad };
                    const aCenter = { x: aCenter0.x + pad, y: aCenter0.y + pad };
                    const bCenter = { x: bCenter0.x + pad, y: bCenter0.y + pad };

                    return (
                      <g key={s.id}>
                        <line
                          x1={sumCenter.x}
                          y1={sumCenter.y}
                          x2={aCenter.x}
                          y2={aCenter.y}
                          stroke="rgba(255,255,255,0.55)"
                          strokeWidth="4"
                          markerEnd="url(#arrow)"
                        />
                        <line
                          x1={sumCenter.x}
                          y1={sumCenter.y}
                          x2={bCenter.x}
                          y2={bCenter.y}
                          stroke="rgba(255,255,255,0.55)"
                          strokeWidth="4"
                          markerEnd="url(#arrow)"
                        />
                      </g>
                    );
                  })}
                </svg>

                <div
                  className="grid relative z-10"
                  style={{
                    gridTemplateColumns: colSizes.map((s) => `${s}px`).join(" "),
                    gridTemplateRows: rowSizes.map((s) => `${s}px`).join(" "),
                    gap,
                  }}
                >
                  {Array.from({ length: UI * UI }, (_, idx) => {
                    const uiR = Math.floor(idx / UI);
                    const uiC = idx % UI;

                    // Corner holes: invisible/flush
                    if (isHoleTile(uiR, uiC)) {
                      return (
                        <div
                          key={`h-${uiR}-${uiC}`}
                          className="bg-transparent"
                          style={{ width: "100%", height: "100%" }}
                          aria-hidden
                        />
                      );
                    }

                    // Number positions
                    if (isNumberTile(uiR, uiC)) {
                      const p = uiToNum(uiR, uiC);

                      // Removed junction: show sum pill if exists; otherwise invisible.
                      if (!isActiveNumberCell(p.r, p.c)) {
                        const s = sumsByUi.get(`${uiR},${uiC}`);
                        if (!s) {
                          return (
                            <div
                              key={`m-${uiR}-${uiC}`}
                              className="rounded-xl bg-transparent"
                              style={{ width: "100%", height: "100%" }}
                              aria-hidden
                              title="Unused"
                            />
                          );
                        }

                        return (
                          <div
                            key={`mj-${uiR}-${uiC}`}
                            className="relative z-20 flex items-center justify-center rounded-xl bg-transparent"
                            style={{ width: "100%", height: "100%" }}
                            title={`Sum between (${s.a.r + 1},${s.a.c + 1}) and (${s.b.r + 1},${s.b.c + 1})`}
                          >
                            <SumClue sum={s.sum} />
                          </div>
                        );
                      }

                      // Active number tile
                      const cell = grid[p.r][p.c];
                      const k = keyOf(p.r, p.c);
                      const movable = isMovable(p.r, p.c);
                      const dragging = draggingKey === k;

                      return (
                        <NumberTile
                          key={`n-${uiR}-${uiC}`}
                          tileSize={tile}
                          cell={cell}
                          movable={movable}
                          dragging={dragging}
                          inert={inert}
                          onDragStart={() => {
                            setDragFrom({ r: p.r, c: p.c });
                            setDraggingKey(k);
                            setMessage("Dragging… drop onto another movable tile to swap.");
                          }}
                          onDragEnd={() => {
                            setDragFrom(null);
                            setDraggingKey(null);
                          }}
                          onDragOver={(e) => {
                            if (!dragFrom) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                          }}
                          onDrop={() => {
                            if (!dragFrom) return;
                            swapTiles(dragFrom, { r: p.r, c: p.c });
                            setDragFrom(null);
                            setDraggingKey(null);
                          }}
                        />
                      );
                    }

                    // Spacer slots: invisible/flush
                    return (
                      <div
                        key={`s-${uiR}-${uiC}`}
                        className="bg-transparent"
                        style={{ width: "100%", height: "100%" }}
                        aria-hidden
                      />
                    );
                  })}
                </div>
              </div>

              <div className="mt-3 text-xs text-neutral-400">
                ● = given locked. ✓ = earned locked. Par = estimated optimal swaps for this start.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Win modal */}
      {showWinModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-5 shadow-xl ring-1 ring-neutral-700">
            <div className="text-lg font-bold">Puzzle complete 🎉</div>
            <div className="mt-2 text-sm text-neutral-300">All tiles are locked in their correct positions.</div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-neutral-800"
                onClick={() => setShowWinModal(false)}
              >
                Close
              </button>
              <button
                className="rounded-xl bg-neutral-50/10 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-50/15"
                onClick={() => newGame({ lockCount, sumCount, difficultyKey: difficulty })}
              >
                New game
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Lose modal */}
      {showLoseModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-5 shadow-xl ring-1 ring-neutral-700">
            <div className="text-lg font-bold">Game over</div>
            <div className="mt-2 text-sm text-neutral-300">{loseReason || "You lost."}</div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-neutral-800"
                onClick={() => setShowLoseModal(false)}
              >
                Close
              </button>
              <button
                className="rounded-xl bg-neutral-50/10 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-50/15"
                onClick={() => newGame({ lockCount, sumCount, difficultyKey: difficulty })}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
