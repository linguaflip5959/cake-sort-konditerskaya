/**
 * Cake Sort — «Кондитерская»
 * Слой 2 (ТЗ п. 9.1): правила. Соседство, валидность размещения (в том числе
 * двойной тарелки), детерминированная автосортировка (ТЗ 5.1–5.7), конец
 * партии (ТЗ 6). Ни Three.js, ни GSAP — слой тестируется в Node
 * (scripts/pz-tests.ts).
 */

import {
  CAP,
  cloneTrayItem,
  type CellIndex,
  type EndReason,
  type Flavor,
  type GPlate,
  type GState,
  type LevelData,
  type Orientation,
  type Transfer,
} from './types';

/* ------------------------------------------------------------------ */
/* Соседство и свободные ячейки                                        */
/* ------------------------------------------------------------------ */

/** Ортогональные соседи ячейки: сверху, справа, снизу, слева (ТЗ 5.1) */
export function neighborCells(cols: number, rows: number, cell: CellIndex): CellIndex[] {
  const r = Math.floor(cell / cols);
  const c = cell % cols;
  const out: CellIndex[] = [];
  if (r > 0) out.push(cell - cols);
  if (c < cols - 1) out.push(cell + 1);
  if (r < rows - 1) out.push(cell + cols);
  if (c > 0) out.push(cell - 1);
  return out;
}

export function freeCells(state: GState): CellIndex[] {
  const out: CellIndex[] = [];
  for (let i = 0; i < state.board.length; i++) if (!state.board[i]) out.push(i);
  return out;
}

/** Разрешено ли размещение обычной тарелки: ячейка в границах и свободна (ТЗ 4.2, 6.1) */
export function canPlace(state: GState, cell: CellIndex): boolean {
  return cell >= 0 && cell < state.board.length && state.board[cell] === null;
}

/** Свободная соседняя пара ячеек: a — левая/верхняя, horiz — пара по строке */
export interface FreePair {
  a: CellIndex;
  b: CellIndex;
  horiz: boolean;
}

/** Все пары свободных ортогонально соседних ячеек (для двойной тарелки) */
export function adjacentFreePairs(state: GState): FreePair[] {
  const out: FreePair[] = [];
  const { rows, cols, board } = state;
  for (let cell = 0; cell < board.length; cell++) {
    if (board[cell]) continue;
    const right = cell % cols < cols - 1 ? cell + 1 : -1;
    if (right >= 0 && !board[right]) out.push({ a: cell, b: right, horiz: true });
    const down = cell + cols < rows * cols ? cell + cols : -1;
    if (down >= 0 && !board[down]) out.push({ a: cell, b: down, horiz: false });
  }
  return out;
}

/** Допустима ли пара ячеек для двойной тарелки: обе свободны и соседние (ТЗ п. 3.3) */
export function canPlaceDoubleAt(state: GState, c1: CellIndex, c2: CellIndex): boolean {
  if (!canPlace(state, c1) || !canPlace(state, c2) || c1 === c2) return false;
  return neighborCells(state.cols, state.rows, c1).includes(c2);
}

/* ------------------------------------------------------------------ */
/* Автосортировка                                                      */
/* ------------------------------------------------------------------ */

function flavorCount(p: GPlate, f: Flavor): number {
  let n = 0;
  for (const s of p.slices) if (s.flavor === f) n++;
  return n;
}

/** Вкусы, присутствующие на обеих тарелках, по возрастанию id (ТЗ 5.6) */
function sharedFlavors(a: GPlate, b: GPlate): Flavor[] {
  const has = new Set<Flavor>();
  for (const s of a.slices) has.add(s.flavor);
  const out: Flavor[] = [];
  for (const s of b.slices) if (has.has(s.flavor) && !out.includes(s.flavor)) out.push(s.flavor);
  return out.sort((x, y) => x - y);
}

/**
 * Получатель сегментов (ТЗ 5.4, итерация 2 п. 3.6):
 * 1) тарелка с большим числом кусочков данного вкуса;
 * 2) при равенстве — тарелка, размещённая в текущем ходе (для двойной
 *    размещённых может быть две — тогда побеждает меньший индекс ячейки);
 * 3) иначе минимальный индекс ячейки.
 */
