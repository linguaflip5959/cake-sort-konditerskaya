/**
 * Cake Sort — «Кондитерская»: сравнительный симулятор механик
 * «H2 + Same Flavor Transit» (nextStep §4–5) + дополнения:
 *   • 4-я конфигурация «H2 + SFT + Direct Transfer Priority OFF»
 *     (nextStep, дополнение к эксперименту H2 + Same Flavor Transit);
 *   • матрица «Приоритет новой тарелки как получателя переноса»
 *     (ТЗ-дополнение §3: H2 / H2+NPP × без SFT / с SFT).
 *
 * ЗАПУСК: npx tsx scripts/experiment-h2-sft.ts --run [опции]
 * Без флага --run скрипт печатает план запуска и НЕ стартует симуляции —
 * по регламенту работы: «сначала реализация и тесты, затем симуляции».
 *
 * Сравниваются ШЕСТЬ вариантов на одинаковых уровнях, размерах поля
 * и сидах (nextStep §4.4: «одинаковые seed и одинаковые начальные условия»):
 *
 *   Unlimited     — исходная механика без ограничения дальности цепочек;
 *   H2            — два прыжка (донор → один транзит → получатель);
 *   H2+SFT        — H2 плюс правило вкуса транзита (§2.3);
 *   H2+SFT+NoDP   — H2 + SFT + приоритет прямых переносов выключен
 *                   (4-я конфигурация: цепи не вытесняются прямыми);
 *   H2+NPP        — H2 + приоритет новой тарелки как получателя
 *                   (ТЗ-дополнение §1);
 *   H2+SFT+NPP    — H2 + SFT + приоритет новой тарелки (совместная
 *                   проверка правил, ТЗ-дополнение §2).
 *
 * Два сравнения из ТЗ строятся из этих шести вариантов:
 *   Сравнение A (nextStep, дополнение): Unlimited, H2, H2+SFT, H2+SFT+NoDP;
 *   Сравнение B (ТЗ-дополнение §3):     H2, H2+NPP, H2+SFT, H2+SFT+NPP.
 *
 * Симулятор использует НАСТОЯЩУЮ игровую логику проекта (game/rules.ts,
 * game/generator.ts) — отдельной реализации правил нет (nextStep §4).
 * Конфиг варианта передаётся в level.cascade → state.cascade, поэтому
 * подсказка bestMove и разрешение хода оценивают ходы РОВНО правилами
 * варианта, за который играет партия (nextStep §4.3).
 *
 * Размеры поля: 3×3, 3×4, 4×4, 4×5 — через buildLevelSized (§4.1).
 * Стратегии: random / immediate / space / combined (§4.3).
 *
 * Определения метрик (§4.4):
 *  - победы/поражения: по evalEnd (очки ≥ цели / стол забит);
 *  - продолжительность партии: число ходов и фактические мс;
 *  - торты за ход, доля ходов со сборкой, ходы без сборки;
 *  - свободные ячейки: среднее после хода и минимум за партию;
 *  - цепные переносы: доля среди переносов, средняя и максимальная длина
 *    маршрута (число тарелок в path, только для цепочек path.length > 2);
 *  - заблокированные маршруты (на успокоившемся поле, разложение по
 *    причинам): старт (ячейка, вкус) считается заблокированным, если
 *    цепочка для него существует в Unlimited, но недоступна в активной
 *    конфигурации; blockedHops — закрыта лимитом прыжков, blockedSFT —
 *    правилом вкуса транзита. Считается через planChainFrom (реальные
 *    правила), проверка существования — lastPlaced = null (на выбор
 *    получателя существование маршрута не влияет);
 *  - влияние выбора ячейки (сэмплируется каждый impactEvery-й ход):
 *    для всех допустимых размещений на текущем поле моделируется ход
 *    (реальные правила), берутся немедленно набранные очки; метрики —
 *    разброс max−min и σ по размещениям. Чем больше, тем сильнее выбор
 *    ячейки меняет немедленный результат хода.
 */

import {
  applyTrayMove,
  bestMove,
  cloneState,
  createInitialState,
  evalEnd,
  freeCells,
  legalMoves,
  planChainFrom,
  resolveTurnLogged,
  type Move,
} from '../src/puzzle/game/rules';
import { buildLevelSized, topUpTray } from '../src/puzzle/game/generator';
import {
  cloneTrayItem,
  DEFAULT_CASCADE_CONFIG,
  type CascadeConfig,
  type Flavor,
  type GPlate,
  type GState,
  type LevelData,
  type TurnEvent,
} from '../src/puzzle/game/types';
import { writeFileSync } from 'node:fs';

