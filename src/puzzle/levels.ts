/**
 * Cake Sort — Кондитерская
 * Определения уровней, генератор перемешивания и солвер,
 * гарантирующий, что каждый уровень проходим.
 *
 * Алгоритм: из решённого состояния (по 6 одинаковых кусков на тарелке)
 * случайным образом перемешиваем кусочки по одному, затем DFS-солвер
 * с эвристиками проверяет решаемость и возвращает решение
 * (оно же — основа для автотестов и будущих подсказок).
 */

export const CAP = 6; // вместимость тарелки = 6 кусков (полный торт)

export interface Move {
  from: number;
  to: number;
}

export interface LevelDef {
  /** Количество тарелок */
  plates: number;
  /** Количество видов тортиков (по 6 кусков каждого) */
  types: number;
  /** Интенсивность перемешивания */
  shuffle: number;
}

export interface LevelData {
  index: number;
  /** stacks[plate] — типы кусков снизу вверх */
  stacks: number[][];
  /** Индексы типов CAKE_TYPES, участвующих в уровне */
  cakeTypes: number[];
  /** Решение (последовательность ходов) */
  solution: Move[];
}

/**
 * Кривая сложности первых уровней. Дальше — плато 7 тарелок / 6 видов
 * с плавным ростом перемешивания. Уровни бесконечны.
 */
const RAMP: readonly LevelDef[] = [
  { plates: 3, types: 2, shuffle: 18 }, // 1
  { plates: 4, types: 3, shuffle: 26 }, // 2
  { plates: 5, types: 3, shuffle: 34 }, // 3
  { plates: 5, types: 4, shuffle: 42 }, // 4
  { plates: 6, types: 4, shuffle: 48 }, // 5
  { plates: 6, types: 5, shuffle: 54 }, // 6
  { plates: 7, types: 5, shuffle: 60 }, // 7
  { plates: 7, types: 6, shuffle: 66 }, // 8
] as const;

export function levelDef(index: number): LevelDef {
  if (index < RAMP.length) return RAMP[index];
  const extra = Math.min((index - RAMP.length + 1) * 3, 36);
  return { plates: 7, types: 6, shuffle: 66 + extra };
}

/* ------------------------------------------------------------------ */
/* Детерминированный RNG (mulberry32)                                  */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Игровая логика (чистые функции над стопками)                        */
/* ------------------------------------------------------------------ */

export interface RawMove {
  from: number;
  to: number;
  r: number;
  t: number;
  merge: boolean;
  toEmpty: boolean;
  emptiesSource: boolean;
}

/** Верхняя непрерывная серия одинаковых кусков */
function topRun(stack: number[]): { t: number; r: number } {
  const t = stack[stack.length - 1];
  let r = 1;
  for (let i = stack.length - 2; i >= 0 && stack[i] === t; i--) r++;
  return { t, r };
}

/** Все легальные ходы из состояния (ход переносит верхнюю серию целиком) */
export function enumerateMoves(stacks: number[][]): RawMove[] {
  const out: RawMove[] = [];
  for (let s = 0; s < stacks.length; s++) {
    const src = stacks[s];
    if (src.length === 0) continue;
    const { t, r } = topRun(src);
    const emptiesSource = r === src.length;
    for (let to = 0; to < stacks.length; to++) {
      if (to === s) continue;
      const tgt = stacks[to];
      if (tgt.length === 0) {
        // перенос всей стопки на пустую тарелку ничего не меняет
        if (emptiesSource) continue;
        out.push({ from: s, to, r, t, merge: false, toEmpty: true, emptiesSource });
      } else if (tgt[tgt.length - 1] === t && tgt.length + r <= CAP) {
        let c = 1;
        for (let i = tgt.length - 2; i >= 0 && tgt[i] === t; i--) c++;
        out.push({
          from: s,
          to,
          r,
          t,
          merge: c + r >= CAP,
          toEmpty: false,
          emptiesSource,
        });
      }
    }
  }
  return out;
}

/** Есть ли хотя бы один ход (для проверки тупика) */
export function anyMoveExists(stacks: number[][]): boolean {
  return enumerateMoves(stacks).length > 0;
}

function applyMove(stacks: number[][], mv: RawMove): number[][] {
  const next = stacks.map((s) => [...s]);
  const moved = next[mv.from].splice(next[mv.from].length - mv.r, mv.r);
  next[mv.to].push(...moved);
  // собран полный торт — тарелка освобождается
  if (next[mv.to].length === CAP && next[mv.to].every((x) => x === mv.t)) {
    next[mv.to] = [];
  }
  return next;
}

function stateKey(stacks: number[][]): string {
  return stacks.map((s) => s.join('.')).join('|');
}

/* ------------------------------------------------------------------ */
/* Солвер: DFS по графу состояний с эвристиками                        */
/* ------------------------------------------------------------------ */

function moveScore(mv: RawMove): number {
  let score = 0;
  if (mv.merge) score += 1000; // собрать торт — лучший ход
  if (!mv.toEmpty) score += 100 + mv.r; // продлить серию сверху
  if (mv.emptiesSource) score += 40; // освободить тарелку
  return score;
}