export function chooseRecipient(
  state: GState,
  a: CellIndex,
  b: CellIndex,
  flavor: Flavor,
  lastPlaced: readonly CellIndex[] | null,
): CellIndex {
  const pa = state.board[a];
  const pb = state.board[b];
  if (!pa || !pb) throw new Error('chooseRecipient: both cells must hold plates');
  const ca = flavorCount(pa, flavor);
  const cb = flavorCount(pb, flavor);
  if (ca > cb) return a;
  if (cb > ca) return b;
  if (lastPlaced && lastPlaced.length > 0) {
    const aPlaced = lastPlaced.includes(a);
    const bPlaced = lastPlaced.includes(b);
    if (aPlaced !== bPlaced) return aPlaced ? a : b;
  }
  return Math.min(a, b);
}

/**
 * Следующий атомарный перенос или null. Детерминированный порядок (ТЗ 5.6):
 * ячейки — по строкам сверху вниз, слева направо; пары — направления
 * «вправо, вниз» (каждая пара рассматривается один раз); вкусы — по возрастанию.
 * Одинаковый вход всегда даёт одинаковый результат.
 */
export function planNextTransfer(state: GState, lastPlaced: readonly CellIndex[] | null): Transfer | null {
  const { rows, cols, board } = state;
  for (let cell = 0; cell < board.length; cell++) {
    const p = board[cell];
    if (!p) continue;
    const right = cell % cols < cols - 1 ? cell + 1 : -1;
    const down = cell + cols < rows * cols ? cell + cols : -1;
    for (const nb of [right, down]) {
      if (nb < 0) continue;
      const q = board[nb];
      if (!q) continue;
      for (const f of sharedFlavors(p, q)) {
        const recipient = chooseRecipient(state, cell, nb, f, lastPlaced);
        const donorCell = recipient === cell ? nb : cell;
        const donor = board[donorCell];
        const recv = board[recipient];
        if (!donor || !recv) continue;
        const space = CAP - recv.slices.length;
        const count = Math.min(space, flavorCount(donor, f));
        if (count > 0) return { from: donorCell, to: recipient, flavor: f, count };
      }
    }
  }
  return null;
}

/**
 * Применить перенос: с донора уходят последние вхождения вкуса
 * (визуально — верхние кусочки), получатель принимает в конец списка.
 * Опустевшая тарелка удаляется с поля (ТЗ 6.2).
 */
export function applyTransfer(state: GState, t: Transfer): void {
  const donor = state.board[t.from];
  const recv = state.board[t.to];
  if (!donor || !recv) throw new Error('applyTransfer: missing plate');
  let moved = 0;
  for (let i = donor.slices.length - 1; i >= 0 && moved < t.count; i--) {
    if (donor.slices[i].flavor === t.flavor) {
      const [s] = donor.slices.splice(i, 1);
      recv.slices.push(s);
      moved++;
    }
  }
  if (moved !== t.count) throw new Error(`applyTransfer: planned ${t.count}, moved ${moved}`);
  if (donor.slices.length === 0) state.board[t.from] = null;
}

/** Тарелка с шестью одинаковыми кусочками (ТЗ 5.7) */
export function findCompletion(state: GState): { cell: CellIndex; flavor: Flavor } | null {
  for (let i = 0; i < state.board.length; i++) {
    const p = state.board[i];
    if (!p || p.slices.length !== CAP) continue;
    const f = p.slices[0].flavor;
    if (p.slices.every((s) => s.flavor === f)) return { cell: i, flavor: f };
  }
  return null;
}

/** Удалить собранный торт из данных и освободить ячейку (ТЗ 5.7.3–5) */
export function applyCompletion(state: GState, cell: CellIndex): void {
  state.board[cell] = null;
  state.completed += 1;
}

/* ------------------------------------------------------------------ */
/* Размещение из очереди (обычная и двойная тарелка)                   */
/* ------------------------------------------------------------------ */