/* ==================================================================== */
/* 1. Варианты механики, размеры поля, стратегии (nextStep §4.1–4.3)     */
/* ==================================================================== */

export interface MechanicVariant {
  /** короткое имя для таблиц и CLI */
  name: string;
  /** человеческое описание */
  title: string;
  /** переопределение над DEFAULT_CASCADE_CONFIG */
  cascade: Partial<CascadeConfig>;
}

/** Шесть сравниваемых вариантов. Первые три — без изменений (регламент
 *  дополнения к эксперименту: «не изменять существующие правила H2»);
 *  четвёртый и два NPP-варианта — экспериментальные, В ОСНОВНУЮ
 *  конфигурацию не входят (ТЗ-дополнение §3, §6). Действующий H2 игры
 *  не меняется: DEFAULT_CASCADE_CONFIG.sameFlavorTransit = false,
 *  newPlatePriority = false. */
export const VARIANTS: MechanicVariant[] = [
  {
    name: 'Unlimited',
    title: 'без ограничения дальности (механика до Этапа B)',
    cascade: { maxChainHops: Infinity, sameFlavorTransit: false },
  },
  {
    name: 'H2',
    title: 'два прыжка: донор → один транзит → получатель',
    cascade: { maxChainHops: 2, sameFlavorTransit: false },
  },
  {
    name: 'H2+SFT',
    title: 'H2 + транзит только для вкуса, уже лежащего на транзитной тарелке',
    cascade: { maxChainHops: 2, sameFlavorTransit: true },
  },
  {
    name: 'H2+SFT+NoDP',
    title: 'H2 + SFT + приоритет прямых переносов выключен (4-я конфигурация)',
    cascade: { maxChainHops: 2, sameFlavorTransit: true, directTransferPriority: false },
  },
  {
    name: 'H2+NPP',
    title: 'H2 + приоритет новой тарелки как получателя переноса',
    cascade: { maxChainHops: 2, sameFlavorTransit: false, newPlatePriority: true },
  },
  {
    name: 'H2+SFT+NPP',
    title: 'H2 + SFT + приоритет новой тарелки (совместная проверка правил)',
    cascade: { maxChainHops: 2, sameFlavorTransit: true, newPlatePriority: true },
  },
];

/** Сравнение A (nextStep, дополнение к эксперименту): все четыре варианта */
export const COMPARISON_A: string[] = ['Unlimited', 'H2', 'H2+SFT', 'H2+SFT+NoDP'];
/** Сравнение B (ТЗ-дополнение §3): матрица приоритета новой тарелки */
export const COMPARISON_B: string[] = ['H2', 'H2+NPP', 'H2+SFT', 'H2+SFT+NPP'];

export interface BoardSize {
  rows: number;
  cols: number;
}

/** Размеры поля для сравнения (nextStep §4.1) */
export const BOARD_SIZES: BoardSize[] = [
  { rows: 3, cols: 3 },
  { rows: 3, cols: 4 },
  { rows: 4, cols: 4 },
  { rows: 4, cols: 5 },
];

export const sizeLabel = (s: BoardSize): string => `${s.rows}×${s.cols}`;

export type StrategyName = 'random' | 'immediate' | 'space' | 'combined';

/** Стратегии автоматического игрока (nextStep §4.3) */
export const STRATEGIES: Array<{ name: StrategyName; title: string }> = [
  { name: 'random', title: 'случайный допустимый ход' },
  { name: 'immediate', title: 'максимум немедленно набранных очков' },
  { name: 'space', title: 'сохранение свободных ячеек' },
  { name: 'combined', title: 'подсказка игры (bestMove): очки + здоровье поля' },
];

/* --------------------------- ГСЧ (как в проекте) --------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Базовые сиды стратегий: одинаковый список для всех вариантов (§4.4) */
export const SEED_BASE = 1000;
export const SEED_STEP = 7919;
export const seedAt = (i: number): number => SEED_BASE + i * SEED_STEP;

/* ==================================================================== */
/* 2. Стратегии (оценивают ходы реальными правилами варианта)            */
/* ==================================================================== */

/** Немедленный результат хода: очки и собранные торты */
function simulateMove(st: GState, mv: Move): { points: number; cakes: number; after: GState } {
  const next = cloneState(st);
  applyTrayMove(next, mv);
  const log = resolveTurnLogged(next, mv.cells);
  let cakes = 0;
  for (const ev of log) if (ev.kind === 'cake') cakes++;
  return { points: next.points - st.points, cakes, after: next };
}

