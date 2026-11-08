/**
 * Cake Sort — «Кондитерская»: аудит цепной реакции (ТЗ Этап 2, Этап A).
 * Запуск: npx tsx scripts/audit-cascade.ts
 *
 * Симуляция без Three.js/GSAP на той же игровой логике (game/rules.ts).
 *
 * 1) Кросс-проверка: собственный перечислитель переносов обязан совпадать
 *    с planNextTransfer на реальных состояниях (иначе аудит неверен).
 * 2) Замер текущей каскадной системы: жадный и случайный игрок,
 *    уровни 1..30: торты за ход, переносы, цепочки, «посторонние»
 *    переносы, свободные ячейки, длительность партий.
 * 3) Экспериментальные варианты ограничения каскада на тех же уровнях
 *    (игровые правила НЕ меняются — эксперимент живёт в этом файле).
 *
 * Примечание Этапа B: уровни теперь несут cascade-конфиг (maxChainHops),
 * поэтому базовые линии V0/аудит передают в planNextTransfer явный
 * DEFAULT_CASCADE_CONFIG — воспроизводимость чисел Этапа A сохранена.
 * Текущие правила игры (с прогрессией maxChainHops) проверяет
 * scripts/tune-targets.ts.
 */

import {
  applyCompletion,
  applyTrayMove,
  applyTransfer,
  bestMove,
  cloneState,
  createInitialState,
  evalEnd,
  findCompletion,
  freeCells,
  legalMoves,
  neighborCells,
  planNextTransfer,
  resolveTurn,
  chooseRecipient,
  type Move,
} from '../src/puzzle/game/rules';
import { getLevel, topUpTray } from '../src/puzzle/game/levels';
import { CAP, DEFAULT_CASCADE_CONFIG, type CellIndex, type Flavor, type GPlate, type GState, type LevelData, type Transfer } from '../src/puzzle/game/types';

/* ==================================================================== */
/* 0. Утилиты (копии приватных хелперов rules.ts — для перечисления)     */
/* ==================================================================== */

/**
 * Состояние партии с V0-каскадом (эталон Этапа A). После Этапа B уровни
 * несят свой cascade-конфиг (maxChainHops по прогрессии), а подсказка
 * bestMove оценивает ходы правилами уровня — аудит же обязан измерять
 * ровно те правила, что были до Этапа B.
 */
function createInitialStateV0(lvl: LevelData): GState {
  const st = createInitialState(lvl);
  st.cascade = DEFAULT_CASCADE_CONFIG;
  return st;
}

function flavorCount(p: GPlate, f: Flavor): number {
  let n = 0;
  for (const s of p.slices) if (s.flavor === f) n++;
  return n;
}

function sharedFlavors(a: GPlate, b: GPlate): Flavor[] {
  const has = new Set<Flavor>();
  for (const s of a.slices) has.add(s.flavor);
  const out: Flavor[] = [];
  for (const s of b.slices) if (has.has(s.flavor) && !out.includes(s.flavor)) out.push(s.flavor);
  return out.sort((x, y) => x - y);
}

function distinctFlavors(p: GPlate): Flavor[] {
  const out: Flavor[] = [];
  for (const s of p.slices) if (!out.includes(s.flavor)) out.push(s.flavor);
  return out.sort((x, y) => x - y);
}

function freeSpace(p: GPlate): number {
  return CAP - p.slices.length;
}

/** Кандидат переноса для перечисления (перечисление, не выбор) */
interface TransferCandidate extends Transfer {
  chain: boolean;
}

/** Все ПРЯМЫЕ переносы в детерминированном порядке planNextTransfer
 *  (ячейки по строкам, соседи «вправо, вниз», вкусы по возрастанию). */
function enumerateDirect(state: GState, lastPlaced: readonly CellIndex[]): TransferCandidate[] {
  const { rows, cols, board } = state;
  const out: TransferCandidate[] = [];
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
        if (count > 0) out.push({ from: donorCell, to: recipient, flavor: f, count, path: [donorCell, recipient], chain: false });
      }
    }
  }
  return out;
}

/** Цепочечный перенос от start по вкусу flavor — копия planChainFrom
 *  (BFS, первый найденный кандидат; порядок очереди = порядок соседей).
 *  maxHops: максимальное число «прыжков» маршрута (1 = только прямые
 *  соседи, 2 = один транзит; Infinity — как в игре сейчас). */
function chainFrom(state: GState, start: CellIndex, flavor: Flavor, lastPlaced: readonly CellIndex[], maxHops = Infinity): TransferCandidate | null {
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
      const path: CellIndex[] = [];
      for (let c: CellIndex | undefined = cell; c !== undefined; c = parent.get(c)) {
        path.push(c);
        if (c === start) break;
      }
      path.reverse();
      const recipient = chooseRecipient(state, start, cell, flavor, lastPlaced);
      if (recipient === start) {
        const count = Math.min(freeSpace(startPlate), flavorCount(plate, flavor));
        if (count > 0) return { from: cell, to: start, flavor, count, path: [...path].reverse(), chain: d > 1 };
      } else {
        const count = Math.min(space, flavorCount(startPlate, flavor));
        if (count > 0) return { from: start, to: cell, flavor, count, path, chain: d > 1 };
      }
    }

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

/** Все ЦЕПОЧНЫЕ переносы в порядке planNextTransfer (ячейки, затем вкусы) */
function enumerateChains(state: GState, lastPlaced: readonly CellIndex[], maxHops = Infinity): TransferCandidate[] {
  const out: TransferCandidate[] = [];
  for (let cell = 0; cell < state.board.length; cell++) {
    const p = state.board[cell];
    if (!p) continue;
    for (const f of distinctFlavors(p)) {
      const chain = chainFrom(state, cell, f, lastPlaced, maxHops);
      if (chain) out.push(chain);
    }
  }
  return out;
}

