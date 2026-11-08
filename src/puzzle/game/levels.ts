/**
 * Cake Sort — «Кондитерская»
 * Слой 2: фиксированные уровни (ТЗ п. 7) и солвер.
 *
 * Уровни заданы данными, а не случайной генерацией: при каждом запуске
 * поле и очередь одинаковы. Солвер (DFS с мемоизацией) проверяет
 * решаемость уровня и используется для подсказки и автотестов.
 */

import type { CellIndex, Flavor, GPlate, GState, LevelData } from './types';
import { CAP } from './types';
import { cloneState, evalEnd, freeCells, placePlate, resolveTurn } from './rules';

/* ------------------------------------------------------------------ */
/* Фиксированные уровни                                                */
/* ------------------------------------------------------------------ */

/**
 * Вкусы — индексы CAKE_TYPES: 0 Шоколадный, 1 Красный бархат, 2 Матча,
 * 3 Лимонный, 4 Черничный, 5 Фисташковый, 6 Малиновый, 7 Карамельный,
 * 8 Ванильный, 9 Тирамису. В каждом уровне сумма кусочков каждого вкуса
 * кратна шести — иначе собрать все торты невозможно.
 */
export const FIXED_LEVELS: readonly LevelData[] = [
  {
    // 1. Учебный: два вкуса, три тарелки в очереди
    rows: 2,
    cols: 3,
    initial: [{ row: 0, col: 0, slices: [0, 0] }],
    tray: [
      [0, 0, 0, 0],
      [3, 3, 3, 3],
      [3, 3],
    ],
  },
  {
    // 2. Три вкуса, тарелка из трёх кусочков уже на поле
    rows: 2,
    cols: 3,
    initial: [
      { row: 0, col: 0, slices: [1, 1] },
      { row: 1, col: 2, slices: [8, 8, 8] },
    ],
    tray: [
      [1, 1, 1, 1],
      [2, 2, 2],
      [8, 8, 8],
      [2, 2, 2],
    ],
  },
  {
    // 3. Донор опустевает — тарелка освобождает ячейку
    rows: 2,
    cols: 3,
    initial: [
      { row: 0, col: 1, slices: [4, 4] },
      { row: 1, col: 0, slices: [6] },
    ],
    tray: [
      [4, 4, 4, 4],
      [6, 6, 6, 6, 6],
      [7, 7, 7],
      [7, 7, 7],
    ],
  },
  {
    // 4. Поле 3×3, четыре вкуса, шесть тарелок в очереди
    rows: 3,
    cols: 3,
    initial: [
      { row: 1, col: 1, slices: [0, 0] },
      { row: 0, col: 2, slices: [5, 5] },
      { row: 2, col: 0, slices: [2] },
    ],
    tray: [
      [0, 0, 0, 0],
      [3, 3, 3, 3],
      [3, 3],
      [5, 5, 5, 5],
      [2, 2, 2],
      [2, 2],
    ],
  },
  {
    // 5. Сбор по углам: начальные тарелки в трёх углах
    rows: 3,
    cols: 3,
    initial: [
      { row: 0, col: 0, slices: [9, 9, 9] },
      { row: 1, col: 1, slices: [1, 1] },
      { row: 2, col: 2, slices: [4] },
    ],
    tray: [
      [9, 9, 9],
      [4, 4, 4, 4, 4],
      [1, 1, 1, 1],
      [7, 7, 7],
      [7, 7, 7],
    ],
  },
  {
    // 6. Пять вкусов, смешанная тарелка в очереди
    rows: 3,
    cols: 3,
    initial: [
      { row: 0, col: 0, slices: [0, 0] },
      { row: 1, col: 1, slices: [3, 3] },
      { row: 2, col: 2, slices: [8, 8] },
    ],
    tray: [
      [0, 0, 0, 0],
      [3, 3, 3, 3],
      [8, 8, 8, 8],
      [6, 6, 6],
      [6, 6, 6, 2],
      [2, 2, 2, 2, 2],
    ],
  },
  {
    // 7. Широкое поле 3×4, пять вкусов
    rows: 3,
    cols: 4,
    initial: [
      { row: 0, col: 0, slices: [5, 5] },
      { row: 1, col: 3, slices: [9, 9] },
      { row: 2, col: 1, slices: [4, 4] },
    ],
    tray: [
      [5, 5, 5, 5],
      [9, 9, 9, 9],
      [4, 4, 4, 4],
      [1, 1, 1],
      [1, 1, 1],
      [7, 7, 7],
      [7, 7, 7],
    ],
  },
  {
    // 8. Финал: шесть вкусов, девять тарелок в очереди
    rows: 3,
    cols: 4,
    initial: [
      { row: 0, col: 1, slices: [0, 0] },
      { row: 1, col: 2, slices: [2, 2] },
      { row: 2, col: 3, slices: [6, 6] },
    ],
    tray: [
      [0, 0, 0, 0],
      [2, 2, 2, 2],
      [6, 6, 6, 6],
      [4, 4, 4],
      [4, 4, 4],
      [8, 8, 8],
      [8, 8, 8],
      [1, 1, 1],
      [1, 1, 1],
    ],
  },
] as const;