/** Детерминированный выбор: первый ход с максимальной оценкой */
function pickBest(st: GState, score: (sim: { points: number; cakes: number; after: GState }) => number): Move | null {
  let best: Move | null = null;
  let bestScore = -Infinity;
  for (const mv of legalMoves(st)) {
    const s = score(simulateMove(st, mv));
    if (s > bestScore) {
      bestScore = s;
      best = mv;
    }
  }
  return best;
}

export function makeStrategy(name: StrategyName, rngSeed: number): (st: GState) => Move | null {
  switch (name) {
    case 'random': {
      const rng = mulberry32(rngSeed);
      return (st) => {
        const moves = legalMoves(st);
        return moves.length === 0 ? null : moves[Math.floor(rng() * moves.length)];
      };
    }
    // Immediate Gain: немедленная выгода — очки этого хода; равные — первый по порядку
    case 'immediate':
      return (st) => pickBest(st, (sim) => sim.points * 1000 + sim.cakes);
    // Preserve Space: свободные ячейки после хода; равные — очки, затем порядок
    case 'space':
      return (st) => pickBest(st, (sim) => freeCells(sim.after).length * 1000 + sim.points * 10 + sim.cakes);
    // Combined: подсказка игры; bestMove оценивает ходы по st.cascade варианта
    case 'combined':
      return (st) => bestMove(st);
  }
}

/* ==================================================================== */
/* 3. Заблокированные маршруты (разложение по причинам)                  */
/* ==================================================================== */

/** Различные вкусы тарелки по возрастанию (перечисление, не правило) */
function distinctFlavorsOf(p: GPlate): Flavor[] {
  const out: Flavor[] = [];
  for (const s of p.slices) if (!out.includes(s.flavor)) out.push(s.flavor);
  return out.sort((x, y) => x - y);
}

/**
 * Разложение заблокированных маршрутов на успокоившемся поле.
 * Старт (cell, flavor) заблокирован, если цепочка существует в Unlimited
 * (planChainFrom, maxHops = ∞, без SFT), но недоступна в активной
 * конфигурации: blockedHops — из-за лимита прыжков, blockedSFT — из-за
 * правила вкуса транзита (только для варианта с SFT). Для Unlimited
 * оба счётчика равны 0 по построению. Существование маршрута не зависит
 * от lastPlaced (он влияет лишь на выбор получателя) — передаётся null.
 */
export function countBlockedRoutes(st: GState): { blockedHops: number; blockedSFT: number } {
  const cfg = st.cascade ?? DEFAULT_CASCADE_CONFIG;
  let blockedHops = 0;
  let blockedSFT = 0;
  for (let cell = 0; cell < st.board.length; cell++) {
    const p = st.board[cell];
    if (!p) continue;
    for (const f of distinctFlavorsOf(p)) {
      if (planChainFrom(st, cell, f, null, Infinity, false) === null) continue;
      if (planChainFrom(st, cell, f, null, cfg.maxChainHops, false) === null) {
        blockedHops++;
        continue; // причина — лимит прыжков; вкус уже не при чём
      }
      if (cfg.sameFlavorTransit && planChainFrom(st, cell, f, null, cfg.maxChainHops, true) === null) {
        blockedSFT++;
      }
    }
  }
  return { blockedHops, blockedSFT };
}

/* ==================================================================== */
/* 4. Влияние выбора ячейки (сэмплирование, nextStep §4.4)               */
/* ==================================================================== */

/**
 * Разброс немедленной выгоды по всем допустимым размещениям текущего
 * поля: каждое размещение моделируется реальными правилами (клон
 * состояния → applyTrayMove → resolveTurnLogged), собираются очки хода.
 * spread = max−min, std = σ. Все размещения равнозначны → 0.
 */
export function measureChoiceImpact(st: GState): { spread: number; std: number; samples: number } {
  const moves = legalMoves(st);
  if (moves.length === 0) return { spread: 0, std: 0, samples: 0 };
  const gains: number[] = [];
  for (const mv of moves) {
    const next = cloneState(st);
    applyTrayMove(next, mv);
    resolveTurnLogged(next, mv.cells);
    gains.push(next.points - st.points);
  }
  const mean = gains.reduce((a, b) => a + b, 0) / gains.length;
  const variance = gains.reduce((acc, g) => acc + (g - mean) * (g - mean), 0) / gains.length;
  return { spread: Math.max(...gains) - Math.min(...gains), std: Math.sqrt(variance), samples: gains.length };
}

/* ==================================================================== */
/* 5. Уровень эксперимента и партия                                      */
/* ==================================================================== */

/**
 * Уровень эксперимента: базовый уровень n на поле rows×cols с конфигом
 * варианта. Материал (поток, начальные тарелки, цель) не зависит от
 * варианта — различается только конфигурация цепной реакции (§4.4:
 * одинаковые начальные условия для всех вариантов).
 */