/** Ход: разместить элемент очереди. cells — одна ячейка для обычной
 *  тарелки, две ([ячейка A, ячейка B]) для двойной (ТЗ п. 3.2–3.4). */
export interface Move {
  trayIdx: number;
  cells: CellIndex[];
  /** ориентация двойной тарелки (0..3); null для обычной */
  orientation: Orientation | null;
}

function makePlate(state: GState, flavors: Flavor[], cell: CellIndex): GPlate {
  const plate: GPlate = {
    id: state.nextPlateId++,
    cell,
    slices: flavors.map((f) => ({ id: state.nextSliceId++, flavor: f })),
  };
  state.board[cell] = plate;
  return plate;
}

function validatePlateSize(flavors: Flavor[], what: string): void {
  if (flavors.length < 1 || flavors.length > CAP) {
    throw new Error(`${what}: bad plate size ${flavors.length}`);
  }
}

/** Разместить обычную тарелку из очереди в свободную ячейку */
export function placeSingle(state: GState, trayIdx: number, cell: CellIndex): GPlate {
  const item = state.tray[trayIdx];
  if (!item || item.kind !== 'single') throw new Error('placeSingle: expected single tray item');
  if (!canPlace(state, cell)) throw new Error('placeSingle: cell is occupied');
  validatePlateSize(item.slices, 'placeSingle');
  state.tray.splice(trayIdx, 1);
  return makePlate(state, item.slices, cell);
}

/** Разместить двойную тарелку на пару свободных соседних ячеек (ТЗ п. 3.3) */
export function placeDouble(state: GState, trayIdx: number, cellA: CellIndex, cellB: CellIndex): [GPlate, GPlate] {
  const item = state.tray[trayIdx];
  if (!item || item.kind !== 'double') throw new Error('placeDouble: expected double tray item');
  if (!canPlaceDoubleAt(state, cellA, cellB)) throw new Error('placeDouble: cells must be free and adjacent');
  validatePlateSize(item.a, 'placeDouble:a');
  validatePlateSize(item.b, 'placeDouble:b');
  state.tray.splice(trayIdx, 1);
  return [makePlate(state, item.a, cellA), makePlate(state, item.b, cellB)];
}

/** Применить ход: размещение элемента очереди по определению mv */
export function applyTrayMove(state: GState, mv: Move): GPlate[] {
  const item = state.tray[mv.trayIdx];
  if (!item) throw new Error('applyTrayMove: bad tray index');
  if (item.kind === 'single') {
    if (mv.cells.length !== 1) throw new Error('applyTrayMove: single needs exactly 1 cell');
    return [placeSingle(state, mv.trayIdx, mv.cells[0])];
  }
  if (mv.cells.length !== 2) throw new Error('applyTrayMove: double needs exactly 2 cells');
  return placeDouble(state, mv.trayIdx, mv.cells[0], mv.cells[1]);
}

/**
 * Все допустимые ходы из видимого окна очереди (3 тарелки).
 * Для двойной тарелки перебираются все свободные соседние пары и все
 * 4 ориентации: горизонтали — 0 (A слева) и 2 (A справа),
 * вертикали — 1 (A сверху) и 3 (A снизу) — ТЗ п. 3.4, 3.7.
 */