/* ==================================================================== */
/* 1. Кросс-проверка перечислителя против planNextTransfer               */
/* ==================================================================== */

/** Своя копия цикла resolveTurn с записью каждого переноса.
 *  Поведение обязано совпадать с resolveTurn (проверяется кросс-проверкой). */
interface AuditStep {
  t: TransferCandidate;
  unrelated: boolean; // не касается ни одной затронутой тарелки хода
  cake: boolean; // после переноса собрался торт
}

function auditResolveTurn(state: GState, lastPlaced: readonly CellIndex[]): {
  steps: AuditStep[];
  cakes: number;
} {
  const steps: AuditStep[] = [];
  const touched = new Set<CellIndex>(lastPlaced);
  let cakes = 0;

  const done0 = findCompletion(state);
  if (done0) {
    applyCompletion(state, done0.cell);
    cakes++;
  }
  for (;;) {
    const t = planNextTransfer(state, lastPlaced, DEFAULT_CASCADE_CONFIG);
    if (!t) break;
    const chain = t.path.length > 2;
    const unrelated = !touched.has(t.from) && !touched.has(t.to) && !t.path.some((c) => touched.has(c));
    applyTransfer(state, t);
    let cake = false;
    const done = findCompletion(state);
    if (done) {
      applyCompletion(state, done.cell);
      cakes++;
      cake = true;
    }
    steps.push({ t: { ...t, chain }, unrelated, cake });
    touched.add(t.from);
    touched.add(t.to);
    for (const c of t.path) touched.add(c);
  }
  return { steps, cakes };
}

function stateFingerprint(s: GState): string {
  return JSON.stringify({
    board: s.board.map((p) => (p ? p.slices.map((x) => x.flavor) : null)),
    points: s.points,
    completed: s.completed,
    combo: s.combo,
  });
}

function crossCheck(): void {
  const mismatches: string[] = [];
  let checked = 0;

  for (let level = 1; level <= 30; level++) {
    const lvl = getLevel(level - 1);
    const st = createInitialStateV0(lvl);
    for (let move = 0; move < 40; move++) {
      const mv = bestMove(st);
      if (!mv) break;
      applyTrayMove(st, mv);
      // сверка №1: первый кандидат перечислителя == planNextTransfer
      const snapshot = cloneState(st);
      const theirs = planNextTransfer(snapshot, mv.cells, DEFAULT_CASCADE_CONFIG);
      const directs = enumerateDirect(st, mv.cells);
      const chains = enumerateChains(st, mv.cells);
      const mine = directs.length > 0 ? directs[0] : chains.length > 0 ? chains[0] : null;
      const norm = (x: Transfer | null) => (x ? { from: x.from, to: x.to, flavor: x.flavor, count: x.count } : null);
      if (JSON.stringify(norm(mine)) !== JSON.stringify(norm(theirs))) {
        mismatches.push(`L${level} M${move}: план ${JSON.stringify(norm(theirs))} != перечислитель ${JSON.stringify(norm(mine))}`);
        if (mismatches.length > 3) break;
      }
      checked++;
      // сверка №2: полный цикл разрешения совпадает с resolveTurn
      // (V0-эталон Этапа A — уровни теперь несут свой cascade-конфиг)
      const s1 = cloneState(st);
      s1.cascade = DEFAULT_CASCADE_CONFIG;
      const s2 = cloneState(st);
      const real = resolveTurn(s1, mv.cells);
      const mine2 = auditResolveTurn(s2, mv.cells);
      if (stateFingerprint(s1) !== stateFingerprint(s2) || real.cakes !== mine2.cakes || real.transfers !== mine2.steps.length) {
        mismatches.push(`L${level} M${move}: расхождение цикла разрешения (fingerprint/счётчики)`);
        if (mismatches.length > 3) break;
      }
      topUpTray(lvl, st);
      const end = evalEnd(st);
      if (end.phase !== 'playing') break;
    }
    if (mismatches.length > 3) break;
  }
  if (mismatches.length > 0) {
    console.error('КРОСС-ПРОВЕРКА ПРОВАЛЕНА:');
    for (const m of mismatches) console.error('  ' + m);
    process.exit(1);
  }
  console.log(`Кросс-проверка перечислителя и цикла разрешения: OK (${checked} ходов, расхождений нет)\n`);
}

/* ==================================================================== */
/* 2. Симуляция текущих правил                                           */
/* ==================================================================== */

type Strategy = (state: GState) => Move | null;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomStrategy(seed: number): Strategy {
  const rng = mulberry32(seed);
  return (state) => {
    const moves = legalMoves(state);
    if (moves.length === 0) return null;
    return moves[Math.floor(rng() * moves.length)];
  };
}

interface TurnStat {
  transfers: number;
  chainTransfers: number;
  maxPath: number;
  cakes: number;
  unrelatedTransfers: number;
  freeCellsAfter: number;
  platesFreed: number; // тарелок покинуло поле (пустые доноры + собранные торты)
}

interface GameStat {
  level: number;
  won: boolean;
  reason: string;
  moves: number;
  points: number;
  target: number;
  turns: TurnStat[];
}

const MOVE_CAP = 400;

