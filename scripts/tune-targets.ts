/**
 * Cake Sort — «Кондитерская»: калибровка кривой целей и дальности цепочки
 * (ТЗ Этап 2, Этап B; аудит §6.3 и §8.1–8.2).
 * Запуск: npx tsx scripts/tune-targets.ts
 *
 * Факты, на которые опирается калибровка:
 *  - траектория игрока НЕ зависит от цели: и жадный, и случайный выбирают
 *    ход без оглядки на target, поэтому очки в момент проигрыша (стол полон)
 *    — детерминированная характеристика (уровень, стратегия, сид);
 *  - подсказка bestMove после Этапа B оценивает ходы правилами уровня
 *    (state.cascade), как и игра; в аудите H2 оценка шла по V0 — отсюда
 *    «жадный 21/30». При согласованной оценке жадный не проигрывает
 *    ни одного уровня (потолок ~12000 очков за 200 ходов).
 *
 * Фазы:
 *  1) Потолки: уровни 1..40 играются жадным и случайным (3 сида) с
 *     недостижимой целью — фиксируются очки в момент проигрыша/кэпа.
 *  2) Развёртка масштаба цели под коридор аудита §8.2:
 *     жадный 95–100% побед, случайный 40–70% (доля побед сидов),
 *     длина уровня жадного 15–25 ходов.
 *  3) Сводка B1 (прогрессия maxChainHops) против V0 (до Этапа B).
 *
 * Симуляция не требует Three.js и GSAP; правила — те же game/rules.ts.
 */

import {
  applyTrayMove,
  bestMove,
  createInitialState,
  evalEnd,
  freeCells,
  legalMoves,
  resolveTurnLogged,
  type Move,
} from '../src/puzzle/game/rules';
import { buildLevel, targetFor, topUpTray } from '../src/puzzle/game/levels';
import type { CascadeConfig, GState, LevelData } from '../src/puzzle/game/types';

/* --------------------------- ГСЧ (как в генераторе) ------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------- Конфигурации ---------------------------- */

/** Порог обучающих уровней: до него цепочки без ограничения (аудит §6.3) */
export const TRAINING_LEVELS = 5;

/** Конфиг каскада для уровня n в варианте B1 (прогрессия Этапа B) */
export function b1Cascade(n: number): Partial<CascadeConfig> {
  return { maxChainHops: n <= TRAINING_LEVELS ? Infinity : 2 };
}

/* --------------------------- Симуляция партии ------------------------ */

interface RunStats {
  outcome: 'won' | 'lost' | 'cap';
  moves: number;
  points: number;
  cakes: number;
  cakesMoves: number; // ходов хотя бы с одним тортом
  maxCakesPerMove: number;
  transfers: number;
  chainTransfers: number;
  maxPath: number; // максимальная длина маршрута в тарелках
  freeSum: number; // сумма свободных ячеек после ходов
}

/** Одна партия. Цель берётся из level.target (для потолков — завышается). */
export function playGame(
  level: LevelData,
  strategy: 'greedy' | 'random',
  rngSeed: number,
  maxMoves: number,
): RunStats {
  const st = createInitialState(level);
  const rng = mulberry32(rngSeed);
  const stats: RunStats = {
    outcome: 'cap',
    moves: 0,
    points: 0,
    cakes: 0,
    cakesMoves: 0,
    maxCakesPerMove: 0,
    transfers: 0,
    chainTransfers: 0,
    maxPath: 0,
    freeSum: 0,
  };
  for (let m = 0; m < maxMoves; m++) {
    const end = evalEnd(st);
    if (end.phase === 'won') {
      stats.outcome = 'won';
      break;
    }
    if (end.phase === 'lost') {
      stats.outcome = 'lost';
      break;
    }
    const mv = pickMove(st, strategy, rng);
    if (!mv) {
      stats.outcome = 'lost';
      break;
    }
    applyTrayMove(st, mv);
    const log = resolveTurnLogged(st, mv.cells);
    let turnCakes = 0;
    for (const ev of log) {
      if (ev.kind === 'transfer') {
        stats.transfers++;
        if (ev.transfer.path.length > 2) stats.chainTransfers++;
        stats.maxPath = Math.max(stats.maxPath, ev.transfer.path.length);
      } else if (ev.kind === 'cake') {
        stats.cakes++;
        turnCakes++;
      }
    }
    if (turnCakes > 0) {
      stats.cakesMoves++;
      stats.maxCakesPerMove = Math.max(stats.maxCakesPerMove, turnCakes);
    }
    stats.moves = m + 1;
    stats.freeSum += freeCells(st).length;
    topUpTray(level, st);
  }
  stats.points = st.points;
  return stats;
}

function pickMove(st: GState, strategy: 'greedy' | 'random', rng: () => number): Move | null {
  if (strategy === 'greedy') return bestMove(st);
  const moves = legalMoves(st);
  if (moves.length === 0) return null;
  return moves[Math.floor(rng() * moves.length)];
}

/* --------------------------- Фаза 1: потолки ------------------------- */

const N_LEVELS = 40;
const HUGE_TARGET = 10_000_000;