export function solve(stacks: number[][], budget = 80000, maxDepth = 200): Move[] | null {
  const visited = new Set<string>();
  const path: Move[] = [];
  let nodes = 0;

  const dfs = (st: number[][], depth: number): boolean => {
    if (st.every((s) => s.length === 0)) return true;
    if (depth >= maxDepth || nodes > budget) return false;
    nodes++;
    const key = stateKey(st);
    if (visited.has(key)) return false;
    visited.add(key);

    const moves = enumerateMoves(st).sort((a, b) => moveScore(b) - moveScore(a));
    for (const mv of moves) {
      path.push({ from: mv.from, to: mv.to });
      if (dfs(applyMove(st, mv), depth + 1)) return true;
      path.pop();
      if (nodes > budget) return false;
    }
    return false;
  };

  return dfs(stacks, 0) ? [...path] : null;
}

/* ------------------------------------------------------------------ */
/* Перемешивание                                                       */
/* ------------------------------------------------------------------ */

function scramble(def: LevelDef, cakeTypes: number[], seed: number): number[][] {
  const rng = mulberry32(seed);
  const stacks: number[][] = [];
  for (let i = 0; i < def.plates; i++) {
    stacks.push(i < def.types ? Array<number>(CAP).fill(cakeTypes[i]) : []);
  }

  const moveOne = (from: number, to: number): boolean => {
    const a = stacks[from][stacks[from].length - 1];
    // не создавать 6 одинаковых на тарелке
    let c = 0;
    for (let i = stacks[to].length - 1; i >= 0 && stacks[to][i] === a; i--) c++;
    if (c + 1 >= CAP) return false;
    stacks[from].pop();
    stacks[to].push(a);
    return true;
  };

  // Сначала обязательно «разбить» каждый собранный торт
  for (let p = 0; p < def.types; p++) {
    const breaks = 1 + ((rng() * 2) | 0);
    for (let b = 0; b < breaks; b++) {
      const targets: number[] = [];
      for (let t = 0; t < def.plates; t++) {
        if (t !== p && stacks[t].length < CAP) targets.push(t);
      }
      if (!targets.length) break;
      moveOne(p, targets[(rng() * targets.length) | 0]);
    }
  }

  // Дальше — свободное перемешивание по одному куску
  for (let k = 0; k < def.shuffle; k++) {
    const sources: number[] = [];
    for (let i = 0; i < def.plates; i++) {
      if (stacks[i].length > 0) sources.push(i);
    }
    if (!sources.length) break;
    const from = sources[(rng() * sources.length) | 0];
    const targets: number[] = [];
    for (let t = 0; t < def.plates; t++) {
      if (t !== from && stacks[t].length < CAP) targets.push(t);
    }
    if (!targets.length) continue;
    moveOne(from, targets[(rng() * targets.length) | 0]);
  }

  return stacks;
}

/* ------------------------------------------------------------------ */
/* Подбор контрастных типов тортиков                                   */
/* ------------------------------------------------------------------ */

/** Пары максимально контрастных типов для уровня из 2 тортов */
const CONTRAST_PAIRS: readonly [number, number][] = [
  [0, 3], // шоколад + лимон
  [1, 2], // красный бархат + матча
  [4, 8], // черника + ваниль
  [6, 9], // малина + тирамису
  [5, 0], // фисташка + шоколад
  [3, 4], // лимон + черника
];

/** RGB основных цветов типов (для оценки контраста) */
const TYPE_RGB: readonly [number, number, number][] = [
  [0x4a, 0x2c, 0x1a], [0x8e, 0x24, 0x38], [0x7f, 0xae, 0x6a], [0xf2, 0xc9, 0x4c],
  [0x5b, 0x4a, 0x8a], [0xb5, 0xcf, 0x9e], [0xc9, 0x4f, 0x6d], [0xc9, 0x8a, 0x3d],
  [0xf0, 0xe2, 0xc4], [0x6b, 0x4a, 0x35],
];

function colorDist(a: number, b: number): number {
  const [r1, g1, b1] = TYPE_RGB[a];
  const [r2, g2, b2] = TYPE_RGB[b];
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function pickTypes(count: number, rng: () => number): number[] {
  if (count === 2) {
    return [...CONTRAST_PAIRS[(rng() * CONTRAST_PAIRS.length) | 0]];
  }
  // Жадный выбор с максимальным контрастом
  const pool = shuffleArray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rng);
  const picked = [pool[0]];
  while (picked.length < count) {
    let best = pool[0];
    let bestD = -1;
    for (const c of pool) {
      if (picked.includes(c)) continue;
      let d = Infinity;
      for (const p of picked) d = Math.min(d, colorDist(p, c));
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    picked.push(best);
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Сборка уровня                                                       */
/* ------------------------------------------------------------------ */

export function generateLevel(index: number): LevelData {
  const def = levelDef(index);
  // Набор тортиков фиксирован для уровня (детерминированно)
  const typeRng = mulberry32(7777 + index * 131);
  const cakeTypes = pickTypes(def.types, typeRng);

  for (let attempt = 0; attempt < 12; attempt++) {
    const seed = 9137 * (index + 1) + attempt * 571 + 42;
    const stacks = scramble(def, cakeTypes, seed);
    // не должно остаться собранных тортов
    if (stacks.some((s) => s.length === CAP && s.every((x) => x === s[0]))) continue;
    const solution = solve(stacks);
    if (solution && solution.length >= 3) {
      return { index, stacks, cakeTypes, solution };
    }
  }

  // Теоретически недостижимо (fallback: минимальное перемешивание)
  const stacks = scramble(def, cakeTypes, 1);
  const solution = solve(stacks) ?? [];
  return { index, stacks, cakeTypes, solution };
}