function playGame(levelIdx: number, strategy: Strategy): GameStat {
  const lvl = getLevel(levelIdx);
  const st = createInitialStateV0(lvl);
  const turns: TurnStat[] = [];
  let outcome = 'cap';
  for (let move = 0; move < MOVE_CAP; move++) {
    const mv = strategy(st);
    if (!mv) {
      outcome = 'nomove';
      break;
    }
    applyTrayMove(st, mv);
    const platesBefore = st.board.filter(Boolean).length;
    const rep = auditResolveTurn(st, mv.cells);
    topUpTray(lvl, st);
    const end = evalEnd(st);
    turns.push({
      transfers: rep.steps.length,
      chainTransfers: rep.steps.filter((s) => s.t.chain).length,
      maxPath: rep.steps.reduce((m, s) => Math.max(m, s.t.path.length), 0),
      cakes: rep.cakes,
      unrelatedTransfers: rep.steps.filter((s) => s.unrelated).length,
      freeCellsAfter: freeCells(st).length,
      platesFreed: platesBefore - st.board.filter(Boolean).length,
    });
    if (end.phase === 'won') {
      outcome = 'won';
      break;
    }
    if (end.phase === 'lost') {
      outcome = `lost:${end.reason}`;
      break;
    }
  }
  return { level: levelIdx + 1, won: outcome === 'won', reason: outcome, moves: turns.length, points: st.points, target: st.target, turns };
}

function aggregate(games: GameStat[]): void {
  const allTurns = games.flatMap((g) => g.turns);
  const n = allTurns.length || 1;
  const cakeDist = new Map<number, number>();
  for (const t of allTurns) cakeDist.set(t.cakes, (cakeDist.get(t.cakes) ?? 0) + 1);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const maxCakesTurn = allTurns.reduce((m, t) => Math.max(m, t.cakes), 0);
  const transfersPerTurn = avg(allTurns.map((t) => t.transfers));
  const chainShare = avg(allTurns.map((t) => (t.transfers ? t.chainTransfers / t.transfers : 0)));
  const maxPathAll = allTurns.reduce((m, t) => Math.max(m, t.maxPath), 0);
  const avgMaxPath = avg(allTurns.map((t) => t.maxPath).filter((x) => x > 0));
  const unrelatedShare = avg(allTurns.map((t) => (t.transfers ? t.unrelatedTransfers / t.transfers : 0)));
  const turnHasUnrelated = allTurns.filter((t) => t.unrelatedTransfers > 0).length / n;
  const avgFree = avg(allTurns.map((t) => t.freeCellsAfter));
  const minFree = allTurns.reduce((m, t) => Math.min(m, t.freeCellsAfter), 9);
  const avgFreed = avg(allTurns.map((t) => t.platesFreed));

  console.log(`  Партий: ${games.length}; побед: ${games.filter((g) => g.won).length}/${games.length}` +
    `; ходов до исхода: средн. ${avg(games.map((g) => g.moves)).toFixed(1)}` +
    ` (мин ${Math.min(...games.map((g) => g.moves))}, макс ${Math.max(...games.map((g) => g.moves))})`);
  const reasons = [...new Set(games.map((g) => g.reason))];
  console.log(`  Причины конца: ${reasons.map((r) => `${r} ×${games.filter((g) => g.reason === r).length}`).join(', ')}`);
  console.log(`  Ходов всего: ${n}`);
  console.log(`  Торты за ход: средн. ${(allTurns.reduce((a, t) => a + t.cakes, 0) / n).toFixed(2)}; максимум за один ход: ${maxCakesTurn}`);
  console.log(`  Распределение тортов за ход: ${[...cakeDist.keys()].sort((a, b) => a - b).map((k) => `${k} шт: ${((cakeDist.get(k)! / n) * 100).toFixed(0)}%`).join('  ')}`);
  console.log(`  Ходов с ≥1 тортом: ${((allTurns.filter((t) => t.cakes > 0).length / n) * 100).toFixed(0)}%; с ≥2: ${((allTurns.filter((t) => t.cakes >= 2).length / n) * 100).toFixed(0)}%; с ≥3: ${((allTurns.filter((t) => t.cakes >= 3).length / n) * 100).toFixed(0)}%`);
  console.log(`  Переносов за ход: средн. ${transfersPerTurn.toFixed(2)}; доля цепочечных: ${(chainShare * 100).toFixed(0)}%`);
  console.log(`  Длина маршрута: макс ${maxPathAll} тарелок; средн. макс за ход (только с цепочками) ${avgMaxPath.toFixed(2)}`);
  console.log(`  «Посторонние» переносы (не касаются тарелок, вовлечённых в ход): ${(unrelatedShare * 100).toFixed(0)}% всех переносов; ходов с посторонними: ${(turnHasUnrelated * 100).toFixed(0)}%`);
  console.log(`  Свободные ячейки после хода: средн. ${avgFree.toFixed(2)} из 9, минимум ${minFree}`);
  console.log(`  Тарелок покидает поле за ход: средн. ${avgFreed.toFixed(2)}\n`);
}

/* ==================================================================== */
/* 3. Экспериментальные варианты каскада (правила игры не трогаем)       */
/* ==================================================================== */

interface CascadeVariant {
  name: string;
  /** максимум переносов за ход; Infinity — без ограничения */
  maxTransfers: number;
  /** максимум тортов за ход; Infinity — без ограничения */
  maxCakes: number;
  /** цепочечные переносы: 'all' — как сейчас, 'off' — только прямые */
  chains: 'all' | 'off';
  /** максимальное число «прыжков» цепочки (2 = один транзит) */
  maxChainHops: number;
  /** перенос разрешён, только если затрагивает тарелки, уже вовлечённые
   *  в ход (размещённые или участвовавшие в переносах/сборках) */
  locality: boolean;
  /** сначала переносы вовлечённых тарелок, потом остальные */
  placedFirst: boolean;
}