export function buildExperimentLevel(n: number, size: BoardSize, variant: MechanicVariant): LevelData {
  const base = buildLevelSized(n, size.rows, size.cols);
  return {
    ...base,
    cascade: {
      ...base.cascade,
      maxChainHops: variant.cascade.maxChainHops ?? DEFAULT_CASCADE_CONFIG.maxChainHops,
      sameFlavorTransit: variant.cascade.sameFlavorTransit ?? DEFAULT_CASCADE_CONFIG.sameFlavorTransit,
      directTransferPriority: variant.cascade.directTransferPriority ?? DEFAULT_CASCADE_CONFIG.directTransferPriority,
      newPlatePriority: variant.cascade.newPlatePriority ?? DEFAULT_CASCADE_CONFIG.newPlatePriority,
    },
  };
}

/**
 * Независимая копия уровня. topUpTray увеличивает stream.next прямо в
 * LevelData, поэтому партия обязана играть на собственной копии уровня —
 * иначе повторные партии на одном и том же уровне (повторы, сиды,
 * стратегии) получали бы сдвинутую выдачу, и детерминизм ломался бы.
 */
function cloneLevel(level: LevelData): LevelData {
  return {
    ...level,
    initial: level.initial.map((p) => ({ ...p, slices: [...p.slices] })),
    tray: level.tray.map(cloneTrayItem),
    stream: level.stream ? { ...level.stream } : undefined,
    cascade: level.cascade ? { ...level.cascade } : undefined,
  };
}

export interface SimOptions {
  /** защитный лимит ходов партии */
  maxMoves: number;
  /** сэмплировать влияние выбора ячейки каждый N-й ход (0 — выключено) */
  impactEvery: number;
}

export interface TurnRecord {
  transfers: number;
  chainTransfers: number;
  /** сумма длин маршрутов цепочек (для средней длины) */
  chainPathSum: number;
  /** максимальная длина маршрута за ход (тарелок в path) */
  maxPath: number;
  /** переносов, где получатель — тарелка, размещённая в этом ходу (ТЗ-дополнение §5) */
  toNewPlate: number;
  /** переносов, где донор — тарелка, размещённая в этом ходу */
  fromNewPlate: number;
  /** разрешение хода оборвано защитным лимитом (осцилляция при NPP — см. тест 13.11) */
  aborted: boolean;
  cakes: number;
  freeAfter: number;
  /** допустимых размещений было в начале хода */
  legalPlacements: number;
  blockedHops: number;
  blockedSFT: number;
  impact?: { spread: number; std: number; samples: number };
}

export interface GameResult {
  variant: string;
  rows: number;
  cols: number;
  strategy: StrategyName;
  levelN: number;
  seed: number;
  outcome: 'won' | 'lost' | 'cap' | 'nomove';
  /** причина поражения (full/leftover) */
  reason: string | null;
  moves: number;
  points: number;
  target: number;
  cakes: number;
  ms: number;
  turns: TurnRecord[];
}

/** Ходы равны? (защита: стратегия обязана играть только допустимыми ходами) */
function sameMove(a: Move, b: Move): boolean {
  return a.trayIdx === b.trayIdx && a.orientation === b.orientation && a.cells.length === b.cells.length && a.cells.every((c, i) => c === b.cells[i]);
}

/**
 * Одна партия: та же петля, что у движка и tune-targets — evalEnd →
 * выбор хода → applyTrayMove → resolveTurnLogged (правила варианта из
 * state.cascade) → topUpTray. Сборка статистики хода — из журнала.
 * levelN — номер уровня для отчёта (в LevelData он не хранится).
 * Уровень копируется: вызовы с одним и тем же LevelData независимы.
 */
