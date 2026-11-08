/**
 * Cake Sort — «Кондитерская»
 * Слой 2: детерминированный генератор уровней (ТЗ итерации 2, п. 2).
 *
 * Уровни 4+ собираются «обратной сборкой»: берётся нужное число полных
 * тортов, каждый разрезается на порции по 1–5 кусочков (в сумме 6), порции
 * раздаются по тарелкам — часть тарелок остаётся на поле, часть уходит
 * в очередь, из части формируются двойные тарелки. Так число кусочков
 * каждого вкуса кратно шести, а уровень с высокой вероятностью решаем.
 *
 * Генерация полностью детерминирована: seed = f(номер уровня, попытка),
 * никаких Math.random. Каждый уровень обязан проходить солвер и порог
 * «случайной игры»; не прошедший проверку сид отбрасывается (ТЗ п. 2.1).
 */

import { FIXED_LEVELS } from './fixed';
import { applyTrayMove, createInitialState, evalEnd, legalMoves, resolveTurn } from './rules';
import { solve } from './solver';
import { CAP, trayFlavors, type Flavor, type LevelData, type TrayItem } from './types';

/* ------------------------------------------------------------------ */
/* ГСЧ и утилиты                                                       */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ------------------------------------------------------------------ */
/* Кривая сложности (ТЗ п. 2.3, стартовая — уточняется тестами)         */
/* ------------------------------------------------------------------ */

interface CurveParams {
  rows: number;
  cols: number;
  /** сколько разных вкусов выбрать */
  flavors: number;
  /** сколько полных тортов */
  cakes: number;
  /** элементов в очереди (обычные + двойные) */
  queue: number;
  /** двойных тарелок */
  doubles: number;
  /** начальных тарелок на поле */
  initial: number;
}

function curve(n: number, rng: () => number): CurveParams {
  const ri = (k: number): number => Math.floor(rng() * k);
  if (n <= 6) {
    return { rows: 3, cols: 3, flavors: 3 + ri(2), cakes: 3 + ri(2), queue: 5 + ri(2), doubles: ri(2), initial: 2 };
  }
  if (n <= 10) {
    return { rows: 3, cols: 3, flavors: 4 + ri(2), cakes: 4 + ri(2), queue: 6 + ri(3), doubles: 1, initial: 2 + ri(2) };
  }
  if (n <= 20) {
    return { rows: 3, cols: 4, flavors: 5 + ri(2), cakes: 5 + ri(2), queue: 7 + ri(3), doubles: 1 + ri(2), initial: 2 + ri(2) };
  }
  return { rows: 3, cols: 4, flavors: 6 + ri(2), cakes: 6 + ri(2), queue: 8 + ri(3), doubles: 2, initial: 3 };
}

/* ------------------------------------------------------------------ */
/* Вкусы                                                               */
/* ------------------------------------------------------------------ */