const VARIANTS: CascadeVariant[] = [
  { name: 'V0-текущая', maxTransfers: Infinity, maxCakes: Infinity, chains: 'all', maxChainHops: Infinity, locality: false, placedFirst: false },
  { name: 'V1-торт1', maxTransfers: Infinity, maxCakes: 1, chains: 'all', maxChainHops: Infinity, locality: false, placedFirst: false },
  { name: 'V2-перен4', maxTransfers: 4, maxCakes: Infinity, chains: 'all', maxChainHops: Infinity, locality: false, placedFirst: false },
  { name: 'V3-безЦеп', maxTransfers: Infinity, maxCakes: Infinity, chains: 'off', maxChainHops: 1, locality: false, placedFirst: false },
  { name: 'V4-локал', maxTransfers: Infinity, maxCakes: Infinity, chains: 'all', maxChainHops: Infinity, locality: true, placedFirst: false },
  { name: 'V5-локал+торт1', maxTransfers: Infinity, maxCakes: 1, chains: 'all', maxChainHops: Infinity, locality: true, placedFirst: false },
  { name: 'H2-макс2прыжка', maxTransfers: Infinity, maxCakes: Infinity, chains: 'all', maxChainHops: 2, locality: false, placedFirst: false },
  { name: 'H3-макс3прыжка', maxTransfers: Infinity, maxCakes: Infinity, chains: 'all', maxChainHops: 3, locality: false, placedFirst: false },
  { name: 'H4-макс4прыжка', maxTransfers: Infinity, maxCakes: Infinity, chains: 'all', maxChainHops: 4, locality: false, placedFirst: false },
];

/** Разрешение хода по варианту каскада. Возвращает статистику хода. */
function resolveVariant(state: GState, lastPlaced: readonly CellIndex[], cfg: CascadeVariant): {
  transfers: number;
  cakes: number;
  chainTransfers: number;
  maxPath: number;
  unrelated: number;
  truncated: boolean;
} {
  let transfers = 0;
  let cakes = 0;
  let chainTransfers = 0;
  let maxPath = 0;
  let unrelated = 0;
  let truncated = false;
  const touched = new Set<CellIndex>(lastPlaced);

  const done0 = findCompletion(state);
  if (done0) {
    applyCompletion(state, done0.cell);
    cakes++;
    touched.delete(done0.cell);
  }

  const GUARD = 1000; // защита от вечного цикла (ТЗ 3.6)
  for (let step = 0; step < GUARD; step++) {
    if (cakes >= cfg.maxCakes || transfers >= cfg.maxTransfers) {
      truncated = true;
      break;
    }
    const directs = enumerateDirect(state, lastPlaced);
    const chains = cfg.chains === 'off' ? [] : enumerateChains(state, lastPlaced, cfg.maxChainHops);
    let pool: TransferCandidate[] = [...directs, ...chains];
    if (cfg.locality) {
      pool = pool.filter((t) => touched.has(t.from) || touched.has(t.to));
    }
    if (pool.length === 0) break;
    const pick = pool[0];
    const isUnrelated = !touched.has(pick.from) && !touched.has(pick.to);
    applyTransfer(state, pick);
    transfers++;
    if (pick.chain) chainTransfers++;
    maxPath = Math.max(maxPath, pick.path.length);
    if (isUnrelated) unrelated++;
    touched.add(pick.from);
    touched.add(pick.to);
    if (!state.board[pick.from]) touched.delete(pick.from); // тарелка исчезла
    const done = findCompletion(state);
    if (done) {
      applyCompletion(state, done.cell);
      cakes++;
      touched.delete(done.cell);
    }
  }
  return { transfers, cakes, chainTransfers, maxPath, unrelated, truncated };
}

function playVariant(levelIdx: number, strategy: Strategy, cfg: CascadeVariant): GameStat & { truncatedTurns: number } {
  const lvl = getLevel(levelIdx);
  const st = createInitialStateV0(lvl);
  const turns: TurnStat[] = [];
  let truncatedTurns = 0;
  let outcome = 'cap';
  for (let move = 0; move < MOVE_CAP; move++) {
    const mv = strategy(st);
    if (!mv) {
      outcome = 'nomove';
      break;
    }
    applyTrayMove(st, mv);
    const rep = resolveVariant(st, mv.cells, cfg);
    if (rep.truncated) truncatedTurns++;
    topUpTray(lvl, st);
    const end = evalEnd(st);
    turns.push({
      transfers: rep.transfers,
      chainTransfers: rep.chainTransfers,
      maxPath: rep.maxPath,
      cakes: rep.cakes,
      unrelatedTransfers: rep.unrelated,
      freeCellsAfter: freeCells(st).length,
      platesFreed: 0,
    });
    if (end.phase === 'won') {
      outcome = 'won';
      break;
    }
    if (end.phase === 'lost') {
      outcome = `lost:${end.reason}`;
      break;
    }
  }
  return { level: levelIdx + 1, won: outcome === 'won', reason: outcome, moves: turns.length, points: st.points, target: st.target, turns, truncatedTurns };
}

/* ==================================================================== */
/* 3. Срезы: по уровням, агентность, заполненность стола                 */
/* ==================================================================== */