export function legalMoves(state: GState): Move[] {
  const out: Move[] = [];
  const frees = freeCells(state);
  const window = Math.min(3, state.tray.length);
  for (let ti = 0; ti < window; ti++) {
    const item = state.tray[ti];
    if (item.kind === 'single') {
      for (const c of frees) out.push({ trayIdx: ti, cells: [c], orientation: null });
    } else {
      for (const pair of adjacentFreePairs(state)) {
        if (pair.horiz) {
          out.push({ trayIdx: ti, cells: [pair.a, pair.b], orientation: 0 });
          out.push({ trayIdx: ti, cells: [pair.b, pair.a], orientation: 2 });
        } else {
          out.push({ trayIdx: ti, cells: [pair.a, pair.b], orientation: 1 });
          out.push({ trayIdx: ti, cells: [pair.b, pair.a], orientation: 3 });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Разрешение хода и конец партии                                      */
/* ------------------------------------------------------------------ */

/**
 * Полное разрешение хода (ТЗ 5.5): завершение полной тарелки → перенос →
 * торт → повтор, пока есть допустимые переносы. lastPlaced — ячейки,
 * размещённые в текущем ходе (одна или две, ТЗ итерации 2 п. 3.6).
 * Гарантированно завершается: каждый перенос обнуляет вкус у донора.
 * Возвращает счётчики для эвристики солвера.
 */
export function resolveTurn(state: GState, lastPlaced: readonly CellIndex[]): { transfers: number; cakes: number } {
  let transfers = 0;
  let cakes = 0;
  const done0 = findCompletion(state);
  if (done0) {
    applyCompletion(state, done0.cell);
    cakes++;
  }
  for (;;) {
    const t = planNextTransfer(state, lastPlaced);
    if (!t) break;
    applyTransfer(state, t);
    transfers++;
    const done = findCompletion(state);
    if (done) {
      applyCompletion(state, done.cell);
      cakes++;
    }
  }
  return { transfers, cakes };
}

/**
 * Итог хода: победа, поражение (с причиной) или играем дальше (ТЗ 6.3,
 * итерация 2 п. 3.7). Поражение full наступает и тогда, когда в видимом
 * окне очереди только двойные тарелки, а свободные ячейки не образуют
 * ни одной соседней пары.
 */
export function evalEnd(state: GState): { phase: 'playing' | 'won' } | { phase: 'lost'; reason: EndReason } {
  const anyPlate = state.board.some((p) => p !== null);
  if (!anyPlate && state.tray.length === 0) return { phase: 'won' };
  if (state.tray.length === 0) return { phase: 'lost', reason: 'leftover' };
  const frees = freeCells(state);
  if (frees.length === 0) return { phase: 'lost', reason: 'full' };
  const window = Math.min(3, state.tray.length);
  let onlyDoubles = true;
  for (let i = 0; i < window; i++) {
    if (state.tray[i].kind === 'single') {
      onlyDoubles = false;
      break;
    }
  }
  if (onlyDoubles && adjacentFreePairs(state).length === 0) return { phase: 'lost', reason: 'full' };
  return { phase: 'playing' };
}

/* ------------------------------------------------------------------ */
/* Уровень: построение состояния                                       */
/* ------------------------------------------------------------------ */

/** Всего тортов в уровне: общее число кусочков / 6 */
export function totalCakes(level: LevelData): number {
  let total = 0;
  for (const p of level.initial) total += p.slices.length;
  for (const it of level.tray) total += it.kind === 'single' ? it.slices.length : it.a.length + it.b.length;
  return total / CAP;
}

/** Начальное состояние партии по данным уровня */
export function createInitialState(level: LevelData): GState {
  const board: Array<GPlate | null> = new Array(level.rows * level.cols).fill(null);
  const state: GState = {
    rows: level.rows,
    cols: level.cols,
    board,
    tray: level.tray.map(cloneTrayItem),
    completed: 0,
    nextPlateId: 1,
    nextSliceId: 1,
  };
  for (const ini of level.initial) {
    const cell = ini.row * level.cols + ini.col;
    if (cell < 0 || cell >= board.length) throw new Error('level: initial plate out of bounds');
    if (board[cell]) throw new Error('level: two initial plates in one cell');
    board[cell] = {
      id: state.nextPlateId++,
      cell,
      slices: ini.slices.map((f) => ({ id: state.nextSliceId++, flavor: f })),
    };
  }
  return state;
}

/** Глубокая копия состояния (для солвера и тестов стабильности) */
export function cloneState(s: GState): GState {
  return {
    rows: s.rows,
    cols: s.cols,
    board: s.board.map((p) => (p ? { id: p.id, cell: p.cell, slices: p.slices.map((x) => ({ ...x })) } : null)),
    tray: s.tray.map(cloneTrayItem),
    completed: s.completed,
    nextPlateId: s.nextPlateId,
    nextSliceId: s.nextSliceId,
  };
}
