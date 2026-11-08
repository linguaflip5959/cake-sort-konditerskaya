/**
 * Cake Sort — «Кондитерская»
 * Слой 2 (ТЗ п. 9.1): правила. Соседство, валидность размещения,
 * детерминированная автосортировка (ТЗ 5.1–5.7), конец партии (ТЗ 6).
 * Ни Three.js, ни GSAP — слой тестируется в Node (scripts/pz-tests.ts).
 */

import {
  CAP,
  type CellIndex,
  type EndReason,
  type Flavor,
  type GPlate,
  type GState,
  type Transfer,
} from './types';

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

/** Разрешено ли размещение: ячейка в границах и свободна (ТЗ 4.2, 6.1) */
export function canPlace(state: GState, cell: CellIndex): boolean {
  return cell >= 0 && cell < state.board.length && state.board[cell] === null;
}

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
 * Получатель сегментов (ТЗ 5.4):
 * 1) тарелка с большим числом кусочков данного вкуса;
 * 2) при равенстве — тарелка, размещённая в текущем ходе;
 * 3) иначе меньший индекс строки, затем столбца (минимальный индекс ячейки).
 */
export function chooseRecipient(
  state: GState,
  a: CellIndex,
  b: CellIndex,
  flavor: Flavor,
  lastPlaced: CellIndex | null,
): CellIndex {
  const pa = state.board[a];
  const pb = state.board[b];
  if (!pa || !pb) throw new Error('chooseRecipient: both cells must hold plates');
  const ca = flavorCount(pa, flavor);
  const cb = flavorCount(pb, flavor);
  if (ca > cb) return a;
  if (cb > ca) return b;
  if (lastPlaced !== null) {
    if (a === lastPlaced) return a;
    if (b === lastPlaced) return b;
  }
  return Math.min(a, b);
}

/**
 * Следующий атомарный перенос или null. Детерминированный порядок (ТЗ 5.6):
 * ячейки — по строкам сверху вниз, слева направо; пары — направления
 * «вправо, вниз» (каждая пара рассматривается один раз); вкусы — по возрастанию.
 * Одинаковый вход всегда даёт одинаковый результат.
 */
export function planNextTransfer(state: GState, lastPlaced: CellIndex | null): Transfer | null {
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

/** Разместить тарелку из очереди в свободную ячейку (ход игрока) */
export function placePlate(state: GState, trayIdx: number, cell: CellIndex): GPlate {
  if (trayIdx < 0 || trayIdx >= state.tray.length) throw new Error('placePlate: bad tray index');
  if (!canPlace(state, cell)) throw new Error('placePlate: cell is occupied');
  const flavors = state.tray[trayIdx];
  if (flavors.length < 1 || flavors.length > CAP) throw new Error('placePlate: bad plate size');
  state.tray.splice(trayIdx, 1);
  const plate: GPlate = {
    id: state.nextPlateId++,
    cell,
    slices: flavors.map((f) => ({ id: state.nextSliceId++, flavor: f })),
  };
  state.board[cell] = plate;
  return plate;
}

/**
 * Полное разрешение хода (ТЗ 5.5): завершение полной тарелки → перенос →
 * торт → повтор, пока есть допустимые переносы. Гарантированно завершается:
 * каждый перенос обнуляет вкус у донора, пары не повторяются.
 * Возвращает счётчики для эвристики солвера.
 */
export function resolveTurn(state: GState, lastPlaced: CellIndex): { transfers: number; cakes: number } {
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

/** Итог хода: победа, поражение (с причиной) или играем дальше (ТЗ 6.3) */
export function evalEnd(state: GState): { phase: 'playing' | 'won' } | { phase: 'lost'; reason: EndReason } {
  const anyPlate = state.board.some((p) => p !== null);
  if (!anyPlate && state.tray.length === 0) return { phase: 'won' };
  if (state.tray.length === 0) return { phase: 'lost', reason: 'leftover' };
  if (freeCells(state).length === 0) return { phase: 'lost', reason: 'full' };
  return { phase: 'playing' };
}

/** Глубокая копия состояния (для солвера и тестов стабильности) */
export function cloneState(s: GState): GState {
  return {
    rows: s.rows,
    cols: s.cols,
    board: s.board.map((p) => (p ? { id: p.id, cell: p.cell, slices: p.slices.map((x) => ({ ...x })) } : null)),
    tray: s.tray.map((t) => [...t]),
    completed: s.completed,
    nextPlateId: s.nextPlateId,
    nextSliceId: s.nextSliceId,
  };
}