function phase1(): void {
  console.log('Фаза 1. Потолки очков (цель недостижима, игра до проигрыша или 200 ходов)');
  console.log(`Вариант B1: maxChainHops = ∞ (уровни 1..${TRAINING_LEVELS}), далее 2 прыжка\n`);
  console.log('урв |  жадный: очки  ходов | случайный(3 сида): очки | ходов ср.');
  for (let n = 1; n <= N_LEVELS; n++) {
    const base = buildLevel(n);
    const gLevel: LevelData = { ...base, target: HUGE_TARGET, cascade: b1Cascade(n) };
    const g = playGame(gLevel, 'greedy', 0, 200);
    const rs: number[] = [];
    let rMoves = 0;
    for (let s = 0; s < 3; s++) {
      const rLevel: LevelData = { ...base, target: HUGE_TARGET, cascade: b1Cascade(n) };
      const r = playGame(rLevel, 'random', 1000 + s * 7919, 200);
      rs.push(r.points);
      rMoves += r.moves;
    }
    console.log(
      `${String(n).padStart(3)} | ${String(g.points).padStart(6)} ${g.outcome === 'cap' ? 'кап' : g.outcome === 'lost' ? 'ПР' : 'ПОБ'}${String(g.moves).padStart(4)} | ` +
        `${rs.map((x) => String(x).padStart(5)).join(' ')} | ${Math.round(rMoves / 3)}`,
    );
  }
}

/* --------------------------- Фаза 2: развёртка ------------------------ */

function phase2(): void {
  console.log('\nФаза 2. Развёртка масштаба цели (B1; жадному ничего не грозит — потолок ~12000).');
  console.log('Критерии аудита §8.2: случайный 40–70% побед (доля сидов), длина уровня 15–25 ходов\n');
  console.log('масштаб | жадный | случайный: сиды | уровни(≥2/3 сидов) | ходы жадного (средн/мин/макс)');
  const scales = [1.0, 0.85, 0.7, 0.6, 0.5, 0.4, 0.3];
  for (const scale of scales) {
    let greedyWins = 0;
    let seedWins = 0;
    let seedTotal = 0;
    let levelMajority = 0;
    const gMoves: number[] = [];
    for (let n = 1; n <= 30; n++) {
      const base = buildLevel(n);
      const t = Math.round((targetFor(n) * scale) / 10) * 10;
      const gLevel: LevelData = { ...base, target: t, cascade: b1Cascade(n) };
      const g = playGame(gLevel, 'greedy', 0, 200);
      if (g.outcome === 'won') greedyWins++;
      gMoves.push(g.moves);
      let wonSeeds = 0;
      for (let s = 0; s < 3; s++) {
        const rLevel: LevelData = { ...base, target: t, cascade: b1Cascade(n) };
        const r = playGame(rLevel, 'random', 1000 + s * 7919, 200);
        seedTotal++;
        if (r.outcome === 'won') {
          seedWins++;
          wonSeeds++;
        }
      }
      if (wonSeeds >= 2) levelMajority++;
    }
    const avgM = gMoves.reduce((a, b) => a + b, 0) / gMoves.length;
    console.log(
      `  ${scale.toFixed(2)}  |  ${greedyWins}/30  | ${((seedWins / seedTotal) * 100).toFixed(0)}% (${seedWins}/${seedTotal}) | ${levelMajority}/30 | ${avgM.toFixed(1)} / ${Math.min(...gMoves)} / ${Math.max(...gMoves)}`,
    );
  }
}

/* --------------------------- Фаза 3: сводка --------------------------- */

function summarize(
  label: string,
  target: (n: number) => number,
  cascade: (n: number) => Partial<CascadeConfig> | undefined,
): void {
  let cakes = 0;
  let moves = 0;
  let cakesMoves = 0;
  let maxCakes = 0;
  let freeSum = 0;
  let wins = 0;
  let chainTransfers = 0;
  let transfers = 0;
  let maxPath = 0;
  for (let n = 1; n <= 30; n++) {
    const base = buildLevel(n);
    const level: LevelData = { ...base, target: target(n), cascade: cascade(n) };
    const r = playGame(level, 'greedy', 0, 200);
    cakes += r.cakes;
    moves += r.moves;
    cakesMoves += r.cakesMoves;
    maxCakes = Math.max(maxCakes, r.maxCakesPerMove);
    freeSum += r.freeSum / Math.max(1, r.moves);
    chainTransfers += r.chainTransfers;
    transfers += r.transfers;
    maxPath = Math.max(maxPath, r.maxPath);
    if (r.outcome === 'won') wins++;
  }
  console.log(
    `  ${label}: побед ${wins}/30, тортов/ход ${(cakes / moves).toFixed(2)}, ` +
      `ходов с тортом ${((cakesMoves / moves) * 100).toFixed(0)}%, макс тортов/ход ${maxCakes}, ` +
      `маршрут макс ${maxPath} тарелок, свободно ячеек ${(freeSum / 30).toFixed(2)}/9, цепочки ${((chainTransfers / Math.max(1, transfers)) * 100).toFixed(0)}%`,
  );
}

function phase3(): void {
  console.log('\nФаза 3. Сводка B1 (прогрессия maxChainHops) против V0 (до Этапа B), жадный, уровни 1–30:');
  summarize('V0', (n) => targetFor(n), () => undefined);
  summarize('B1', (n) => targetFor(n), b1Cascade);
  console.log('\nПримечание: bestMove в B1 оценивает ходы правилами уровня (state.cascade).');
  console.log('В аудите H2 жадный оценивал ходы по V0, а играл по H2 — отсюда 21/30 побед.');
}

phase1();
phase2();
phase3();