export function simulateGame(
  level: LevelData,
  variantName: string,
  strategyName: StrategyName,
  rngSeed: number,
  opts: SimOptions,
  levelN = 0,
): GameResult {
  const t0 = Date.now();
  const owned = cloneLevel(level);
  const st = createInitialState(owned);
  const choose = makeStrategy(strategyName, rngSeed);
  const turns: TurnRecord[] = [];
  let outcome: GameResult['outcome'] = 'cap';
  let reason: string | null = null;
  let cakes = 0;

  for (let moveNo = 0; moveNo < opts.maxMoves; moveNo++) {
    const end = evalEnd(st);
    if (end.phase === 'won') {
      outcome = 'won';
      break;
    }
    if (end.phase === 'lost') {
      outcome = 'lost';
      reason = end.reason;
      break;
    }
    const legal = legalMoves(st);
    const mv = choose(st);
    if (!mv) {
      outcome = 'nomove';
      break;
    }
    const legalMv = legal.find((m) => sameMove(m, mv));
    if (!legalMv) throw new Error(`стратегия ${strategyName} выбрала недопустимый ход`);

    applyTrayMove(st, mv);
    const log: TurnEvent[] = resolveTurnLogged(st, mv.cells);
    let transfers = 0;
    let chainTransfers = 0;
    let chainPathSum = 0;
    let maxPath = 0;
    let toNewPlate = 0;
    let fromNewPlate = 0;
    let aborted = false;
    let turnCakes = 0;
    for (const ev of log) {
      if (ev.kind === 'transfer') {
        transfers++;
        if (mv.cells.includes(ev.transfer.to)) toNewPlate++;
        if (mv.cells.includes(ev.transfer.from)) fromNewPlate++;
        if (ev.transfer.path.length > 2) {
          chainTransfers++;
          chainPathSum += ev.transfer.path.length;
        }
        maxPath = Math.max(maxPath, ev.transfer.path.length);
      } else if (ev.kind === 'cake') {
        turnCakes++;
        cakes++;
      } else if (ev.kind === 'aborted') {
        aborted = true;
      }
    }
    const blocked = countBlockedRoutes(st);
    const rec: TurnRecord = {
      transfers,
      chainTransfers,
      chainPathSum,
      maxPath,
      toNewPlate,
      fromNewPlate,
      aborted,
      cakes: turnCakes,
      freeAfter: freeCells(st).length,
      legalPlacements: legal.length,
      blockedHops: blocked.blockedHops,
      blockedSFT: blocked.blockedSFT,
    };
    if (opts.impactEvery > 0 && (moveNo + 1) % opts.impactEvery === 0) {
      rec.impact = measureChoiceImpact(st);
    }
    turns.push(rec);
    topUpTray(owned, st);
  }

  return {
    variant: variantName,
    rows: level.rows,
    cols: level.cols,
    strategy: strategyName,
    levelN,
    seed: rngSeed,
    outcome,
    reason,
    moves: turns.length,
    points: st.points,
    target: st.target,
    cakes,
    ms: Date.now() - t0,
    turns,
  };
}

/* ==================================================================== */
/* 6. Агрегация (nextStep §4.4) и сводная таблица (§5)                   */
/* ==================================================================== */

export interface AggregateRow {
  variant: string;
  rows: number;
  cols: number;
  strategy: StrategyName;
  games: number;
  wins: number;
  losses: number;
  caps: number;
  winRate: number;
  lossReasons: Record<string, number>;
  avgMoves: number;
  maxMovesSeen: number;
  avgGameMs: number;
  totalCakes: number;
  cakesPerMove: number;
  /** доля ходов с ≥1 собранным тортом */
  turnWithCakeShare: number;
  /** доля ходов без сборки */
  turnNoCakeShare: number;
  avgFree: number;
  minFree: number;
  cells: number;
  transfers: number;
  chainTransfers: number;
  chainShare: number;
  /** средняя длина маршрута цепочек (тарелок), только цепочки */
  avgChainLen: number;
  maxChainLen: number;
  avgLegalPlacements: number;
  blockedHopsPerTurn: number;
  blockedSFTPerTurn: number;
  avgPoints: number;
  /** всего ходов в группе (для абсолютных количеств из долей) */
  turnsTotal: number;
  /** ходов без сборки торта — количество (nextStep, дополнение: «количество ходов без сборки») */
  noCakeTurns: number;
  /** переносов с получателем — новой тарелкой — количество (ТЗ-дополнение §5) */
  toNewPlate: number;
  /** переносов с донором — новой тарелкой — количество */
  fromNewPlate: number;
  /** доля переносов в новую тарелку среди всех переносов */
  newPlateShare: number;
  /** ходов, оборванных защитным лимитом разрешения (осцилляция NPP) */
  abortedTurns: number;
  impactSpread: number;
  impactStd: number;
  impactSamples: number;
}

const groupKey = (r: GameResult): string => `${r.variant}|${r.rows}×${r.cols}|${r.strategy}`;