/** Разбивка по уровням: как интенсивность меняется с прогрессией */
function perLevelTable(): void {
  console.log(`${'уровень'.padEnd(9)}${'пул'.padEnd(5)}${'нач'.padEnd(5)}${'цель'.padEnd(7)}${'ходов'.padEnd(8)}${'торт/ход'.padEnd(10)}${'%ходов с тортом'.padEnd(17)}${'своб.яч'.padEnd(9)}максТ`);
  for (let i = 0; i < LEVELS; i++) {
    const g = playGame(i, bestMove);
    const n = g.turns.length || 1;
    const avgFree = g.turns.reduce((a, t) => a + t.freeCellsAfter, 0) / n;
    const withCake = (g.turns.filter((t) => t.cakes > 0).length / n) * 100;
    const cakes = g.turns.reduce((a, t) => a + t.cakes, 0) / n;
    const maxC = g.turns.reduce((m, t) => Math.max(m, t.cakes), 0);
    const pool = new Set(getLevelPool(i)).size;
    console.log(
      String(g.level).padEnd(9) + String(pool).padEnd(5) + String(getLevelInitial(i)).padEnd(5) +
      String(g.target).padEnd(7) + String(g.moves).padEnd(8) + cakes.toFixed(2).padEnd(10) +
      `${withCake.toFixed(0)}%`.padEnd(17) + avgFree.toFixed(2).padEnd(9) + String(maxC),
    );
  }
  console.log('');
}

function getLevelPool(levelIdx: number): number[] {
  const lvl = getLevel(levelIdx);
  return lvl.stream?.flavors ?? [];
}
function getLevelInitial(levelIdx: number): number {
  return getLevel(levelIdx).initial.length;
}

/** Агентность: различимы ли исходы хода для игрока?
 *  Для каждого сэмпла состояния перебираем ВСЕ допустимые ходы,
 *  каждому — полное разрешение. Если все ходы дают одинаковые очки/торты,
 *  выбор игрока не влияет на результат хода. */