function pickFlavors(rng: () => number, count: number): Flavor[] {
  const pool: Flavor[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const out: Flavor[] = [];
  for (let i = 0; i < count; i++) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

function flavorSetOf(level: LevelData): Set<Flavor> {
  const s = new Set<Flavor>();
  for (const p of level.initial) for (const f of p.slices) s.add(f);
  for (const it of level.tray) for (const f of trayFlavors(it)) s.add(f);
  return s;
}

function sameSet(a: Set<Flavor>, b: Set<Flavor>): boolean {
  if (a.size !== b.size) return false;
  for (const f of a) if (!b.has(f)) return false;
  return true;
}

const flavorCache = new Map<number, Set<Flavor>>();

/**
 * Набор вкусов уровня: детерминирован только номером уровня и не зависит
 * от того, какая попытка сборки оказалась успешной. Благодаря этому
 * generateLevel(n) не тянет за собой полную генерацию всех предыдущих
 * уровней — рекурсия идёт только по лёгким наборам вкусов.
 */
export function flavorSetFor(n: number): Set<Flavor> {
  const cached = flavorCache.get(n);
  if (cached) return cached;
  const rng = mulberry32((Math.imul(n, 2246822519) ^ 0x27d4eb2f) >>> 0);
  const params = curve(n, rng);
  const distinct = Math.max(3, Math.min(params.flavors, params.cakes, 10));
  const set = new Set<Flavor>(pickFlavors(rng, distinct));
  const prev = n - 1 <= FIXED_LEVELS.length ? flavorSetOf(FIXED_LEVELS[n - 2]) : flavorSetFor(n - 1);
  if (sameSet(set, prev)) {
    const unused = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((f) => !set.has(f));
    if (unused.length > 0) {
      const arr = [...set];
      const idx = Math.floor(rng() * arr.length);
      arr[idx] = unused[Math.floor(rng() * unused.length)];
      set.clear();
      for (const f of arr) set.add(f);
    }
  }
  flavorCache.set(n, set);
  return set;
}

/* ------------------------------------------------------------------ */
/* Обратная сборка                                                     */
/* ------------------------------------------------------------------ */

/** Разрезать торт из 6 кусочков на parts порций по 1..5 кусочков */
function cutCake(rng: () => number, parts: number): number[] {
  const sizes = new Array<number>(parts).fill(1);
  let rem = CAP - parts;
  while (rem > 0) {
    const i = Math.floor(rng() * parts);
    if (sizes[i] < 5) {
      sizes[i]++;
      rem--;
    }
  }
  return sizes;
}

/** Порция одного вкуса */
interface Portion {
  f: Flavor;
  k: number;
}

/**
 * Раздать порции по тарелкам: сначала по одной порции на тарелку,
 * затем остаток — в смешанные тарелки (2–3 вкуса). Возвращает null,
 * если порции не помещаются (попытка перегенерации).
 */
function dealPlates(rng: () => number, portions: Portion[], plateCount: number, mixProb: number): Flavor[][] | null {
  const plates: Flavor[][] = Array.from({ length: plateCount }, () => []);
  const flavorsOf = (p: Flavor[]): Set<Flavor> => new Set(p);
  const room = (p: Flavor[]): number => CAP - p.length;
  const canTake = (p: Flavor[], f: Flavor): boolean => room(p) > 0 && (flavorsOf(p).size < 3 || p.includes(f));

  for (let i = 0; i < plateCount; i++) {
    const por = portions[i];
    for (let k = 0; k < por.k; k++) plates[i].push(por.f);
  }

  for (let i = plateCount; i < portions.length; i++) {
    const por = portions[i];
    const mixedOk: number[] = [];
    const anyOk: number[] = [];
    for (let j = 0; j < plateCount; j++) {
      if (room(plates[j]) < por.k) continue;
      if (plates[j].length > 0 && canTake(plates[j], por.f)) mixedOk.push(j);
      if (room(plates[j]) >= por.k) anyOk.push(j);
    }
    let target: number;
    if (mixedOk.length > 0 && rng() < mixProb) {
      target = mixedOk[Math.floor(rng() * mixedOk.length)];
    } else if (anyOk.length > 0) {
      target = anyOk[Math.floor(rng() * anyOk.length)];
    } else {
      return null;
    }
    for (let k = 0; k < por.k; k++) plates[target].push(por.f);
  }
  return plates;
}

/** Подпись элемента очереди: отсортированные кусочки (для сравнения «одинаковых») */
function itemSignature(it: TrayItem): string {
  return [...trayFlavors(it)].sort((x, y) => x - y).join('.');
}

/** Смешанная тарелка — два и более вкусов */
function isMixed(it: TrayItem): boolean {
  return new Set(trayFlavors(it)).size > 1;
}

/**
 * Порядок очереди (ТЗ п. 2.2.6): не ставить подряд одинаковые тарелки
 * и не копить смешанные тарелки в начале очереди.
 */
function orderQueue(rng: () => number, items: TrayItem[]): TrayItem[] {
  const pool = [...items];
  const out: TrayItem[] = [];
  let prevSig: string | null = null;
  while (pool.length > 0) {
    let cands = prevSig === null ? pool : pool.filter((it) => itemSignature(it) !== prevSig);
    if (cands.length === 0) cands = pool;
    if (out.length < 3) {
      const pure = cands.filter((it) => !isMixed(it));
      if (pure.length > 0 && rng() < 0.75) cands = pure;
    }
    const pick = cands[Math.floor(rng() * cands.length)];
    out.push(pick);
    pool.splice(pool.indexOf(pick), 1);
    prevSig = itemSignature(pick);
  }
  return out;
}

/** Одна попытка сборки уровня; null — попробовать другой сид */
function tryBuild(params: CurveParams, rng: () => number, set: Set<Flavor>): LevelData | null {
  const { rows, cols } = params;

  // Полные торты; выбранные вкусы распределяются равномерно
  const setArr = [...set];
  const cakeFlavors: Flavor[] = [];
  for (let i = 0; i < params.cakes; i++) cakeFlavors.push(setArr[i % setArr.length]);
  shuffle(rng, cakeFlavors);

  // Порции: каждая шестёрка режется на части 1..5 (ТЗ п. 2.2.3)
  const plateCount = params.initial + params.queue + params.doubles;
  const targetPortions = plateCount + 2 + Math.floor(rng() * 3);
  const perCake = Math.min(6, Math.max(2, Math.ceil(targetPortions / params.cakes)));
  const portions: Portion[] = [];
  for (const f of cakeFlavors) {
    for (const k of cutCake(rng, perCake)) portions.push({ f, k });
  }
  if (portions.length < plateCount) return null;
  shuffle(rng, portions);

  const plates = dealPlates(rng, portions, plateCount, 0.55);
  if (!plates) return null;
  shuffle(rng, plates);

  // Начальные тарелки на поле (ТЗ п. 2.2.4)
  const initialIdx = new Set<number>();
  while (initialIdx.size < params.initial) initialIdx.add(Math.floor(rng() * plateCount));
  const initialCells = shuffle(rng, [...Array(rows * cols).keys()]).slice(0, params.initial);
  const initial = [...initialIdx].map((idx, i) => ({
    row: Math.floor(initialCells[i] / cols),
    col: initialCells[i] % cols,
    slices: plates[idx],
  }));

  // Очередь: двойные тарелки + обычные (ТЗ п. 2.2.5)
  const rest: Flavor[][] = plates.filter((_, idx) => !initialIdx.has(idx));
  const tray: TrayItem[] = [];
  for (let d = 0; d < params.doubles; d++) {
    if (rest.length < 2) break;
    const a = rest.shift();
    const b = rest.shift();
    if (!a || !b) break;
    tray.push({ kind: 'double', a, b });
  }
  for (const slices of rest) tray.push({ kind: 'single', slices });

  return { rows, cols, initial, tray: orderQueue(rng, tray) };
}

/* ------------------------------------------------------------------ */
/* Случайная игра (порог качества, ТЗ п. 2.4)                          */
/* ------------------------------------------------------------------ */

/**
 * Число побед при полностью случайной игре: на каждом ходу равновероятно
 * выбирается любой допустимый ход. Детерминирована сидом.
 */
export function randomPlayWins(level: LevelData, games: number, seed: number): number {
  const rng = mulberry32((seed >>> 0) || 1);
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const st = createInitialState(level);
    for (let guard = 0; guard < 400; guard++) {
      const end = evalEnd(st);
      if (end.phase === 'won') {
        wins++;
        break;
      }
      if (end.phase === 'lost') break;
      const moves = legalMoves(st);
      if (moves.length === 0) break;
      const mv = moves[Math.floor(rng() * moves.length)];
      applyTrayMove(st, mv);
      resolveTurn(st, mv.cells);
    }
  }
  return wins;
}

/* ------------------------------------------------------------------ */
/* Генерация уровня                                                    */
/* ------------------------------------------------------------------ */

const cache = new Map<number, LevelData>();
const GEN_SOLVE_BUDGET = 800;
const GEN_RANDOM_GAMES = 400;
const MAX_ATTEMPTS = 50;

/**
 * Уровень по 1-номеру (n ≥ 4). Один и тот же номер всегда даёт один и тот
 * же LevelData (ТЗ п. 2.1). Порог случайной игры берётся с запасом ниже
 * тестовых порогов ТЗ (3%/1%): 6 побед из 400 на лёгких уровнях,
 * 2 из 400 на сложных. Крайний случай — первый решаемый уровень.
 */
export function generateLevel(n: number): LevelData {
  const cached = cache.get(n);
  if (cached) return cached;
  if (n < 4) throw new Error(`generateLevel: генерация с уровня 4, попросили ${n}`);

  const set = flavorSetFor(n);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seedBase = (Math.imul(n, 2654435761) + Math.imul(attempt, 40503) + 0x9e3779b9) >>> 0;
    const rng = mulberry32(seedBase);
    const params = curve(n, rng);
    const level = tryBuild(params, rng, set);
    if (!level) continue;

    // дешёвый шлюз — порог случайной игры (ТЗ п. 2.4)
    const wins = randomPlayWins(level, GEN_RANDOM_GAMES, (seedBase ^ 0x5bf03635) >>> 0);
    const allowed = n >= 11 ? 2 : 6;
    if (wins > allowed) continue;

    // решаемость солвером (ТЗ п. 2.1)
    const sol = solve(createInitialState(level), GEN_SOLVE_BUDGET);
    if (!sol) continue;

    cache.set(n, level);
    return level;
  }

  // запасной выход: первый решаемый уровень без порога случайной игры —
  // решаемость важнее качества рандома (ТЗ п. 2.1: 100% уровней решаются)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seedBase = (Math.imul(n, 2654435761) + Math.imul(attempt, 40503) + 0x9e3779b9) >>> 0;
    const rng = mulberry32(seedBase);
    const params = curve(n, rng);
    const level = tryBuild(params, rng, set);
    if (!level) continue;
    if (solve(createInitialState(level), GEN_SOLVE_BUDGET)) {
      cache.set(n, level);
      return level;
    }
  }

  throw new Error(`generateLevel: не удалось собрать уровень ${n}`);
}