export function aggregate(results: GameResult[]): AggregateRow[] {
  const groups = new Map<string, GameResult[]>();
  for (const r of results) {
    const k = groupKey(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  const out: AggregateRow[] = [];
  for (const games of groups.values()) {
    const turns = games.flatMap((g) => g.turns);
    const nTurns = turns.length || 1;
    const impacts = turns.filter((t) => t.impact !== undefined);
    const chainPaths = turns.filter((t) => t.chainPathSum > 0);
    const chainLenWeighted = chainPaths.reduce((a, t) => a + t.chainPathSum, 0);
    const chainCount = turns.reduce((a, t) => a + t.chainTransfers, 0);
    const transfers = turns.reduce((a, t) => a + t.transfers, 0);
    const g0 = games[0];
    const lossReasons: Record<string, number> = {};
    for (const g of games) if (g.outcome === 'lost' && g.reason) lossReasons[g.reason] = (lossReasons[g.reason] ?? 0) + 1;
    out.push({
      variant: g0.variant,
      rows: g0.rows,
      cols: g0.cols,
      strategy: g0.strategy,
      games: games.length,
      wins: games.filter((g) => g.outcome === 'won').length,
      losses: games.filter((g) => g.outcome === 'lost').length,
      caps: games.filter((g) => g.outcome === 'cap').length,
      winRate: games.filter((g) => g.outcome === 'won').length / games.length,
      lossReasons,
      avgMoves: games.reduce((a, g) => a + g.moves, 0) / games.length,
      maxMovesSeen: games.reduce((m, g) => Math.max(m, g.moves), 0),
      avgGameMs: games.reduce((a, g) => a + g.ms, 0) / games.length,
      totalCakes: games.reduce((a, g) => a + g.cakes, 0),
      cakesPerMove: games.reduce((a, g) => a + g.cakes, 0) / nTurns,
      turnWithCakeShare: turns.filter((t) => t.cakes > 0).length / nTurns,
      turnNoCakeShare: turns.filter((t) => t.cakes === 0).length / nTurns,
      avgFree: turns.reduce((a, t) => a + t.freeAfter, 0) / nTurns,
      minFree: turns.reduce((m, t) => Math.min(m, t.freeAfter), Infinity),
      cells: g0.rows * g0.cols,
      transfers,
      chainTransfers: chainCount,
      chainShare: transfers > 0 ? chainCount / transfers : 0,
      avgChainLen: chainCount > 0 ? chainLenWeighted / chainCount : 0,
      maxChainLen: turns.reduce((m, t) => Math.max(m, t.maxPath), 0),
      avgLegalPlacements: turns.reduce((a, t) => a + t.legalPlacements, 0) / nTurns,
      blockedHopsPerTurn: turns.reduce((a, t) => a + t.blockedHops, 0) / nTurns,
      blockedSFTPerTurn: turns.reduce((a, t) => a + t.blockedSFT, 0) / nTurns,
      avgPoints: games.reduce((a, g) => a + g.points, 0) / games.length,
      turnsTotal: turns.length,
      noCakeTurns: turns.filter((t) => t.cakes === 0).length,
      toNewPlate: turns.reduce((a, t) => a + t.toNewPlate, 0),
      fromNewPlate: turns.reduce((a, t) => a + t.fromNewPlate, 0),
      newPlateShare: transfers > 0 ? turns.reduce((a, t) => a + t.toNewPlate, 0) / transfers : 0,
      abortedTurns: turns.filter((t) => t.aborted).length,
      impactSpread: impacts.length > 0 ? impacts.reduce((a, t) => a + (t.impact?.spread ?? 0), 0) / impacts.length : 0,
      impactStd: impacts.length > 0 ? impacts.reduce((a, t) => a + (t.impact?.std ?? 0), 0) / impacts.length : 0,
      impactSamples: impacts.reduce((a, t) => a + (t.impact?.samples ?? 0), 0),
    });
  }
  return out;
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const num = (x: number, d = 2): string => x.toFixed(d);

/** Сводная таблица §5: метрики (строки) × варианты (столбцы).
 *  names — список вариантов сравнения (A: дополнение к эксперименту;
 *  B: ТЗ-дополнение §3); строка возвращается только при наличии данных
 *  по всем вариантам списка. */
export function summaryTable(rows: AggregateRow[], size: BoardSize, strategy: StrategyName, names: readonly string[]): string {
  const cells = size.rows * size.cols;
  const byName = new Map(rows.filter((r) => r.rows === size.rows && r.cols === size.cols && r.strategy === strategy).map((r) => [r.variant, r]));
  const cols = names.map((n) => byName.get(n));
  if (cols.some((c) => !c)) return '';
  const a = cols[0]!;
  const head = names.map((n) => n.padStart(13)).join(' | ');
  const line = (label: string, f: (x: AggregateRow) => string): string =>
    `  ${label.padEnd(34)} | ${cols.map((c) => f(c!).padStart(13)).join(' | ')}`;
  const games = a.games;
  return [
    `Поле ${sizeLabel(size)}, стратегия ${strategy} (${games} партий = уровни × сиды)`,
    `  ${''.padEnd(34)} | ${head}`,
    line('Победы, %', (r) => pct(r.winRate)),
    line('Поражения (full/leftover/cap)', (r) => `${r.losses}/${r.lossReasons['full'] ?? 0}/${r.caps}`),
    line('Ходов в партии (средн.)', (r) => num(r.avgMoves, 1)),
    line('Тортов собрано (всего)', (r) => String(r.totalCakes)),
    line('Тортов за ход', (r) => num(r.cakesPerMove)),
    line('Ходов со сборкой торта, %', (r) => pct(r.turnWithCakeShare)),
    line('Ходов без сборки — количество', (r) => String(r.noCakeTurns)),
    line(`Свободных ячеек (средн. из ${cells})`, (r) => `${num(r.avgFree)} (мин ${r.minFree})`),
    line('Переносов (всего)', (r) => String(r.transfers)),
    line('Цепных переносов — количество', (r) => String(r.chainTransfers)),
    line('Доля цепных переносов, %', (r) => pct(r.chainShare)),
    line('Средняя длина цепочки', (r) => num(r.avgChainLen)),
    line('Максимальная длина цепочки', (r) => String(r.maxChainLen)),
    line('Переносов в новую тарелку — кол-во', (r) => String(r.toNewPlate)),
    line('Доля переносов в новую тарелку, %', (r) => pct(r.newPlateShare)),
    line('Ходов с абортом разрешения', (r) => String(r.abortedTurns)),
    line('Блокировки маршрутов за ход', (r) => `${num(r.blockedHopsPerTurn)}+${num(r.blockedSFTPerTurn)}=${num(r.blockedHopsPerTurn + r.blockedSFTPerTurn)}`),
    line('Влияние выбора ячейки (σ очков)', (r) => `${num(r.impactStd)} (разброс ${num(r.impactSpread, 1)})`),
    '',
  ].join('\n');
}

/* ==================================================================== */
/* 7. CLI                                                                */
/* ==================================================================== */

interface CliOptions {
  run: boolean;
  levels: number;
  seeds: number;
  sizes: BoardSize[];
  strategies: StrategyName[];
  maxMoves: number;
  impactEvery: number;
  out?: string;
}

function parseSizes(spec: string): BoardSize[] {
  const out: BoardSize[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)['×xX'](\d+)$/);
    if (!m) throw new Error(`не удалось разобрать размер поля: «${part}» (ожидается вида 3x3)`);
    out.push({ rows: Number(m[1]), cols: Number(m[2]) });
  }
  return out;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    run: false,
    levels: 12,
    seeds: 10,
    sizes: BOARD_SIZES,
    strategies: STRATEGIES.map((s) => s.name),
    maxMoves: 200,
    impactEvery: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      i++;
      if (i >= argv.length) throw new Error(`${arg}: не указано значение`);
      return argv[i];
    };
    switch (arg) {
      case '--run':
        opts.run = true;
        break;
      case '--levels':
        opts.levels = Math.max(1, Number(next()));
        break;
      case '--seeds':
        opts.seeds = Math.max(1, Number(next()));
        break;
      case '--sizes':
        opts.sizes = parseSizes(next());
        break;
      case '--strategies':
        opts.strategies = next()
          .split(',')
          .map((s) => s.trim() as StrategyName);
        for (const s of opts.strategies) {
          if (!STRATEGIES.some((known) => known.name === s)) {
            throw new Error(`неизвестная стратегия: «${s}» (доступны: ${STRATEGIES.map((x) => x.name).join(', ')})`);
          }
        }
        break;
      case '--max-moves':
        opts.maxMoves = Math.max(1, Number(next()));
        break;
      case '--impact-every':
        opts.impactEvery = Math.max(0, Number(next()));
        break;
      case '--out':
        opts.out = next();
        break;
      default:
        throw new Error(`неизвестный аргумент: ${arg}`);
    }
  }
  return opts;
}

