/**
 * Cake Sort — «Кондитерская»
 * Слой 2 (ТЗ п. 9.1): правила. Соседство, валидность размещения (в том числе
 * двойной тарелки), детерминированная автосортировка (ТЗ 5.1–5.7), конец
 * партии (ТЗ 6). Ни Three.js, ни GSAP — слой тестируется в Node
 * (scripts/pz-tests.ts).
 */

import {
  CAP,
  WINDOW,
  cloneTrayItem,
  DEFAULT_CASCADE_CONFIG,
  type CascadeConfig,
  type CellIndex,
  type EndReason,
  type Flavor,
  type GPlate,
  type GState,
  type LevelData,
  type Orientation,
  type Transfer,
  type TurnEvent,
} from './types';

/* ------------------------------------------------------------------ */
/* Очки (итерация 3)                                                   */
/* ------------------------------------------------------------------ */

/** Базовые очки за собранный торт */
export const CAKE_POINTS = 100;
/** Бонус за каждый следующий торт в одном ходу (комбо) */
export const COMBO_BONUS = 25;
/** Очки за каждый перелетевший кусочек (автосортировка) */
export const MERGE_POINTS = 2;

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

/** Различные вкусы тарелки по возрастанию */
function distinctFlavors(p: GPlate): Flavor[] {
  const out: Flavor[] = [];
  for (const s of p.slices) if (!out.includes(s.flavor)) out.push(s.flavor);
  return out.sort((x, y) => x - y);
}