function agencyAnalysis(): void {
  let statesChecked = 0;
  let sameCakesAll = 0;
  let samePointsAll = 0;
  const pointSpreads: number[] = [];
  const cakeSpreads: number[] = [];
  const moveCounts: number[] = [];

  for (let i = 0; i < LEVELS; i++) {
    const lvl = getLevel(i);
    const st = createInitialStateV0(lvl);
    for (let turn = 0; turn < 6; turn++) {
      const moves = legalMoves(st);
      if (moves.length === 0) break;
      const outcomes = moves.map((mv) => {
        const c = cloneState(st);
        c.cascade = DEFAULT_CASCADE_CONFIG; // V0-эталон Этапа A
        applyTrayMove(c, mv);
        resolveTurn(c, mv.cells);
        return { points: c.points - st.points, cakes: c.combo };
      });
      const pts = outcomes.map((o) => o.points);
      const cks = outcomes.map((o) => o.cakes);
      const pSpread = Math.max(...pts) - Math.min(...pts);
      const cSpread = Math.max(...cks) - Math.min(...cks);
      pointSpreads.push(pSpread);
      cakeSpreads.push(cSpread);
      moveCounts.push(moves.length);
      if (cSpread === 0) sameCakesAll++;
      if (pSpread === 0) samePointsAll++;
      statesChecked++;
      // продолжаем партию жадным, чтобы взять следующий реальный сэмпл
      const mv = bestMove(st);
      if (!mv) break;
      applyTrayMove(st, mv);
      auditResolveTurn(st, mv.cells);
      topUpTray(lvl, st);
      if (evalEnd(st).phase !== 'playing') break;
    }
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log(`  Состояний проверено: ${statesChecked}; допустимых ходов в среднем: ${avg(moveCounts).toFixed(0)}`);
  console.log(`  Все ходы дают одинаковое число тортов: ${(sameCakesAll / statesChecked * 100).toFixed(0)}% состояний`);
  console.log(`  Все ходы дают одинаковые очки: ${(samePointsAll / statesChecked * 100).toFixed(0)}% состояний`);
  console.log(`  Разброс очков по ходам: средн. ${avg(pointSpreads).toFixed(0)} (макс ${Math.max(...pointSpreads)})`);
  console.log(`  Разброс тортов по ходам: средн. ${avg(cakeSpreads).toFixed(2)} (макс ${Math.max(...cakeSpreads)})\n`);
}

/** Каскад в зависимости от заполненности стола до хода */
function fullnessBuckets(): void {
  const buckets = new Map<string, { transfers: number[]; cakes: number[]; freed: number[]; chain: number[]; count: number }>();
  const key = (free: number) => (free <= 2 ? '0–2 (заполнен)' : free <= 4 ? '3–4' : free <= 6 ? '5–6' : '7–9 (пуст)');
  const add = (k: string, t: number, c: number, f: number, ch: number) => {
    const b = buckets.get(k) ?? { transfers: [], cakes: [], freed: [], chain: [], count: 0 };
    b.transfers.push(t);
    b.cakes.push(c);
    b.freed.push(f);
    b.chain.push(ch);
    b.count++;
    buckets.set(k, b);
  };
  for (let i = 0; i < LEVELS; i++) {
    const lvl = getLevel(i);
    for (const strategy of [bestMove, randomStrategy(2000 + i)]) {
      const st = createInitialStateV0(lvl);
      for (let move = 0; move < MOVE_CAP; move++) {
        const mv = strategy(st);
        if (!mv) break;
        const freeBefore = freeCells(st).length;
        const platesBefore = st.board.filter(Boolean).length;
        applyTrayMove(st, mv);
        const rep = auditResolveTurn(st, mv.cells);
        topUpTray(lvl, st);
        add(key(freeBefore), rep.steps.length, rep.cakes, platesBefore - st.board.filter(Boolean).length, rep.steps.filter((s) => s.t.chain).length);
        const end = evalEnd(st);
        if (end.phase !== 'playing') break;
      }
    }
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log(`  ${'своб. ячеек до хода'.padEnd(20)}${'ходов'.padEnd(8)}${'переносов'.padEnd(11)}${'%цеп'.padEnd(6)}${'тортов'.padEnd(8)}тарелок покинет`);
  for (const k of ['0–2 (заполнен)', '3–4', '5–6', '7–9 (пуст)']) {
    const b = buckets.get(k);
    if (!b) continue;
    console.log(
      `  ${k.padEnd(20)}${String(b.count).padEnd(8)}${avg(b.transfers).toFixed(2).padEnd(11)}` +
      `${(avg(b.chain) / (avg(b.transfers) || 1) * 100).toFixed(0)}%`.padEnd(6) +
      `${avg(b.cakes).toFixed(2).padEnd(8)}${avg(b.freed).toFixed(2)}`,
    );
  }
  console.log('');
}

/* ==================================================================== */
/* 3b. Анатомия самых бурных ходов (ТЗ 3.2 п.7: повторные участия)        */
/* ==================================================================== */

interface TurnTrace {
  level: number;
  move: number;
  steps: AuditStep[];
  cakes: number;
}

function stormAnatomy(): void {
  const traces: TurnTrace[] = [];
  let maxTransfers = 0;
  const pairRepeats: number[] = [];
  const plateParticipation: number[] = [];

  for (let i = 0; i < LEVELS; i++) {
    const lvl = getLevel(i);
    const st = createInitialStateV0(lvl);
    for (let move = 0; move < MOVE_CAP; move++) {
      const mv = bestMove(st);
      if (!mv) break;
      applyTrayMove(st, mv);
      const rep = auditResolveTurn(st, mv.cells);
      topUpTray(lvl, st);
      maxTransfers = Math.max(maxTransfers, rep.steps.length);
      const pairCount = new Map<string, number>();
      const plateCount = new Map<number, number>();
      for (const s of rep.steps) {
        const key = s.t.from < s.t.to ? `${s.t.from}-${s.t.to}` : `${s.t.to}-${s.t.from}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        plateCount.set(s.t.from, (plateCount.get(s.t.from) ?? 0) + 1);
        plateCount.set(s.t.to, (plateCount.get(s.t.to) ?? 0) + 1);
      }
      pairRepeats.push(Math.max(0, ...pairCount.values()));
      plateParticipation.push(Math.max(0, ...plateCount.values()));
      traces.push({ level: i + 1, move: move + 1, steps: rep.steps, cakes: rep.cakes });
      if (evalEnd(st).phase !== 'playing') break;
    }
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log(`  Максимум переносов за один ход: ${maxTransfers}; средн. ${avg(traces.map((t) => t.steps.length)).toFixed(2)}`);
  console.log(`  Максимум повторов одной пары тарелок за ход: ${Math.max(...pairRepeats)}; средн. ${avg(pairRepeats).toFixed(2)}`);
  console.log(`  Максимум участий одной тарелки в переносах за ход: ${Math.max(...plateParticipation)}; средн. ${avg(plateParticipation).toFixed(2)}`);

  // трассировка самого «бурного» хода (максимум тортов, затем переносов)
  const storm = traces.reduce((best, t) => {
    if (t.cakes > best.cakes) return t;
    if (t.cakes === best.cakes && t.steps.length > best.steps.length) return t;
    return best;
  }, traces[0]);
  console.log(`\n  Трассировка самого бурного хода: уровень ${storm.level}, ход ${storm.move} — ` +
    `${storm.cakes} торт(а), ${storm.steps.length} переносов:`);
  storm.steps.forEach((s, k) => {
    const path = s.t.path.map((c) => `${c}`).join('→');
    console.log(`    ${String(k + 1).padStart(2)}. ${s.t.flavor !== undefined ? `вкус ${s.t.flavor}` : ''} ×${s.t.count}: ${path}${s.t.chain ? ' (цепочка)' : ''}${s.cake ? ' → ТОРТ' : ''}`);
  });
  console.log('');
}

/* ==================================================================== */
/* 4. Эксперименты с составом выдачи (генератор не трогаем —             */
/*    экспериментальные потоки собираются здесь же)                      */
/* ==================================================================== */

interface GenConfig {
  name: string;
  /** ёмкость пула вкусов (влияет на частоту совпадений) */
  poolCap: number;
  /** минимум вкусов на обычной тарелке */
  minFlavors: number;
  /** максимум вкусов на обычной тарелке */
  maxFlavors: number;
  /** чистые тарелки 1–2 кусочка (топливо слияний) */
  cleanChance: number;
  /** «почти торты» 5 кусочков */
  heavyChance: number;
}

function expPlateSlices(rng: () => number, flavors: number[], cfg: GenConfig): number[] {
  if (cfg.heavyChance > 0 && rng() < cfg.heavyChance) {
    return new Array(5).fill(flavors[Math.floor(rng() * flavors.length)]);
  }
  if (cfg.cleanChance > 0 && rng() < cfg.cleanChance) {
    const f = flavors[Math.floor(rng() * flavors.length)];
    return new Array(1 + Math.floor(rng() * 2)).fill(f);
  }
  const distinct = cfg.minFlavors + Math.floor(rng() * (cfg.maxFlavors - cfg.minFlavors + 1));
  const chosen: number[] = [];
  while (chosen.length < Math.min(distinct, flavors.length)) {
    const f = flavors[Math.floor(rng() * flavors.length)];
    if (!chosen.includes(f)) chosen.push(f);
  }
  const out: number[] = [];
  for (const f of chosen) {
    const k = rng() < 0.62 ? 1 : 2;
    for (let i = 0; i < k; i++) out.push(f);
  }
  return out;
}

/** Экспериментальный уровень: та же структура buildLevel, но поток —
 *  по конфигу эксперимента. Правила игры не меняются. */
function buildExpLevel(n: number, cfg: GenConfig): { level: LevelData; topUp: (st: GState) => void } {
  const base = getLevel(n - 1); // сиды и цель — как у настоящего уровня
  const rng = mulberry32(0x9e37 ^ n);
  const unlocked = Math.min(16, n + 1);
  const poolSize = Math.min(cfg.poolCap, unlocked);
  const candidates: number[] = [];
  for (let i = 0; i < unlocked; i++) candidates.push(i);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const flavors = candidates.slice(0, poolSize).sort((a, b) => a - b);

  const initialCount = n <= 2 ? 2 : 3;
  const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const initial = cells.slice(0, initialCount).map((cell) => ({
    row: Math.floor(cell / 3),
    col: cell % 3,
    slices: expPlateSlices(rng, flavors, cfg),
  }));

  const item = (i: number): { kind: 'single'; slices: number[] } => ({
    kind: 'single',
    slices: expPlateSlices(mulberry32((n * 2654435761 ^ i * 40503) >>> 0), flavors, cfg),
  });
  let next = 0;
  const topUp = (st: GState) => {
    while (st.tray.length < 7) st.tray.push(item(next++));
  };
  const level: LevelData = {
    rows: 3,
    cols: 3,
    initial,
    tray: [],
    target: base.target,
  };
  return { level, topUp };
}

function playGenExperiment(cfg: GenConfig, strategy: Strategy): {
  wins: number;
  avgMoves: number;
  cakesPerTurn: number;
  maxCakes: number;
  share2: number;
  avgFree: number;
  transfersPerTurn: number;
} {
  const games: GameStat[] = [];
  for (let i = 1; i <= LEVELS; i++) {
    const { level, topUp } = buildExpLevel(i, cfg);
    const st = createInitialStateV0(level);
    topUp(st); // первичное заполнение очереди (в игре это делает buildLevel)
    const turns: TurnStat[] = [];
    let outcome = 'cap';
    for (let move = 0; move < MOVE_CAP; move++) {
      const mv = strategy(st);
      if (!mv) {
        outcome = 'nomove';
        break;
      }
      applyTrayMove(st, mv);
      const rep = auditResolveTurn(st, mv.cells);
      topUp(st);
      const end = evalEnd(st);
      turns.push({
        transfers: rep.steps.length,
        chainTransfers: rep.steps.filter((s) => s.t.chain).length,
        maxPath: 0,
        cakes: rep.cakes,
        unrelatedTransfers: 0,
        freeCellsAfter: freeCells(st).length,
        platesFreed: 0,
      });
      if (end.phase === 'won') {
        outcome = 'won';
        break;
      }
      if (end.phase === 'lost') {
        outcome = 'lost';
        break;
      }
    }
    games.push({ level: i, won: outcome === 'won', reason: outcome, moves: turns.length, points: st.points, target: st.target, turns });
  }
  const allTurns = games.flatMap((g) => g.turns);
  const n = allTurns.length || 1;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return {
    wins: games.filter((g) => g.won).length,
    avgMoves: avg(games.map((g) => g.moves)),
    cakesPerTurn: allTurns.reduce((a, t) => a + t.cakes, 0) / n,
    maxCakes: allTurns.reduce((m, t) => Math.max(m, t.cakes), 0),
    share2: (allTurns.filter((t) => t.cakes >= 2).length / n) * 100,
    avgFree: avg(allTurns.map((t) => t.freeCellsAfter)),
    transfersPerTurn: avg(allTurns.map((t) => t.transfers)),
  };
}

function generatorExperiments(): void {
  const configs: GenConfig[] = [
    { name: 'G0-базовый(2-3 вкуса)', poolCap: 6, minFlavors: 2, maxFlavors: 3, cleanChance: 0.09, heavyChance: 0.025 },
    { name: 'G1-всегда3вкуса', poolCap: 6, minFlavors: 3, maxFlavors: 3, cleanChance: 0.09, heavyChance: 0.025 },
    { name: 'G2-пул5', poolCap: 5, minFlavors: 2, maxFlavors: 3, cleanChance: 0.09, heavyChance: 0.025 },
    { name: 'G3-пул7', poolCap: 7, minFlavors: 2, maxFlavors: 3, cleanChance: 0.09, heavyChance: 0.025 },
    { name: 'G4-безЧист/Тяжёлых', poolCap: 6, minFlavors: 2, maxFlavors: 3, cleanChance: 0, heavyChance: 0 },
    { name: 'G5-3вкуса+пул5', poolCap: 5, minFlavors: 3, maxFlavors: 3, cleanChance: 0, heavyChance: 0.025 },
  ];
  console.log(`${'конфиг выдачи'.padEnd(23)}${'игрок'.padEnd(9)}${'побед'.padEnd(8)}${'ходов'.padEnd(8)}${'торт/ход'.padEnd(10)}${'максТ'.padEnd(7)}${'%≥2т'.padEnd(7)}${'перен/ход'.padEnd(11)}своб.яч`);
  for (const cfg of configs) {
    for (const [label, strat] of [['жадный', bestMove as Strategy], ['случайный', randomStrategy(3000) as Strategy]]) {
      const r = playGenExperiment(cfg, strat);
      console.log(
        cfg.name.padEnd(23) + label.padEnd(9) + `${r.wins}/${LEVELS}`.padEnd(8) + r.avgMoves.toFixed(1).padEnd(8) +
        r.cakesPerTurn.toFixed(2).padEnd(10) + String(r.maxCakes).padEnd(7) + `${r.share2.toFixed(0)}%`.padEnd(7) +
        r.transfersPerTurn.toFixed(2).padEnd(11) + r.avgFree.toFixed(2),
      );
    }
  }
  console.log('');
}

/* ==================================================================== */
/* 5. Запуск                                                             */
/* ==================================================================== */

const LEVELS = 30;

console.log('='.repeat(72));
console.log('АУДИТ ЦЕПНОЙ РЕАКЦИИ — Cake Sort «Кондитерская» (Этап A, ТЗ Этап 2)');
console.log('='.repeat(72) + '\n');

crossCheck();

console.log(`--- Текущие правила: уровни 1..${LEVELS} ---\n`);
console.log('[Жадный игрок = bestMove, как подсказка в игре]');
aggregate(Array.from({ length: LEVELS }, (_, i) => playGame(i, bestMove)));
console.log('[Случайный игрок]');
aggregate(Array.from({ length: LEVELS }, (_, i) => playGame(i, randomStrategy(1000 + i))));

console.log('--- Варианты каскада (жадный игрок, те же уровни/сидов) ---\n');
console.log(`${'вариант'.padEnd(17)}${'побед'.padEnd(8)}${'ходов'.padEnd(8)}${'торт/ход'.padEnd(10)}${'максТ'.padEnd(7)}${'%≥2т'.padEnd(7)}${'перен/ход'.padEnd(11)}${'%цеп'.padEnd(6)}${'своб.яч'.padEnd(9)}обр.*`);
for (const cfg of VARIANTS) {
  const games = Array.from({ length: LEVELS }, (_, i) => playVariant(i, bestMove, cfg));
  const allTurns = games.flatMap((g) => g.turns);
  const n = allTurns.length || 1;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const wins = games.filter((g) => g.won).length;
  const avgMoves = avg(games.map((g) => g.moves));
  const cakesPerTurn = allTurns.reduce((a, t) => a + t.cakes, 0) / n;
  const maxCakes = allTurns.reduce((m, t) => Math.max(m, t.cakes), 0);
  const share2 = (allTurns.filter((t) => t.cakes >= 2).length / n) * 100;
  const transfersPerTurn = avg(allTurns.map((t) => t.transfers));
  const chainShare = avg(allTurns.map((t) => (t.transfers ? (t.chainTransfers / t.transfers) * 100 : 0)));
  const avgFree = avg(allTurns.map((t) => t.freeCellsAfter));
  console.log(
    cfg.name.padEnd(17) +
      `${wins}/${LEVELS}`.padEnd(8) +
      avgMoves.toFixed(1).padEnd(8) +
      cakesPerTurn.toFixed(2).padEnd(10) +
      String(maxCakes).padEnd(7) +
      `${share2.toFixed(0)}%`.padEnd(7) +
      transfersPerTurn.toFixed(2).padEnd(11) +
      `${chainShare.toFixed(0)}%`.padEnd(6) +
      avgFree.toFixed(2).padEnd(9) +
      String(games.reduce((a, g) => a + g.truncatedTurns, 0)),
  );
}
console.log('\n* обр. — ходов, оборванных ограничением (достижение лимита до полной стабилизации)');

console.log('\n--- Контроль: V0/H2/H3 на случайном игроке ---\n');
console.log(`${'вариант'.padEnd(17)}${'побед'.padEnd(8)}${'ходов'.padEnd(8)}${'торт/ход'.padEnd(10)}${'максТ'.padEnd(7)}${'%≥2т'.padEnd(7)}${'перен/ход'.padEnd(11)}${'%цеп'.padEnd(6)}своб.яч`);
for (const cfg of VARIANTS.filter((v) => ['V0-текущая', 'H2-макс2прыжка', 'H3-макс3прыжка'].includes(v.name))) {
  const games = Array.from({ length: LEVELS }, (_, i) => playVariant(i, randomStrategy(5000 + i), cfg));
  const allTurns = games.flatMap((g) => g.turns);
  const n = allTurns.length || 1;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  console.log(
    cfg.name.padEnd(17) +
      `${games.filter((g) => g.won).length}/${LEVELS}`.padEnd(8) +
      avg(games.map((g) => g.moves)).toFixed(1).padEnd(8) +
      (allTurns.reduce((a, t) => a + t.cakes, 0) / n).toFixed(2).padEnd(10) +
      String(allTurns.reduce((m, t) => Math.max(m, t.cakes), 0)).padEnd(7) +
      `${((allTurns.filter((t) => t.cakes >= 2).length / n) * 100).toFixed(0)}%`.padEnd(7) +
      avg(allTurns.map((t) => t.transfers)).toFixed(2).padEnd(11) +
      `${avg(allTurns.map((t) => (t.transfers ? (t.chainTransfers / t.transfers) * 100 : 0))).toFixed(0)}%`.padEnd(6) +
      avg(allTurns.map((t) => t.freeCellsAfter)).toFixed(2),
  );
}

console.log('--- Срез по уровням (жадный игрок) ---\n');
perLevelTable();

console.log('--- Значимость выбора игрока (агентность) ---\n');
agencyAnalysis();

console.log('--- Каскад и заполненность стола (оба игрока) ---\n');
fullnessBuckets();

console.log('--- Анатомия самых бурных ходов (жадный игрок) ---\n');
stormAnatomy();

console.log('--- Эксперименты с составом выдачи (те же правила, другой поток) ---\n');
generatorExperiments();