function totalGames(opts: CliOptions): number {
  return VARIANTS.length * opts.sizes.length * opts.strategies.length * opts.levels * opts.seeds;
}

/** План запуска — печатается и БЕЗ флага --run */
function printPlan(opts: CliOptions): void {
  const combos = VARIANTS.length * opts.sizes.length * opts.strategies.length;
  console.log('План сравнительного эксперимента (nextStep §4–5):');
  console.log(`  Варианты:    ${VARIANTS.map((v) => v.name).join(', ')}`);
  console.log(`  Размеры:     ${opts.sizes.map(sizeLabel).join(', ')}`);
  console.log(`  Стратегии:   ${opts.strategies.join(', ')}`);
  console.log(`  Уровни:      1..${opts.levels} (buildLevelSized, материал одинаков у вариантов)`);
  console.log(`  Сиды:        ${opts.seeds} на комбинацию (${seedAt(0)} + i·${SEED_STEP})`);
  console.log(`  Лимит ходов: ${opts.maxMoves}; влияние выбора ячейки — каждый ${opts.impactEvery || '—'}-й ход`);
  console.log(`  Комбинаций:  ${combos}, партий всего: ${totalGames(opts)}`);
  console.log('\nСтатус: симуляции НЕ стартуют без флага --run.');
  console.log('Регламент: сначала реализация и тесты → подтверждение корректности → симуляции.');
  console.log('Запуск:    npx tsx scripts/experiment-h2-sft.ts --run');
}