/** Уровень по индексу; после последнего — циклический повтор */
export function getLevel(index: number): LevelData {
  const n = FIXED_LEVELS.length;
  const i = ((index % n) + n) % n;
  return FIXED_LEVELS[i];
}

export function levelCount(): number {
  return FIXED_LEVELS.length;
}

/** Всего тортов в уровне: общее число кусочков / 6 */
export function totalCakes(level: LevelData): number {
  let total = 0;
  for (const p of level.initial) total += p.slices.length;
  for (const t of level.tray) total += t.length;
  return total / CAP;
}

/** Начальное состояние партии по данным уровня */
export function createInitialState(level: LevelData): GState {
  const board: Array<GPlate | null> = new Array(level.rows * level.cols).fill(null);
  const state: GState = {
    rows: level.rows,
    cols: level.cols,
    board,
    tray: level.tray.map((t) => [...t]),
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

/* ------------------------------------------------------------------ */
/* Солвер: DFS по графу состояний (окно очереди 3 × свободные ячейки)  */
/* ------------------------------------------------------------------ */

export interface SolveMove {
  /** индекс видимой тарелки очереди (0..2) */
  trayIdx: number;
  cell: CellIndex;
}

function stateKey(s: GState): string {
  const parts: string[] = [];
  for (const p of s.board) {
    if (!p) continue;
    const counts = new Map<Flavor, number>();
    for (const sl of p.slices) counts.set(sl.flavor, (counts.get(sl.flavor) ?? 0) + 1);
    const c = [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([f, n]) => `${f}x${n}`)
      .join(',');
    parts.push(`${p.cell}(${c})`);
  }
  parts.sort();
  return `${parts.join('|')}#${s.tray.map((t) => t.join('.')).join(';')}`;
}

/**
 * Найти последовательность размещений, приводящую к победе.
 * Порядок перебора — по эвристике: сначала ходы, которые сразу собирают
 * торты и запускают автопереносы (уровни проектируются решаемыми такой
 * «жадной» стратегией, поэтому решение находится быстро).
 * Возвращает null, если решение не найдено в пределах бюджета узлов.
 */
export function solve(start: GState, budget = 200000): SolveMove[] | null {
  const seen = new Set<string>();
  let nodes = 0;
  const path: SolveMove[] = [];

  const dfs = (s: GState): boolean => {
    const end = evalEnd(s);
    if (end.phase === 'won') return true;
    if (end.phase === 'lost') return false;
    if (nodes >= budget) return false;
    nodes++;
    const key = stateKey(s);
    if (seen.has(key)) return false;
    seen.add(key);

    const frees = freeCells(s);
    const window = Math.min(3, s.tray.length);
    const candidates: Array<{ mv: SolveMove; score: number }> = [];
    for (let ti = 0; ti < window; ti++) {
      for (const c of frees) {
        const next = cloneState(s);
        placePlate(next, ti, c);
        const rep = resolveTurn(next, c);
        candidates.push({ mv: { trayIdx: ti, cell: c }, score: rep.cakes * 1000 + rep.transfers * 10 });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const cand of candidates) {
      const next = cloneState(s);
      placePlate(next, cand.mv.trayIdx, cand.mv.cell);
      resolveTurn(next, cand.mv.cell);
      path.push(cand.mv);
      if (dfs(next)) return true;
      path.pop();
      if (nodes >= budget) return false;
    }
    return false;
  };

  return dfs(cloneState(start)) ? [...path] : null;
}