/** Свободное место на тарелке */
function freeSpace(p: GPlate): number {
  return CAP - p.slices.length;
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

/* ------------------------------------------------------------------ */
/* Цепочки соседних тарелок (новое правило)                            */
/* ------------------------------------------------------------------ */

/**
 * Цепочечный перенос от тарелки start (правило соседних тарелок):
 * кусочки вкуса flavor перелетают на ДАЛЬНЮЮ тарелку, если маршрут до неё
 * идёт по соседним тарелкам со свободным местом (транзит), а получатель
 * держит тот же вкус. Направление — как у прямого переноса: побеждает
 * тарелка, где этого вкуса больше (chooseRecipient). Маршрут — BFS:
 * кратчайший и детерминированный.
 *
 * Тарелка start сама может быть и получателем (тогда донор — найденная
 * тарелка, маршрут разворачивается). Полные тарелки не пропускают
 * кусочки через себя, но сами отдавать могут.
 *
 * Этап B: maxHops ограничивает дальность маршрута (1 — только прямые
 * соседи, 2 — один транзит; Infinity — без ограничения, как до Этапа B).
 * Кандидаты на глубине ≤ maxHops принимаются, глубже BFS не расширяется
 * (семантика H-вариантов аудита §5).
 */
function planChainFrom(
  state: GState,
  start: CellIndex,
  flavor: Flavor,
  lastPlaced: readonly CellIndex[] | null,
  maxHops: number = Infinity,
): Transfer | null {
  const { cols, rows, board } = state;
  const startPlate = board[start];
  if (!startPlate || flavorCount(startPlate, flavor) === 0) return null;

  const parent = new Map<CellIndex, CellIndex>();
  const depth = new Map<CellIndex, number>([[start, 0]]);
  const visited = new Set<CellIndex>([start]);
  const queue: CellIndex[] = [start];

  for (let qi = 0; qi < queue.length; qi++) {
    const cell = queue[qi];
    const d = depth.get(cell)!;
    const plate = board[cell];
    if (!plate) continue;
    const hasFlavor = flavorCount(plate, flavor) > 0;
    const space = freeSpace(plate);

    if (cell !== start && hasFlavor) {
      // кандидат в пару: восстановить маршрут start → cell
      const path: CellIndex[] = [];
      for (let c: CellIndex | undefined = cell; c !== undefined; c = parent.get(c)) {
        path.push(c);
        if (c === start) break;
      }
      path.reverse(); // [start, …транзиты…, cell]
      const recipient = chooseRecipient(state, start, cell, flavor, lastPlaced);
      if (recipient === start) {
        // start — получатель: донор cell, маршрут разворачивается
        const count = Math.min(freeSpace(startPlate), flavorCount(plate, flavor));
        if (count > 0) return { from: cell, to: start, flavor, count, path: [...path].reverse() };
      } else {
        // cell — получатель: донор start
        const count = Math.min(space, flavorCount(startPlate, flavor));
        if (count > 0) return { from: start, to: cell, flavor, count, path };
      }
      // пара не сложилась (например, получатель полон) — cell может
      // остаться транзитом, если на нём есть место
    }

    // транзит — только через тарелки со свободным местом; сама start
    // может быть полна: она конец маршрута, а не транзит
    if (cell !== start && space === 0) continue;
    if (d >= maxHops) continue; // глубже не расширяем (кандидаты до maxHops включительно)
    for (const nb of neighborCells(cols, rows, cell)) {
      if (!visited.has(nb) && board[nb]) {
        visited.add(nb);
        parent.set(nb, cell);
        depth.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  return null;
}

/** Конфиг цепной реакции состояния (или умолчание) */
function cascadeOf(state: GState, cfg?: CascadeConfig): CascadeConfig {
  return cfg ?? state.cascade ?? DEFAULT_CASCADE_CONFIG;
}

/**
 * Следующий атомарный перенос или null. Детерминированный порядок (ТЗ 5.6):
 * сначала прямые переносы между соседями — ячейки по строкам, пары
 * «вправо, вниз», вкусы по возрастанию; затем цепочки — тот же порядок
 * обхода, маршрут кратчайший (BFS). Одинаковый вход всегда даёт
 * одинаковый результат.
 *
 * Этап B (аудит §6.2–6.3): конфиг задаёт, искать ли цепочки
 * (allowChainTransfers), максимальную дальность маршрута в «прыжках»
 * (maxChainHops: 1 — только прямые, 2 — один транзит) и приоритет
 * прямых переносов (directTransferPriority). Умолчание воспроизводит
 * поведение до Этапа B.
 */
export function planNextTransfer(
  state: GState,
  lastPlaced: readonly CellIndex[] | null,
  cfg?: CascadeConfig,
): Transfer | null {
  const config = cascadeOf(state, cfg);
  const { rows, cols, board } = state;
  // прямые переносы — отдельным проходом, если приоритет включён или
  // цепочки запрещены (иначе прямых соседей находит и цепочный проход)
  if (config.directTransferPriority || !config.allowChainTransfers) {
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
          if (count > 0) return { from: donorCell, to: recipient, flavor: f, count, path: [donorCell, recipient] };
        }
      }
    }
  }
  if (!config.allowChainTransfers) return null;
  // цепочки: несоседние тарелки, связанные маршрутом через свободные места;
  // глубина BFS ограничена maxChainHops (кандидаты на глубине ≤ maxChainHops)
  for (let cell = 0; cell < board.length; cell++) {
    const p = board[cell];
    if (!p) continue;
    for (const f of distinctFlavors(p)) {
      const chain = planChainFrom(state, cell, f, lastPlaced, config.maxChainHops);
      if (chain) return chain;
    }
  }
  return null;
}

/**
 * Применить перенос: с донора уходят последние вхождения вкуса
 * (визуально — верхние кусочки), получатель принимает в конец списка.
 * Опустевшая тарелка удаляется с поля (ТЗ 6.2). Каждый перелетевший
 * кусочек приносит MERGE_POINTS очков (итерация 3).
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
  state.points += MERGE_POINTS * moved;
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

/** Удалить собранный торт из данных, освободить ячейку и начислить очки:
 *  CAKE_POINTS + COMBO_BONUS за каждый следующий торт хода (ТЗ 5.7.3–5,
 *  итерация 3 — очки вместо подсчёта тортов). */
export function applyCompletion(state: GState, cell: CellIndex): void {
  state.board[cell] = null;
  state.completed += 1;
  state.combo += 1;
  state.points += CAKE_POINTS + COMBO_BONUS * (state.combo - 1);
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

/** Применить ход: размещение элемента очереди по определению mv.
 *  Начало хода — сброс счётчика комбо (итерация 3). */
export function applyTrayMove(state: GState, mv: Move): GPlate[] {
  state.combo = 0;
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
 * Все допустимые ходы из видимой выдачи (WINDOW = 5 тарелок).
 * Для двойной тарелки перебираются все свободные соседние пары и все
 * 4 ориентации: горизонтали — 0 (A слева) и 2 (A справа),
 * вертикали — 1 (A сверху) и 3 (A снизу) — ТЗ п. 3.4, 3.7.
 */
export function legalMoves(state: GState): Move[] {
  const out: Move[] = [];
  const frees = freeCells(state);
  const window = Math.min(WINDOW, state.tray.length);
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
 * Полное разрешение хода с журналом событий (Этап B, аудит §6.1).
 *
 * Схема фаз ТЗ 3.3: размещение уже выполнено (applyTrayMove) — сюда
 * передаются его ячейки lastPlaced. Дальше: проверка сборки → поиск
 * совпадений → перенос → торт → очистка → повторная оценка — до
 * стабилизации поля или срабатывания защитного лимита. Состояние
 * применяется полностью и независимо от анимаций (ТЗ 3.7); журнал —
 * контракт для визуального слоя, подсказки и симулятора.
 *
 * Завершимость: каждый перенос обнуляет вкус у донора, поэтому число
 * тарелок с данным вкусом монотонно падает (аудит §2.4). Доказанный
 * максимум — 54 шага; maxResolutionSteps — страховка (аудит §6.2):
 * при срабатывании обработка завершается безопасно — без удаления
 * тарелок и кусочков, состояние консистентно, в журнал пишется
 * событие aborted со снимком поля для диагностики.
 */
export function resolveTurnLogged(
  state: GState,
  lastPlaced: readonly CellIndex[],
  cfg?: CascadeConfig,
): TurnEvent[] {
  const config = cascadeOf(state, cfg);
  const log: TurnEvent[] = [{ kind: 'place', cells: [...lastPlaced] }];
  let steps = 0;
  let transfers = 0;
  let cakes = 0;

  /** Проверка сборки (фаза bake): событие cake с комбо и очками */
  const bakeIfCompleted = (): void => {
    log.push({ kind: 'phase', phase: 'bake' });
    const done = findCompletion(state);
    if (done) {
      applyCompletion(state, done.cell);
      cakes++;
      steps++;
      log.push({
        kind: 'cake',
        cell: done.cell,
        flavor: done.flavor,
        combo: state.combo,
        points: CAKE_POINTS + COMBO_BONUS * (state.combo - 1),
      });
    }
  };

  // торт мог собраться самим размещением (шесть одинаковых на тарелке)
  bakeIfCompleted();

  for (;;) {
    if (steps >= config.maxResolutionSteps) {
      log.push({
        kind: 'aborted',
        steps,
        limit: config.maxResolutionSteps,
        snapshot: JSON.stringify({
          board: state.board.map((p) => (p ? p.slices.map((s) => s.flavor) : null)),
          points: state.points,
          combo: state.combo,
        }),
      });
      break;
    }
    if (transfers >= config.maxTransfersPerTurn) break;
    if (cakes >= config.maxCakesPerTurn) break;

    log.push({ kind: 'phase', phase: 'detect' });
    const t = planNextTransfer(state, lastPlaced, config);
    if (!t) break;

    log.push({ kind: 'phase', phase: 'move' });
    log.push({ kind: 'transfer', transfer: t });
    applyTransfer(state, t);
    transfers++;
    steps++;

    // очистка (фаза cleanup): опустевший донор покидает поле сразу —
    // ячейка доступна следующим фазам того же хода
    if (!state.board[t.from]) {
      log.push({ kind: 'phase', phase: 'cleanup' });
      log.push({ kind: 'plateGone', cell: t.from });
    }

    bakeIfCompleted();
    log.push({ kind: 'phase', phase: 'recheck' });
  }

  log.push({ kind: 'phase', phase: 'done' });
  return log;
}

/**
 * Полное разрешение хода (ТЗ 5.5): делегирует resolveTurnLogged — одна
 * реализация, эквивалентность по построению (аудит §6.1). Возвращает
 * счётчики для эвристики подсказки.
 */
export function resolveTurn(state: GState, lastPlaced: readonly CellIndex[]): { transfers: number; cakes: number } {
  const log = resolveTurnLogged(state, lastPlaced);
  let transfers = 0;
  let cakes = 0;
  for (const ev of log) {
    if (ev.kind === 'transfer') transfers++;
    else if (ev.kind === 'cake') cakes++;
  }
  return { transfers, cakes };
}

/**
 * Итог хода: победа по очкам (итерация 3), поражение (с причиной) или
 * играем дальше (ТЗ 6.3, итерация 2 п. 3.7). Для конечных уровней без
 * цели (target = 0, тесты) сохранена победа по очистке поля.
 * Поражение full наступает и тогда, когда в видимой выдаче только
 * двойные тарелки, а свободные ячейки не образуют ни одной пары.
 */
export function evalEnd(state: GState): { phase: 'playing' | 'won' } | { phase: 'lost'; reason: EndReason } {
  if (state.target > 0) {
    if (state.points >= state.target) return { phase: 'won' };
  } else {
    const anyPlate = state.board.some((p) => p !== null);
    if (!anyPlate && state.tray.length === 0) return { phase: 'won' };
  }
  if (state.tray.length === 0) return { phase: 'lost', reason: 'leftover' };
  const frees = freeCells(state);
  if (frees.length === 0) return { phase: 'lost', reason: 'full' };
  const window = Math.min(WINDOW, state.tray.length);
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
    points: 0,
    target: level.target ?? 0,
    combo: 0,
    cascade: level.cascade ? { ...DEFAULT_CASCADE_CONFIG, ...level.cascade } : undefined,
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

/** Глубокая копия состояния (для подсказки и тестов стабильности) */
export function cloneState(s: GState): GState {
  return {
    rows: s.rows,
    cols: s.cols,
    board: s.board.map((p) => (p ? { id: p.id, cell: p.cell, slices: p.slices.map((x) => ({ ...x })) } : null)),
    tray: s.tray.map(cloneTrayItem),
    completed: s.completed,
    points: s.points,
    target: s.target,
    combo: s.combo,
    cascade: s.cascade ? { ...s.cascade } : undefined,
    nextPlateId: s.nextPlateId,
    nextSliceId: s.nextSliceId,
  };
}

/* ------------------------------------------------------------------ */
/* Подсказка: жадный ход (итерация 3)                                  */
/* ------------------------------------------------------------------ */

/** Сколько соседств с совпадающими вкусами на поле (потенциал слияний) */
export function sharedAdjacency(st: GState): number {
  let total = 0;
  for (let cell = 0; cell < st.board.length; cell++) {
    const p = st.board[cell];
    if (!p) continue;
    const right = cell % st.cols < st.cols - 1 ? cell + 1 : -1;
    const down = cell + st.cols < st.rows * st.cols ? cell + st.cols : -1;
    for (const nb of [right, down]) {
      const q = nb >= 0 ? st.board[nb] : null;
      if (!q) continue;
      const has = new Set(p.slices.map((s) => s.flavor));
      for (const f of q.slices) if (has.has(f.flavor)) total++;
    }
  }
  return total;
}

/**
 * Лучший ход на один шаг вперёд (итерация 3): для каждого допустимого
 * размещения моделируется полное разрешение хода. Сначала сравниваются
 * набранные очки, затем «здоровье» поля: прогресс тарелок к торту
 * (максимальное число одинаковых кусочков), соседства с совпадающими
 * вкусами и свободные ячейки. Очередь бесконечна, поэтому полный поиск
 * решения невозможен — жадная оценка и есть подсказка.
 */
export function bestMove(state: GState): Move | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  let best: Move | null = null;
  let bestScore = -Infinity;
  for (const mv of moves) {
    const next = cloneState(state);
    applyTrayMove(next, mv);
    const rep = resolveTurn(next, mv.cells);
    const gained = next.points - state.points;

    // потенциал поля: насколько тарелки близки к тортам
    let potential = 0;
    for (const p of next.board) {
      if (!p) continue;
      const counts = new Map<Flavor, number>();
      for (const s of p.slices) counts.set(s.flavor, (counts.get(s.flavor) ?? 0) + 1);
      let maxSame = 0;
      for (const c of counts.values()) if (c > maxSame) maxSame = c;
      potential += maxSame * maxSame * 3;
      // «мёртвые» тарелки: полные и разномастные — балласт на столе
      if (p.slices.length >= CAP - 1 && maxSame < 3) potential -= 24;
    }
    potential += sharedAdjacency(next) * 5 + freeCells(next).length * 11;

    const score = gained * 1000 + rep.transfers * 10 + potential;
    if (score > bestScore) {
      bestScore = score;
      best = mv;
    }
  }
  return best;
}