function runExperiment(opts: CliOptions): AggregateRow[] {
  console.log(`Старт: ${totalGames(opts)} партий (${VARIANTS.length} варианта × ${opts.sizes.length} размеров × ${opts.strategies.length} стратегий × ${opts.levels} уровней × ${opts.seeds} сидов)\n`);
  const results: GameResult[] = [];
  const t0 = Date.now();
  for (const variant of VARIANTS) {
    for (const size of opts.sizes) {
      for (const strategy of opts.strategies) {
        const games: GameResult[] = [];
        for (let n = 1; n <= opts.levels; n++) {
          const level = buildExperimentLevel(n, size, variant);
          for (let s = 0; s < opts.seeds; s++) {
            games.push(simulateGame(level, variant.name, strategy, seedAt(s), { maxMoves: opts.maxMoves, impactEvery: opts.impactEvery }, n));
          }
        }
        results.push(...games);
        const won = games.filter((g) => g.outcome === 'won').length;
        const lost = games.filter((g) => g.outcome === 'lost').length;
        process.stdout.write(
          `  ${variant.name.padEnd(9)} ${sizeLabel(size).padEnd(4)} ${strategy.padEnd(9)} ` +
            `партий ${games.length}: побед ${won}, поражений ${lost}, ходов ср. ${num(games.reduce((a, g) => a + g.moves, 0) / games.length, 1)} ` +
            `[${((Date.now() - t0) / 1000).toFixed(0)} с]\n`,
        );
      }
    }
  }
  return aggregate(results);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.run) {
    printPlan(opts);
    return;
  }
  const rows = runExperiment(opts);

  console.log('\n=== Сводные таблицы (nextStep §5 + дополнения) ===\n');
  for (const size of opts.sizes) {
    for (const strategy of opts.strategies) {
      const tableA = summaryTable(rows, size, strategy, COMPARISON_A);
      if (tableA) console.log(`— Сравнение A (H2 + SFT, 4 конфигурации):\n${tableA}`);
      const tableB = summaryTable(rows, size, strategy, COMPARISON_B);
      if (tableB) console.log(`— Сравнение B (приоритет новой тарелки, ТЗ-дополнение §3):\n${tableB}`);
    }
  }

  console.log('Примечания:');
  console.log(' - Блокировки маршрутов за ход: прыжки+вкус (разложение причин; Unlimited — всегда 0+0).');
  console.log(' - Влияние выбора ячейки — σ немедленных очков по всем допустимым размещениям (сэмплирование).');
  console.log(' - Переносы в новую тарелку считаются по получателю: ячейка, размещённая в текущем ходу.');
  console.log(' - Уменьшение собранных тортов само по себе не является улучшением: важен баланс');
  console.log('   сложности, управляемости и продолжительности партии (nextStep §5, §10).');
  console.log(' - Победившая механика НЕ выбирается автоматически; правила игры не меняются');
  console.log('   по результатам симуляций без отдельного согласования (nextStep, дополнение; ТЗ-дополнение §6).\n');

  if (opts.out) {
    const payload = {
      options: {
        levels: opts.levels,
        seeds: opts.seeds,
        sizes: opts.sizes.map(sizeLabel),
        strategies: opts.strategies,
        maxMoves: opts.maxMoves,
        impactEvery: opts.impactEvery,
        variants: VARIANTS.map((v) => ({ name: v.name, title: v.title, cascade: { ...v.cascade, maxChainHops: v.cascade.maxChainHops === Infinity ? '∞' : v.cascade.maxChainHops } })),
        comparisons: { A: COMPARISON_A, B: COMPARISON_B },
      },
      aggregates: rows,
    };
    writeFileSync(opts.out, JSON.stringify(payload, null, 2));
    console.log(`Агрегаты записаны: ${opts.out}`);
  }
}

/* Прямой запуск — только при вызове именно этого файла (тесты импортируют
 * модуль и не должны запускать симуляции). Без --run — только план. */
const invoked = process.argv[1] !== undefined && /experiment-h2-sft\.ts$/.test(process.argv[1]);
if (invoked) main();
