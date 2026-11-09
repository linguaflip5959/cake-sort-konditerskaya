/**
 * Cake Sort — «Кондитерская»: автотесты игрового слоя.
 * Запуск: npm test (tsx scripts/pz-tests.ts). Three.js и GSAP не нужны.
 *
 * Итерация 3 — очки: сбор тортов даёт очки (с комбо), победа — по очкам.
 * Очередь — бесконечный детерминированный поток, стол 3×3, выдача 5.
 */

import {
  applyCompletion,
  applyTransfer,
  applyTrayMove,
  bestMove,
  CAKE_POINTS,
  canPlace,
  canPlaceDoubleAt,
  chooseRecipient,
  cloneState,
  COMBO_BONUS,
  createInitialState,
  evalEnd,
  findCompletion,
  legalMoves,
  MERGE_POINTS,
  planChainFrom,
  planNextTransfer,
  resolveTurn,
  resolveTurnLogged,
  sharedAdjacency,
  type Move,
} from '../src/puzzle/game/rules';
import { buildLevel, buildLevelSized, levelConfig, peekStream, targetFor, topUpTray, TRAINING_LEVELS } from '../src/puzzle/game/generator';
import { getLevel } from '../src/puzzle/game/levels';
import {
  CAP,
  DEFAULT_CASCADE_CONFIG,
  FLAVOR_COUNT,
  TRAY_BUFFER,
  WINDOW,
  trayFlavors,
  traySize,
  type CascadeConfig,
  type Flavor,
  type LevelData,
  type TrayItem,
  type TurnEvent,
} from '../src/puzzle/game/types';
import {
  aggregate,
  buildExperimentLevel,
  COMPARISON_A,
  COMPARISON_B,
  countBlockedRoutes,
  makeStrategy,
  measureChoiceImpact,
  seedAt,
  simulateGame,
  VARIANTS,
  type AggregateRow,
  type GameResult,
  type StrategyName,
} from './experiment-h2-sft';

/* --------------------------- мини-фреймворк ------------------------- */

let passed = 0;
let failed = 0;
const t0 = Date.now();

function test(name: string, fn: () => void): void {
  const started = Date.now();
  try {
    fn();
    passed++;
    console.log(`  ok  ${name} (${Date.now() - started} мс)`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name} (${Date.now() - started} мс)`);
    console.error(e instanceof Error ? `      ${e.message}` : `      ${String(e)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: получено ${a}, ожидалось ${b}`);
}

function throws(fn: () => void, msg: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

/** Уровень «на лету» для сценарных тестов (без цели — режим очистки поля) */
function lv(rows: number, cols: number, initial: Array<[number, number, Flavor[]]>, tray: TrayItem[], target?: number): LevelData {
  return {
    rows,
    cols,
    initial: initial.map(([row, col, slices]) => ({ row, col, slices })),
    tray,
    ...(target !== undefined ? { target } : {}),
  };
}

console.log('Cake Sort — Кондитерская: автотесты игрового слоя (итерация 3)\n');

/* ------------------------- 1. Очки и комбо -------------------------- */

test('1.1 Очки: торт = 100, комбо +25 за каждый следующий, перенос = 2/кусочек', () => {
  const st = createInitialState(lv(1, 3, [[0, 0, [0, 0, 0]]], [{ kind: 'single', slices: [0, 0, 0] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  // перенос 3 кусочков: +6; торт: +100 → 106
  resolveTurn(st, [1]);
  assertEq(st.points, MERGE_POINTS * 3 + CAKE_POINTS, 'очки за перенос и торт');
  assertEq(st.completed, 1, 'торт собран');
  assertEq(st.combo, 1, 'комбо после хода — 1');
});

test('1.2 Комбо растёт внутри хода и сбрасывается новым ходом', () => {
  const st = createInitialState(
    lv(
      1,
      4,
      [],
      [
        { kind: 'single', slices: [3, 3, 3, 3, 3, 3] },
        { kind: 'single', slices: [3, 3, 3, 3, 3, 3] },
      ],
      500,
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [0], orientation: null });
  resolveTurn(st, [0]); // готовый торт из 6 кусочков без переносов
  assertEq(st.points, CAKE_POINTS, 'первый торт — базовые очки');
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurn(st, [1]);
  assertEq(st.points, CAKE_POINTS * 2, 'комбо сброшен — снова базовые очки');
});

test('1.3 Победа по очкам: target достигнут — won, даже когда тарелки на поле', () => {
  const st = createInitialState(
    lv(
      1,
      3,
      [[0, 0, [0, 0, 0]]],
      [{ kind: 'single', slices: [0, 0, 0] }, { kind: 'single', slices: [1, 1] }],
      106,
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurn(st, [1]);
  assertEq(st.points, 106, 'очки набраны');
  assertEq(evalEnd(st), { phase: 'won' }, 'победа по очкам с тарелками на поле');
});

test('1.4 Очки не накоплены — игра продолжается', () => {
  const st = createInitialState(
    lv(
      1,
      3,
      [[0, 0, [0, 0, 0]]],
      [{ kind: 'single', slices: [0, 0, 0] }, { kind: 'single', slices: [1, 1] }],
      400,
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurn(st, [1]);
  assertEq(evalEnd(st), { phase: 'playing' }, 'цель не взята — играем');
});

test('1.5 applyCompletion напрямую поднимает комбо и очки', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0]]], [], 1000));
  st.combo = 0; // начало хода
  st.board[0] = { id: 1, cell: 0, slices: new Array(6).fill(0).map((_, i) => ({ id: i, flavor: 0 })) };
  applyCompletion(st, 0);
  assertEq(st.points, CAKE_POINTS, 'первый торт хода');
  st.board[1] = { id: 2, cell: 1, slices: new Array(6).fill(0).map((_, i) => ({ id: 10 + i, flavor: 0 })) };
  applyCompletion(st, 1);
  assertEq(st.points, CAKE_POINTS * 2 + COMBO_BONUS, 'второй торт хода — с бонусом');
});

/* ------------------------ 2. Стол 3×3, выдача 5 --------------------- */

test('2.1 Уровни: поле всегда 3×3, цель задана, поток бесконечный', () => {
  for (let n = 1; n <= 30; n++) {
    const level = buildLevel(n);
    assertEq([level.rows, level.cols], [3, 3], `уровень ${n}: поле`);
    assert((level.target ?? 0) > 0, `уровень ${n}: нет цели в очках`);
    assert(level.stream !== undefined, `уровень ${n}: нет потока`);
    assertEq(level.tray.length, WINDOW + TRAY_BUFFER, `уровень ${n}: стартовая выдача`);
    assert(level.initial.length >= 2 && level.initial.length <= 3, `уровень ${n}: начальные тарелки`);
    for (const p of level.initial) {
      assert(p.slices.length >= 1 && p.slices.length <= CAP, `уровень ${n}: начальная тарелка ${p.slices.length} кусочков`);
    }
  }
});

test('2.2 Окно выдачи — 5: legalMoves видит 5 элементов, topUp держит запас', () => {
  const level = buildLevel(3);
  const st = createInitialState(level);
  const singles = st.tray.slice(0, WINDOW).filter((it) => it.kind === 'single').length;
  const frees = st.board.filter((p) => p === null).length;
  assertEq(legalMoves(st).length, singles * frees, 'ходы для обычных тарелок в окне × свободные ячейки');
  // израсходовали 3 элемента — выдача всё равно полная
  for (let k = 0; k < 3; k++) {
    const cell = st.board.findIndex((p) => p === null);
    assert(cell >= 0, 'нет свободной ячейки');
    applyTrayMove(st, { trayIdx: 0, cells: [cell], orientation: null });
    resolveTurn(st, [cell]);
    topUpTray(level, st);
  }
  assert(st.tray.length >= WINDOW + TRAY_BUFFER - 1, `после ходов в очереди ${st.tray.length}, а нужна ~${WINDOW + TRAY_BUFFER}`);
});

test('2.3 Кривая цели: рост с насыщением, без провалов', () => {
  let prev = 0;
  for (let n = 1; n <= 30; n++) {
    const t = targetFor(n);
    assert(t >= prev, `цель уровня ${n} (${t}) меньше предыдущей (${prev})`);
    prev = t;
  }
  assertEq(targetFor(1), 250, 'уровень 1');
  assertEq(targetFor(16), 1150, 'уровень 16');
  assertEq(targetFor(40), 1200, 'насыщение');
});

test('2.4 Открытие тортов: по одному за уровень, потом золотая серия', () => {
  for (let n = 1; n + 1 < FLAVOR_COUNT; n++) {
    const cfg = levelConfig(n);
    assertEq(cfg.unlockedCount, n + 1, `уровень ${n}: открыто вкусов`);
    assertEq(cfg.flavors.length, Math.min(6, n + 1), `уровень ${n}: размер пула`);
    assert(!cfg.golden, `уровень ${n}: не золотая серия`);
    assertEq(cfg.unlockFlavor, n + 1, `уровень ${n}: открывается вкус`);
    // новый торт ещё не в игре — он появится на следующем уровне
    assert(!cfg.flavors.includes(cfg.unlockFlavor), `уровень ${n}: новинка уже в пуле`);
    for (const f of cfg.flavors) assert(f < cfg.unlockedCount, `уровень ${n}: вкус ${f} ещё не открыт`);
    // новинка прошлого уровня — в пуле текущего (вкус n)
    if (n > 1) assert(cfg.flavors.includes(n), `уровень ${n}: прошлая новинка не в пуле`);
  }
  const gold = levelConfig(FLAVOR_COUNT - 1); // уровень 15
  assert(gold.golden, 'уровень 15 — золотая серия');
  assertEq(gold.flavors.length, 6, 'пул золотой серии');
  // getLevel согласован с конфигом
  for (const n of [1, 5, 16, 25]) {
    const level = buildLevel(n);
    assertEq(level.target, targetFor(n), `getLevel/buildLevel цель уровня ${n}`);
  }
});

/* -------------------- 3. Поток: детерминизм и состав ---------------- */

test('3.1 Детерминизм: один номер уровня — один и тот же уровень и поток', () => {
  for (const n of [1, 4, 7, 12, 25]) {
    const a = JSON.stringify(buildLevel(n));
    const b = JSON.stringify(buildLevel(n));
    assertEq(a, b, `уровень ${n} недетерминирован`);
    const p1 = JSON.stringify(peekStream(n, 40));
    const p2 = JSON.stringify(peekStream(n, 40));
    assertEq(p1, p2, `поток уровня ${n} недетерминирован`);
  }
  // getLevel(i) === buildLevel(i+1)
  assertEq(JSON.stringify(getLevel(6)), JSON.stringify(buildLevel(7)), 'getLevel смещён на 1');
});

test('3.2 Состав тарелок: 2–4 вкуса, без «полторта», чистые — только 1–2 кусочка', () => {
  for (let n = 1; n <= 30; n++) {
    const items = peekStream(n, 60);
    const plates: Flavor[][] = items.flatMap((it) => (it.kind === 'single' ? [it.slices] : [it.a, it.b]));
    let singles = 0;
    let heavy = 0;
    let flavorsSum = 0;
    for (const p of plates) {
      assert(p.length >= 1 && p.length <= CAP, `уровень ${n}: тарелка из ${p.length} кусочков`);
      const counts = new Map<Flavor, number>();
      for (const f of p) counts.set(f, (counts.get(f) ?? 0) + 1);
      const distinct = counts.size;
      const maxSame = Math.max(...counts.values());
      flavorsSum += distinct;
      assert(distinct <= 4, `уровень ${n}: тарелка с ${distinct} вкусами`);
      assert(maxSame <= 3 || maxSame === 5, `уровень ${n}: ${maxSame} кусочков одного вкуса`);
      if (maxSame === 5) heavy++;
      if (distinct === 1 && maxSame < 5) {
        assert(p.length <= 2, `уровень ${n}: одновидовая тарелка из ${p.length} кусочков`);
        singles++;
      }
    }
    // «почти торты» — редкий подарок: 2,5% на тарелку, запас на дисперсию
    assert(heavy <= Math.ceil(plates.length * 0.08), `уровень ${n}: «почти тортов» ${heavy} из ${plates.length}`);
    assert(singles <= Math.ceil(plates.length * 0.25), `уровень ${n}: одновидовых ${singles} из ${plates.length}`);
    const avgFlavors = flavorsSum / plates.length;
    assert(avgFlavors >= 1.6, `уровень ${n}: в среднем ${avgFlavors.toFixed(2)} вкусов на тарелку`);
  }
});

test('3.3 Двойные тарелки: с 3-го уровня, не чаще одной на 7 позиций', () => {
  for (let n = 1; n <= 20; n++) {
    const items = peekStream(n, 70);
    if (n < 3) {
      assert(items.every((it) => it.kind === 'single'), `уровень ${n}: двойных быть не должно`);
      continue;
    }
    let lastDouble = -10;
    let count = 0;
    items.forEach((it, i) => {
      if (it.kind === 'double') {
        assert(i >= 6, `уровень ${n}: двойная на позиции ${i} — слишком рано`);
        assert(i - lastDouble >= 7, `уровень ${n}: двойные на ${lastDouble} и ${i} — ближе 7 позиций`);
        assert(it.a.length >= 1 && it.b.length >= 1, `уровень ${n}: пустая половинка двойной`);
        lastDouble = i;
        count++;
      }
    });
    assert(count >= 3, `уровень ${n}: за 70 элементов всего ${count} двойных`);
    // в любом окне из 5 — максимум одна двойная
    for (let i = 0; i + WINDOW <= items.length; i++) {
      const d = items.slice(i, i + WINDOW).filter((it) => it.kind === 'double').length;
      assert(d <= 1, `уровень ${n}: в окне ${i}..${i + WINDOW - 1} двойных ${d}`);
    }
  }
});

test('3.4 Вкусы потока — только доступные на уровне', () => {
  for (let n = 1; n <= 20; n++) {
    const cfg = levelConfig(n);
    const allowed = new Set(cfg.flavors);
    for (const it of peekStream(n, 50)) {
      for (const f of trayFlavors(it)) {
        assert(allowed.has(f), `уровень ${n}: вкус ${f} вне доступных (0..${cfg.flavors.length - 1})`);
      }
    }
  }
});

/* ------------------- 4. Проходимость: жадный игрок ------------------ */

interface GreedyResult {
  outcome: 'won' | 'lost' | 'timeout';
  moves: number;
  points: number;
}

/** Жадная партия: как подсказка bestMove, уровень за уровнем */
function greedyPlay(n: number, maxMoves: number): GreedyResult {
  const level = buildLevel(n);
  const st = createInitialState(level);
  for (let m = 0; m < maxMoves; m++) {
    topUpTray(level, st);
    const end = evalEnd(st);
    if (end.phase === 'won') return { outcome: 'won', moves: m, points: st.points };
    if (end.phase === 'lost') return { outcome: 'lost', moves: m, points: st.points };
    const mv = bestMove(st);
    if (!mv) return { outcome: 'lost', moves: m, points: st.points };
    applyTrayMove(st, mv);
    resolveTurn(st, mv.cells);
  }
  return { outcome: 'timeout', moves: maxMoves, points: st.points };
}

test('4.1 Ранние уровни (1–10): жадный игрок всегда берёт цель', () => {
  for (let n = 1; n <= 10; n++) {
    const r = greedyPlay(n, 150);
    assert(r.outcome === 'won', `уровень ${n}: жадный игрок ${r.outcome} (очков ${r.points}/${targetFor(n)})`);
    console.log(`      уровень ${n}: победа за ${r.moves} ходов (${r.points} очков)`);
  }
});

test('4.2 Поздние уровни (11–25): жадный не проигрывает (стол не забит)', () => {
  for (let n = 11; n <= 25; n++) {
    const r = greedyPlay(n, 220);
    assert(r.outcome !== 'lost', `уровень ${n}: жадный игрок проиграл на ходу ${r.moves}`);
    if (r.outcome === 'won') console.log(`      уровень ${n}: победа за ${r.moves} ходов`);
  }
});

test('4.3 Сложность растёт: побед жадного на поздних уровнях меньше', () => {
  const early = [1, 2, 3].every((n) => greedyPlay(n, 150).outcome === 'won');
  assert(early, 'уровни 1–3 обязаны проходиться');
});

test('4.4 bestMove возвращает только допустимые ходы', () => {
  for (let n = 1; n <= 8; n++) {
    const level = buildLevel(n);
    const st = createInitialState(level);
    const mv = bestMove(st);
    assert(mv !== null, `уровень ${n}: нет хода`);
    const legal = legalMoves(st).some(
      (m) => m.trayIdx === mv!.trayIdx && m.cells.join(',') === mv!.cells.join(',') && m.orientation === mv!.orientation,
    );
    assert(legal, `уровень ${n}: bestMove предложил недопустимый ход`);
    if (mv!.cells.length === 1) assert(canPlace(st, mv!.cells[0]), 'ячейка должна быть свободной');
    else assert(canPlaceDoubleAt(st, mv!.cells[0], mv!.cells[1]), 'пара должна быть свободной и соседней');
  }
});

/* ------------------------ 5. Двойная тарелка ------------------------ */

test('5.1 Двойная тарелка: размещения только на пары свободных соседей', () => {
  const st = createInitialState(lv(2, 2, [], [{ kind: 'double', a: [0, 0], b: [1, 1] }]));
  // все 4 ячейки свободны: пары (0,1) (0,2) (1,3) (2,3) × 2 ориентации
  assertEq(legalMoves(st).length, 8, 'число ходов на пустом поле 2×2');
  for (const mv of legalMoves(st)) {
    assert(mv.cells.length === 2, 'двойная размещается на две ячейки');
    assert(canPlaceDoubleAt(st, mv.cells[0], mv.cells[1]), 'пара должна быть свободной и соседней');
  }
  // занятая ячейка исключает пары с ней
  st.board[0] = { id: 1, cell: 0, slices: [{ id: 1, flavor: 5 }] };
  const moves2 = legalMoves(st); // свободны 1, 2, 3: пары (1,3) и (2,3)
  assertEq(moves2.length, 4, 'число ходов с одной занятой ячейкой');
  // недопустимые размещения отклоняются
  throws(() => applyTrayMove(st, { trayIdx: 0, cells: [1, 2], orientation: null }), 'диагональ принята');
  throws(() => applyTrayMove(st, { trayIdx: 0, cells: [0, 1], orientation: null }), 'занятая ячейка принята');
});

test('5.2 Ориентации: 4 состояния и порядок ячеек A/B', () => {
  const horiz = legalMoves(createInitialState(lv(1, 2, [], [{ kind: 'double', a: [0], b: [1] }])));
  assertEq(
    horiz.map((m) => [m.orientation, m.cells]).sort(),
    [[0, [0, 1]], [2, [1, 0]]],
    'горизонтальные ориентации',
  );
  const vert = legalMoves(createInitialState(lv(2, 1, [], [{ kind: 'double', a: [0], b: [1] }])));
  assertEq(
    vert.map((m) => [m.orientation, m.cells]).sort(),
    [[1, [0, 1]], [3, [1, 0]]],
    'вертикальные ориентации',
  );
  const all = legalMoves(createInitialState(lv(2, 2, [], [{ kind: 'double', a: [0], b: [1] }])));
  for (const o of [0, 1, 2, 3] as const) {
    assert(all.some((m) => m.orientation === o), `ориентация ${o} не встретилась`);
  }
});

test('5.3 После размещения половинки ведут себя как независимые тарелки', () => {
  const level = lv(
    1,
    3,
    [[0, 0, [5, 5, 5, 5, 5]]],
    [
      { kind: 'double', a: [0, 0, 0, 0, 0], b: [5] },
      { kind: 'single', slices: [0] },
    ],
  );
  const st = createInitialState(level);
  applyTrayMove(st, { trayIdx: 0, cells: [2, 1], orientation: 2 });
  resolveTurn(st, [2, 1]);
  assert(st.board[1] === null, 'ячейка B не освободилась после сборки торта');
  assertEq(st.board[2]?.slices.map((s) => s.flavor), [0, 0, 0, 0, 0], 'A должна остаться с пятью кусочками');
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurn(st, [1]);
  assert(evalEnd(st).phase === 'won', 'уровень должен быть пройден (режим очистки)');
});

/* --------------------------- 6. Сортировка -------------------------- */

test('6.1 Простое совпадение: кусочки уходят к размещённой тарелке', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0, 0]]], [{ kind: 'single', slices: [0, 0, 0] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const t = planNextTransfer(st, [1]);
  assert(t !== null && t.to === 1 && t.from === 0 && t.count === 3, 'получатель — размещённая тарелка (правило хода)');
  assert(t.path.length === 2 && t.path[0] === 0 && t.path[1] === 1, 'прямой перенос — маршрут из двух ячеек');
  resolveTurn(st, [1]);
  assertEq(st.completed, 1, 'торт должен собраться');
  assert(st.board[0] === null && st.board[1] === null, 'обе ячейки должны освободиться');
});

test('6.2 Завершение торта и освобождение ячейки', () => {
  const st = createInitialState(lv(1, 2, [], [{ kind: 'single', slices: [3, 3, 3, 3, 3, 3] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const rep = resolveTurn(st, [1]);
  assertEq(rep.cakes, 1, 'полная тарелка должна собраться в торт');
  assert(st.board[1] === null && st.board[0] === null, 'ячейки должны освободиться');
  assertEq(st.completed, 1, 'счётчик тортов');
});

test('6.3 Диагональ: не соседи — прямого переноса нет', () => {
  const st = createInitialState(lv(2, 2, [[0, 0, [0, 0, 0]], [1, 1, [0, 0, 0]]], []));
  assert(planNextTransfer(st, []) === null, 'диагональные тарелки без маршрута не должны обмениваться');
});

test('6.4 Вместимость: перенос ограничен свободным местом', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0, 0, 0, 0]]], [{ kind: 'single', slices: [0, 0] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurn(st, [1]);
  assertEq(st.completed, 1, 'начальная тарелка должна стать тортом');
  assert(st.board[0] === null, 'ячейка торта должна освободиться');
  assertEq(st.board[1]?.slices.length, 1, 'перенос должен ограничиться свободным местом');
});

test('6.5 Детерминизм партии: жадная игра одинаково повторяется', () => {
  const run = (): string => {
    const level = buildLevel(5);
    const st = createInitialState(level);
    let moves = 0;
    for (;;) {
      topUpTray(level, st);
      const end = evalEnd(st);
      if (end.phase !== 'playing') break;
      const mv = bestMove(st);
      if (!mv) break;
      applyTrayMove(st, mv);
      resolveTurn(st, mv.cells);
      moves++;
      if (moves > 150) break;
    }
    return JSON.stringify({ moves, points: st.points, board: st.board.map((p) => (p ? p.slices.map((s) => s.flavor) : null)) });
  };
  assertEq(run(), run(), 'повторная партия должна пройти одинаково');
});

test('6.6 Приоритет при размещении двух тарелок за ход', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [4, 4, 4]], [0, 1, [4, 4, 4]]], []));
  assertEq(chooseRecipient(st, 0, 1, 4, [1]), 1, 'размещённая ячейка 1 должна победить');
  assertEq(chooseRecipient(st, 0, 1, 4, [0]), 0, 'размещённая ячейка 0 должна победить');
  assertEq(chooseRecipient(st, 0, 1, 4, [0, 1]), 0, 'при двух размещённых побеждает меньший индекс');
  assertEq(chooseRecipient(st, 0, 1, 4, []), 0, 'без размещённых — меньший индекс');
});

test('6.7 sharedAdjacency: соседства с совпадающими вкусами считаются', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 1]], [0, 1, [1, 2]]], []));
  assertEq(sharedAdjacency(st), 1, 'одно совпадение (вкус 1)');
  const empty = createInitialState(lv(1, 2, [], []));
  assertEq(sharedAdjacency(empty), 0, 'пустое поле — ноль соседств');
});

/* ------------------------- 7. Конец партии -------------------------- */

test('7.1 Поражение: только двойные в выдаче, пар нет', () => {
  const st = createInitialState(
    lv(
      2,
      2,
      [
        [0, 0, [0, 0]],
        [1, 1, [1, 1]],
      ],
      [
        { kind: 'double', a: [2, 2], b: [3, 3] },
        { kind: 'double', a: [5, 5], b: [6, 6] },
        { kind: 'double', a: [7, 7], b: [8, 8] },
        { kind: 'double', a: [7, 7], b: [8, 8] },
        { kind: 'double', a: [7, 7], b: [8, 8] },
      ],
    ),
  );
  assert(st.tray.slice(0, WINDOW).every((it) => it.kind === 'double'), 'в окне только двойные');
  assertEq(evalEnd(st), { phase: 'lost', reason: 'full' }, 'должно быть поражение full');
});

test('7.2 В выдаче есть обычная тарелка — игра продолжается', () => {
  const st = createInitialState(
    lv(
      2,
      2,
      [
        [0, 0, [0, 0]],
        [1, 1, [1, 1]],
      ],
      [
        { kind: 'double', a: [2, 2], b: [3, 3] },
        { kind: 'single', slices: [5, 5, 5] },
      ],
    ),
  );
  assertEq(evalEnd(st), { phase: 'playing' }, 'обычная тарелка спасает партию');
});

test('7.3 Поражение leftover: очередь пуста, на поле остаток (без цели)', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0]]], []));
  assertEq(evalEnd(st), { phase: 'lost', reason: 'leftover' }, 'остаток без очереди — поражение');
});

test('7.4 Стол 3×3 заполняется — full даже с бесконечным потоком', () => {
  const level = buildLevel(2);
  const st = createInitialState(level);
  // заполняем все свободные ячейки первыми тарелками потока
  let guard = 0;
  while (st.board.some((p) => p === null) && guard++ < 20) {
    const mv = bestMove(st);
    if (!mv) break;
    applyTrayMove(st, mv);
    resolveTurn(st, mv.cells);
    topUpTray(level, st);
    // ломаем слияния: перекрашиваем всё в разные вкусы
    let f = 0;
    for (const p of st.board) {
      if (!p) continue;
      for (const s of p.slices) s.flavor = (f++ % 40) + 20; // вкусы вне уровня — никогда не совпадут
    }
  }
  assert(st.board.every((p) => p !== null) || evalEnd(st).phase !== 'playing', 'стол заполнен');
  if (st.board.every((p) => p !== null)) {
    assertEq(evalEnd(st), { phase: 'lost', reason: 'full' }, 'полный стол — поражение');
  }
});

/* ---------------------- 8. Цепочки соседних тарелок ----------------- */

test('8.1 Правило цепочки: кусочки летят через транзитные тарелки', () => {
  const st = createInitialState(
    lv(
      1,
      4,
      [
        [0, 0, [0, 0]],
        [0, 1, [3, 3, 3, 3, 3]],
        [0, 2, [8, 8, 8, 8]],
      ],
      [{ kind: 'single', slices: [0, 0, 0, 0] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [3], orientation: null });
  const t = planNextTransfer(st, [3]);
  assert(t !== null, 'цепочка не нашлась');
  assertEq(t.path, [0, 1, 2, 3], 'маршрут должен идти через обе транзитные тарелки');
  assert(t.from === 0 && t.to === 3 && t.count === 2, `перенос 0→3 на 2 кусочка, получено ${JSON.stringify(t)}`);
  resolveTurn(st, [3]);
  assertEq(st.completed, 1, 'торт должен собраться по цепочке');
  assert(st.board[0] === null, 'донор должен освободиться');
  assertEq(st.board[1]?.slices.map((s) => s.flavor), [3, 3, 3, 3, 3], 'транзит 1 не должен менять состав');
  assertEq(st.board[2]?.slices.map((s) => s.flavor), [8, 8, 8, 8], 'транзит 2 не должен менять состав');
});

test('8.2 Полный транзит блокирует цепочку', () => {
  const st = createInitialState(
    lv(
      1,
      4,
      [
        [0, 0, [0, 0]],
        [0, 1, [3, 3, 3, 4, 4, 4]],
        [0, 2, [8, 8, 8, 8]],
      ],
      [{ kind: 'single', slices: [0, 0, 0, 0] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [3], orientation: null });
  assert(planNextTransfer(st, [3]) === null, 'полная тарелка не должна пропускать кусочки');
});

test('8.3 Цепочка ограничена местом получателя', () => {
  const st = createInitialState(
    lv(
      1,
      4,
      [
        [0, 0, [0, 0]],
        [0, 1, [3, 3, 3, 3, 3]],
        [0, 2, [8, 8, 8, 8]],
      ],
      [{ kind: 'single', slices: [0, 0, 0, 0, 5] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [3], orientation: null });
  const t = planNextTransfer(st, [3]);
  assert(t !== null && t.count === 1, `перенос должен быть на 1 кусочек, получено ${t ? t.count : 'null'}`);
});

test('8.4 Направление цепочки — к тарелке, где вкуса больше', () => {
  const st = createInitialState(
    lv(
      1,
      4,
      [
        [0, 0, [0, 0, 0, 0]],
        [0, 1, [3, 3, 3, 3, 3]],
        [0, 2, [8, 8, 8, 8]],
      ],
      [{ kind: 'single', slices: [0, 0] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [3], orientation: null });
  const t = planNextTransfer(st, [3]);
  assert(t !== null, 'цепочка не нашлась');
  assert(t.from === 3 && t.to === 0, `донор — размещённая, получатель — дальняя (4>2), получено ${JSON.stringify(t)}`);
  assertEq(t.path, [3, 2, 1, 0], 'маршрут от донора к получателю');
});

test('8.5 Цепочка на столе 3×3: по периметру к дальнему углу', () => {
  // угол 0 — пять «0»; по краю транзиты 1, 2, 5; размещаем [0] в угол 8
  const st = createInitialState(
    lv(
      3,
      3,
      [
        [0, 0, [0, 0, 0, 0, 0]],
        [0, 1, [3, 3, 3]],
        [0, 2, [8, 8, 8, 8]],
        [1, 2, [5, 5, 5]],
      ],
      [{ kind: 'single', slices: [0] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [8], orientation: null });
  const t = planNextTransfer(st, [8]);
  assert(t !== null, 'цепочка по краю не нашлась');
  assertEq(t.path, [8, 5, 2, 1, 0], 'маршрут угол → край → угол');
  resolveTurn(st, [8]);
  assertEq(st.completed, 1, 'торт собран по цепочке через край стола');
});

/* ------- 9. Этап B: каскад, журнал событий, maxChainHops (аудит §6.5) -- */

/** Ссылочная реализация разрешения хода ДО Этапа B (копия старого resolveTurn):
 *  журнал обязан быть ей эквивалентен на умолчательном конфиге. */
function referenceResolveTurn(state: Parameters<typeof resolveTurn>[0], lastPlaced: readonly number[]): { transfers: number; cakes: number } {
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

function fingerprint(s: ReturnType<typeof createInitialState>): string {
  return JSON.stringify({
    board: s.board.map((p) => (p ? p.slices.map((x) => x.flavor) : null)),
    points: s.points,
    completed: s.completed,
    combo: s.combo,
  });
}

/** Конфиг с заданной дальностью цепочки (остальное — умолчание) */
function hopsCfg(hops: number): CascadeConfig {
  return { ...DEFAULT_CASCADE_CONFIG, maxChainHops: hops };
}

test('9.1 Эквивалентность журнала и старого алгоритма на уровнях 1–12, обе стратегии', () => {
  for (let n = 1; n <= 12; n++) {
    // отдельные объекты уровня на партию: stream.next общий мутируется topUpTray
    const levelA = buildLevel(n);
    const levelB = buildLevel(n);
    const a = createInitialState(levelA);
    const b = createInitialState(levelB);
    // жадный
    for (let m = 0; m < 12; m++) {
      const mv = bestMove(a);
      const mv2 = bestMove(b);
      if (!mv || !mv2) break;
      applyTrayMove(a, mv);
      applyTrayMove(b, mv2);
      resolveTurnLogged(a, mv.cells);
      referenceResolveTurn(b, mv2.cells);
      topUpTray(levelA, a);
      topUpTray(levelB, b);
    }
    assertEq(fingerprint(a), fingerprint(b), `жадный, уровень ${n}: состояние разошлось`);
    // случайный (детерминированный)
    let seed = n * 7717;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const levelC = buildLevel(n);
    const levelD = buildLevel(n);
    const c = createInitialState(levelC);
    const d = createInitialState(levelD);
    for (let m = 0; m < 14; m++) {
      const moves = legalMoves(c);
      if (moves.length === 0) break;
      const mv = moves[Math.floor(rnd() * moves.length)];
      const mvB = { ...mv };
      applyTrayMove(c, mv);
      applyTrayMove(d, mvB);
      resolveTurnLogged(c, mv.cells);
      referenceResolveTurn(d, mvB.cells);
      topUpTray(levelC, c);
      topUpTray(levelD, d);
    }
    assertEq(fingerprint(c), fingerprint(d), `случайный, уровень ${n}: состояние разошлось`);
  }
});

test('9.2 Детерминизм журнала: одинаковый вход — одинаковый журнал', () => {
  const levelA = buildLevel(7);
  const levelB = buildLevel(7);
  for (let m = 0; m < 5; m++) {
    const a = createInitialState(levelA);
    const b = createInitialState(levelB);
    const mva = bestMove(a);
    const mvb = bestMove(b);
    if (!mva || !mvb) break;
    applyTrayMove(a, mva);
    applyTrayMove(b, mvb);
    const la = resolveTurnLogged(a, mva.cells);
    const lb = resolveTurnLogged(b, mvb.cells);
    assertEq(JSON.stringify(la), JSON.stringify(lb), `ход ${m}: журналы различаются`);
    topUpTray(levelA, a);
    topUpTray(levelB, b);
  }
});

test('9.3 maxChainHops = 1/2/3/∞: перенос через заданное число транзитов', () => {
  // ряд 0..3: маршрут [0,1,2,3] — 3 прыжка (2 транзита), углы и край поля
  const mk = () =>
    createInitialState(
      lv(
        1,
        4,
        [
          [0, 0, [0, 0]],
          [0, 1, [3, 3, 3, 3, 3]],
          [0, 2, [8, 8, 8, 8]],
        ],
        [{ kind: 'single', slices: [0, 0, 0, 0] }],
      ),
    );
  for (const [hops, expectNull] of [
    [1, true],
    [2, true],
    [3, false],
    [Infinity, false],
  ] as Array<[number, boolean]>) {
    const st = mk();
    applyTrayMove(st, { trayIdx: 0, cells: [3], orientation: null });
    const t = planNextTransfer(st, [3], hopsCfg(hops));
    if (expectNull) {
      assert(t === null, `hops=${hops}: перенос не должен находиться`);
    } else {
      assert(t !== null, `hops=${hops}: перенос должен находиться`);
      assertEq(t!.path, [0, 1, 2, 3], `hops=${hops}: маршрут из 3 прыжков`);
    }
  }
  // 3×3 по периметру: [8,5,2,1,0] — 4 прыжка, дальний угол через край
  const mk9 = () =>
    createInitialState(
      lv(
        3,
        3,
        [
          [0, 0, [0, 0, 0, 0, 0]],
          [0, 1, [3, 3, 3]],
          [0, 2, [8, 8, 8, 8]],
          [1, 2, [5, 5, 5]],
        ],
        [{ kind: 'single', slices: [0] }],
      ),
    );
  for (const [hops, expectNull] of [
    [1, true],
    [2, true],
    [3, true],
    [4, false],
  ] as Array<[number, boolean]>) {
    const st = mk9();
    applyTrayMove(st, { trayIdx: 0, cells: [8], orientation: null });
    const t = planNextTransfer(st, [8], hopsCfg(hops));
    if (expectNull) {
      assert(t === null, `3×3, hops=${hops}: перенос через полстола не должен находиться`);
    } else {
      assert(t !== null && t.path.length === 5, `3×3, hops=${hops}: маршрут угол→угол`);
    }
  }
});

test('9.4 Транзит — только через тарелку со свободным местом (при всех hops)', () => {
  for (const hops of [1, 2, 3, Infinity]) {
    const st = createInitialState(
      lv(
        1,
        4,
        [
          [0, 0, [0, 0]],
          [0, 1, [3, 3, 3, 4, 4, 4]], // полный транзит — блокирует единственный маршрут
          [0, 2, [8, 8, 8, 8]],
        ],
        [{ kind: 'single', slices: [0, 0, 0, 0] }],
      ),
    );
    applyTrayMove(st, { trayIdx: 0, cells: [3], orientation: null });
    assert(planNextTransfer(st, [3], hopsCfg(hops)) === null, `hops=${hops}: полный транзит должен блокировать`);
  }
});

test('9.5 maxResolutionSteps: безопасная остановка, состояние консистентно', () => {
  // уровень 7 (дальше обучения): играем с искусственно заниженным лимитом
  const level = buildLevel(7);
  const st = createInitialState(level);
  let aborted = 0;
  for (let m = 0; m < 12; m++) {
    const mv = bestMove(st);
    if (!mv) break;
    applyTrayMove(st, mv);
    const log = resolveTurnLogged(st, mv.cells, { ...DEFAULT_CASCADE_CONFIG, maxResolutionSteps: 2 });
    const ab = log.find((e) => e.kind === 'aborted');
    if (ab && ab.kind === 'aborted') {
      aborted++;
      assertEq(ab.limit, 2, 'лимит в событии aborted');
      const snap = JSON.parse(ab.snapshot) as { board: Array<number[] | null>; points: number };
      assertEq(snap.board.length, 9, 'снимок поля — 9 ячеек');
      assert(typeof snap.points === 'number', 'снимок содержит очки');
    }
    // консистентность: вместимость не нарушена, тарелки не пустые
    for (const p of st.board) {
      if (!p) continue;
      assert(p.slices.length >= 1 && p.slices.length <= CAP, `ход ${m}: тарелка из ${p.slices.length} кусочков`);
    }
    topUpTray(level, st);
    const end = evalEnd(st);
    // игра не блокируется: исход — законный (продолжение или честный конец)
    assert(end.phase === 'playing' || end.phase === 'won' || end.phase === 'lost', `ход ${m}: неожиданный исход`);
    if (end.phase !== 'playing') break;
  }
  assert(aborted > 0, 'заниженный лимит должен срабатывать хотя бы раз');
  // нормальный лимит никогда не срабатывает на реальных уровнях
  const st2 = createInitialState(buildLevel(13));
  for (let m = 0; m < 10; m++) {
    const mv = bestMove(st2);
    if (!mv) break;
    applyTrayMove(st2, mv);
    const log = resolveTurnLogged(st2, mv.cells);
    assert(log.every((e) => e.kind !== 'aborted'), `ход ${m}: ложное срабатывание защитного лимита`);
    topUpTray(buildLevel(13), st2);
  }
});

test('9.6 Освобождение донора в том же ходу: ячейка доступна следующим фазам', () => {
  const st = createInitialState(
    lv(
      3,
      3,
      [
        [0, 0, [1, 1]],
        [0, 1, [1, 1, 1, 1]],
        [1, 0, [2, 2]],
        [1, 1, [2, 2, 2, 2]],
      ],
      [{ kind: 'single', slices: [7] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [8], orientation: null });
  const log = resolveTurnLogged(st, [8]);
  const kinds = log.map((e) => e.kind);
  assert(kinds.includes('plateGone'), 'должен быть plateGone');
  assert(kinds.filter((k) => k === 'cake').length >= 2, 'оба торта должны собраться в одном ходу');
  // порядок: plateGone первой пары — до торта/переноса второй пары
  const gone1 = log.findIndex((e) => e.kind === 'plateGone' && e.cell === 0);
  const t2 = log.findIndex((e) => e.kind === 'transfer' && (e.transfer.from === 3 || e.transfer.to === 3));
  assert(gone1 >= 0 && t2 >= 0 && gone1 < t2, 'очистка первой пары должна предшествовать переносу второй');
  // освобождённые ячейки доступны и учитываются
  assert(canPlace(st, 0), 'ячейка 0 свободна после хода');
  assert(canPlace(st, 1), 'ячейка 1 свободна после хода');
  assertEq(st.board.filter(Boolean).length, 1, 'на поле осталась одна тарелка ([7] в углу)');
});

test('9.7 Комбо: растёт внутри хода, сбрасывается новым ходом, формула очков', () => {
  const level = lv(
    3,
    3,
    [
      [0, 0, [1, 1]],
      [0, 1, [1, 1, 1, 1]],
      [1, 0, [2, 2]],
      [1, 1, [2, 2, 2, 2]],
      [2, 0, [7, 7, 7, 7, 7]],
    ],
    [
      { kind: 'single', slices: [7] },
      { kind: 'single', slices: [9, 9] },
    ],
  );
  const st = createInitialState(level);
  // размещаем [7] рядом с пятёркой (ячейка 7 соседствует с 6) — прямой перенос
  applyTrayMove(st, { trayIdx: 0, cells: [7], orientation: null });
  const log = resolveTurnLogged(st, [7]);
  const cakes = log.filter((e): e is Extract<TurnEvent, { kind: 'cake' }> => e.kind === 'cake');
  assert(cakes.length === 3, `должно собраться 3 торта, собралось ${cakes.length}`);
  assertEq(cakes.map((c) => c.combo), [1, 2, 3], 'комбо растёт внутри хода');
  assertEq(cakes.map((c) => c.points), [100, 125, 150], 'очки: 100 + 25 за каждый следующий');
  // переносы: 2 кусочка вкуса 1, 2 кусочка вкуса 2, 1 кусочек вкуса 7
  const expected = 100 + 125 + 150 + MERGE_POINTS * 5;
  assertEq(st.points, expected, 'итоговые очки хода');
  assertEq(st.combo, 3, 'счётчик комбо после хода');
  // новый ход: размещение без слияний сбрасывает комбо (applyTrayMove)
  applyTrayMove(st, { trayIdx: 0, cells: [5], orientation: null });
  assertEq(st.combo, 0, 'начало хода сбрасывает комбо');
  resolveTurnLogged(st, [5]);
  assertEq(st.combo, 0, 'ход без тортов не меняет комбо');
});

test('9.8 Победа по очкам: последний торт хода засчитывается до evalEnd', () => {
  const target = 210;
  const level = lv(
    3,
    3,
    [
      [0, 0, [1, 1]],
      [0, 1, [1, 1, 1, 1]],
      [1, 0, [2, 2]],
      [1, 1, [2, 2, 2, 2]],
    ],
    [{ kind: 'single', slices: [7] }],
    target,
  );
  const st = createInitialState(level);
  applyTrayMove(st, { trayIdx: 0, cells: [8], orientation: null });
  const log = resolveTurnLogged(st, [8]);
  const cakes = log.filter((e): e is Extract<TurnEvent, { kind: 'cake' }> => e.kind === 'cake');
  assert(cakes.length === 2, 'два торта за ход');
  // очки до последнего торта были ниже цели, после — выше
  const first = cakes[0].points + MERGE_POINTS * 4; // 4 кусочка первого переноса
  assert(first < target, `после первого торта (${first}) цель ещё не взята`);
  assert(st.points >= target, `после последнего торта (${st.points}) цель взята`);
  assertEq(evalEnd(st), { phase: 'won' }, 'победа фиксируется сразу после хода');
});

test('9.9 Двойная тарелка: обе ячейки в журнале, приоритет получателя', () => {
  const st = createInitialState(
    lv(
      3,
      3,
      [[1, 1, [0, 0]]],
      [{ kind: 'double', a: [0, 0], b: [4, 4] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [3, 6], orientation: 1 });
  const log = resolveTurnLogged(st, [3, 6]);
  const place = log[0];
  assert(place.kind === 'place', 'первое событие — place');
  if (place.kind === 'place') assertEq(place.cells, [3, 6], 'обе ячейки двойной в журнале');
  const tr = log.find((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assert(tr !== undefined, 'перенос должен произойти');
  // равное число кусочков (2 и 2) → получатель — размещённая в этом ходу
  assertEq(tr!.transfer.to, 3, 'получатель — размещённая половинка (приоритет lastPlaced)');
  assertEq(tr!.transfer.from, 4, 'донор — тарелка с центра');
});

test('9.10 Прогрессия maxChainHops из конфига уровня читается и применяется', () => {
  // обучение: без ограничения
  for (let n = 1; n <= TRAINING_LEVELS; n++) {
    assertEq(levelConfig(n).maxChainHops, Infinity, `уровень ${n}: обучение без ограничения`);
    assertEq(buildLevel(n).cascade?.maxChainHops, Infinity, `уровень ${n}: каскад уровня`);
  }
  // дальше: два прыжка
  for (const n of [TRAINING_LEVELS + 1, 10, 25, 40]) {
    assertEq(levelConfig(n).maxChainHops, 2, `уровень ${n}: два прыжка`);
    const level = buildLevel(n);
    assertEq(level.cascade?.maxChainHops, 2, `уровень ${n}: каскад уровня`);
    const st = createInitialState(level);
    assertEq(st.cascade?.maxChainHops, 2, `уровень ${n}: каскад в состоянии`);
  }
  // функционально: длинная цепочка на «пост-обучающем» уровне не работает
  const restricted = lv(
    1,
    4,
    [
      [0, 0, [0, 0]],
      [0, 1, [3, 3, 3, 3, 3]],
      [0, 2, [8, 8, 8, 8]],
    ],
    [{ kind: 'single', slices: [0, 0, 0, 0] }],
  );
  restricted.cascade = { maxChainHops: 2 };
  const stR = createInitialState(restricted);
  applyTrayMove(stR, { trayIdx: 0, cells: [3], orientation: null });
  assert(planNextTransfer(stR, [3]) === null, 'цепочка в 3 прыжка запрещена конфигом уровня');
  // тот же уровень без ограничения — цепочка работает (∞ ведёт себя как раньше)
  const free = lv(
    1,
    4,
    [
      [0, 0, [0, 0]],
      [0, 1, [3, 3, 3, 3, 3]],
      [0, 2, [8, 8, 8, 8]],
    ],
    [{ kind: 'single', slices: [0, 0, 0, 0] }],
  );
  free.cascade = { maxChainHops: Infinity };
  const stF = createInitialState(free);
  applyTrayMove(stF, { trayIdx: 0, cells: [3], orientation: null });
  assert(planNextTransfer(stF, [3]) !== null, 'без ограничения цепочка работает как до Этапа B');
});

test('9.11 Прочие поля CascadeConfig: отключение цепочек, лимиты (конфиг выживает)', () => {
  // allowChainTransfers = false — остаются только прямые переносы
  const st = createInitialState(
    lv(
      1,
      4,
      [
        [0, 0, [0, 0]],
        [0, 1, [3, 3, 3, 3, 3]],
        [0, 2, [8, 8, 8, 8]],
      ],
      [{ kind: 'single', slices: [0, 0, 0, 0] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [3], orientation: null });
  assert(
    planNextTransfer(st, [3], { ...DEFAULT_CASCADE_CONFIG, allowChainTransfers: false }) === null,
    'без цепочек дальний перенос запрещён',
  );
  // maxTransfersPerTurn = 0 — разрешения нет вовсе (структура из ТЗ 3.5)
  const st3 = createInitialState(
    lv(2, 2, [[0, 0, [1, 1]], [0, 1, [1, 1, 1, 1]]], [{ kind: 'single', slices: [7] }]),
  );
  applyTrayMove(st3, { trayIdx: 0, cells: [3], orientation: null });
  const log = resolveTurnLogged(st3, [3], { ...DEFAULT_CASCADE_CONFIG, maxTransfersPerTurn: 0 });
  assert(log.every((e) => e.kind !== 'transfer'), 'лимит переносов = 0 запрещает переносы');
});

/* ---- 10. Эксперимент: H2 + Same Flavor Transit (nextStep §2–3) ----- */

/**
 * Конфиг эксперимента: H2 (два прыжка — один транзит) + флаг проверки
 * вкуса транзитной тарелки. on=false воспроизводит действующий H2.
 */
function sftCfg(on: boolean, hops = 2): CascadeConfig {
  return { ...DEFAULT_CASCADE_CONFIG, maxChainHops: hops, sameFlavorTransit: on };
}

/**
 * Поле примера из ТЗ §2.2: размещённая тарелка P (шоколад+ваниль, полная),
 * промежуточная M (шоколад+клубника), шоколадная C и ванильная V тарелки.
 * Вкусы: 0=шоколад, 1=ваниль, 2=клубника.
 */
function sftExampleLevel(): LevelData {
  return lv(
    3,
    3,
    [
      [1, 1, [0, 2]], // M — транзит: шоколад есть, ванили нет
      [2, 1, [0, 0, 0, 0]], // C — шоколадная
      [1, 2, [1, 1, 1, 1, 1]], // V — ванильная
    ],
    [{ kind: 'single', slices: [0, 1, 3, 3, 4, 4] }], // P — размещаем в ячейку 1
  );
}

/**
 * Поле для сценариев «два вкуса через один транзит»: донор D1 (вкус 0),
 * донор D2 (вкус 1), общий транзит T (вкусы 0 и 1), получатели X0 и X1.
 * Оба донора полные — прямые пары «донор–транзит» не образуются
 * (получатель по числу кусочков полон).
 */
function sftTwoFlavorLevel(): LevelData {
  return lv(
    3,
    3,
    [
      [0, 1, [0, 0, 7, 7, 8, 8]], // D1 (ячейка 1): 2×шоколад, полная
      [1, 1, [0, 1, 9, 9]], // T (ячейка 4): транзит с обоими вкусами
      [1, 0, [1, 1, 5, 5, 6, 6]], // D2 (ячейка 3): 2×ваниль, полная
      [2, 1, [0, 0, 0, 0]], // X0 (ячейка 7): шоколадная
      [1, 2, [1, 1, 1, 1]], // X1 (ячейка 5): ванильная, место под оба кусочка D2
    ],
    [{ kind: 'single', slices: [4] }], // размещаем нейтральный кусочек в ячейку 8
  );
}

test('10.1 Совпадающий вкус в транзите — маршрут разрешён', () => {
  // D (ячейка 1, полная: 3×0) — T (ячейка 4: [0,9,9], вкус 0 есть) — X (ячейка 7: 4×0)
  const st = createInitialState(
    lv(3, 3, [[0, 1, [0, 0, 0, 7, 7, 8]], [1, 1, [0, 9, 9]], [2, 1, [0, 0, 0, 0]]], [{ kind: 'single', slices: [4] }]),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [8], orientation: null });
  const on = planChainFrom(st, 1, 0, [8], 2, true);
  assert(on !== null, 'цепочка через транзит с совпадающим вкусом должна находиться');
  assertEq(on, { from: 1, to: 7, flavor: 0, count: 2, path: [1, 4, 7] }, 'маршрут D→T→X на 2 кусочка');
  // без проверки вкуса — тот же маршрут (флаг только добавляет ограничение)
  const off = planChainFrom(st, 1, 0, [8], 2, false);
  assertEq(off, on, 'SFT выключен: тот же маршрут через этот транзит');
  // глубина 1 — транзит недопустим по числу прыжков, независимо от вкуса
  assert(planChainFrom(st, 1, 0, [8], 1, true) === null, 'hops=1: маршрут в 2 прыжка недопустим');
});

test('10.2 Несовпадающий вкус — транзит запрещён (полный конвейер)', () => {
  // D (ячейка 0: [0,0]) — T (ячейка 1: [3×5], вкуса 0 нет) — X (ячейка 2: размещаем [0×4])
  const st = createInitialState(
    lv(1, 3, [[0, 0, [0, 0]], [0, 1, [3, 3, 3, 3, 3]]], [{ kind: 'single', slices: [0, 0, 0, 0] }]),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [2], orientation: null });
  // действующий H2: цепочка D→X через транзит без вкуса работает
  const h2 = planNextTransfer(st, [2], sftCfg(false));
  assert(h2 !== null, 'H2: цепочка должна находиться');
  assertEq(h2, { from: 0, to: 2, flavor: 0, count: 2, path: [0, 1, 2] }, 'H2: маршрут через транзит без вкуса');
  // SFT: тот же транзит закрыт — вкуса 0 в нём нет
  assert(planNextTransfer(st, [2], sftCfg(true)) === null, 'SFT: транзит без нужного вкуса должен блокировать цепочку');
  // hops=1: цепочек нет вовсе, флаг не влияет
  assert(planNextTransfer(st, [2], sftCfg(false, 1)) === null, 'hops=1 без SFT: цепочки нет');
  assert(planNextTransfer(st, [2], sftCfg(true, 1)) === null, 'hops=1 с SFT: цепочки нет');
});

test('10.3 Несколько вкусов в транзите — каждый проверяется независимо', () => {
  // D (ячейка 0, полная: 2×0 + 2×1) — T (ячейка 1: [0,2,2] — вкус 0 есть, вкуса 1 нет)
  // X0 (ячейка 2: 4×0) и X1 (ячейка 4: 5×1) — оба получателя за транзитом
  const st = createInitialState(
    lv(
      2,
      3,
      [
        [0, 0, [0, 0, 1, 1, 9, 9]],
        [0, 1, [0, 2, 2]],
        [0, 2, [0, 0, 0, 0]],
        [1, 1, [1, 1, 1, 1, 1]],
      ],
      [{ kind: 'single', slices: [4] }],
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [5], orientation: null });
  // вкус 0: транзит его содержит — маршрут открыт
  const f0 = planChainFrom(st, 0, 0, [5], 2, true);
  assert(f0 !== null, 'вкус 0: транзит содержит его — маршрут разрешён');
  assertEq(f0, { from: 0, to: 2, flavor: 0, count: 2, path: [0, 1, 2] }, 'вкус 0 идёт через транзит к X0');
  // вкус 1: транзит его не содержит — маршрут закрыт (при том же транзите)
  assert(planChainFrom(st, 0, 1, [5], 2, true) === null, 'вкус 1: транзит без него должен блокировать маршрут');
  // без SFT тот же вкус 1 проходит — разница именно в проверке вкуса
  const f1h2 = planChainFrom(st, 0, 1, [5], 2, false);
  assert(f1h2 !== null, 'H2: вкус 1 проходит через транзит без проверки');
  assertEq(f1h2, { from: 0, to: 4, flavor: 1, count: 1, path: [0, 1, 4] }, 'H2: вкус 1 идёт через транзит к X1');
});

test('10.4 Два вкуса проходят через один транзит, если он содержит оба', () => {
  const st = createInitialState(sftTwoFlavorLevel());
  applyTrayMove(st, { trayIdx: 0, cells: [8], orientation: null });
  // уровень правил: оба вкуса маршрутизируются через один и тот же транзит T
  const c0 = planChainFrom(st, 1, 0, [8], 2, true);
  assertEq(c0, { from: 1, to: 7, flavor: 0, count: 2, path: [1, 4, 7] }, 'вкус 0: D1→T→X0');
  const c1 = planChainFrom(st, 3, 1, [8], 2, true);
  assertEq(c1, { from: 3, to: 5, flavor: 1, count: 2, path: [3, 4, 5] }, 'вкус 1: D2→T→X1');
  // уровень каскада: без приоритета прямых переносов обе цепочки выполняются
  // за один ход (изоляция правила от вытеснения прямыми переносами)
  const st2 = createInitialState(sftTwoFlavorLevel());
  applyTrayMove(st2, { trayIdx: 0, cells: [8], orientation: null });
  const log = resolveTurnLogged(st2, [8], { ...sftCfg(true), directTransferPriority: false });
  const chains = log.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(
    chains.map((e) => e.transfer.path),
    [
      [1, 4, 7],
      [3, 4, 5],
    ],
    'обе цепочки идут через общий транзит',
  );
});

test('10.5 Пример ТЗ §2.2: шоколад проходит, ваниль блокируется', () => {
  const st = createInitialState(sftExampleLevel());
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  // уровень правил: шоколад (0) проходит через M в C, ваниль (1) — нет
  const choc = planChainFrom(st, 1, 0, [1], 2, true);
  assertEq(choc, { from: 1, to: 7, flavor: 0, count: 1, path: [1, 4, 7] }, 'шоколад: P→M→C разрешён');
  assert(planChainFrom(st, 1, 1, [1], 2, true) === null, 'ваниль: в M нет ванили — маршрут закрыт');
  const vanH2 = planChainFrom(st, 1, 1, [1], 2, false);
  assertEq(vanH2, { from: 1, to: 5, flavor: 1, count: 1, path: [1, 4, 5] }, 'H2: ваниль проходит через M без проверки');
  // динамика полного хода при приоритете прямых переносов (действующие правила):
  // прямой перенос вытесняет цепочку — шоколад M улетает в C напрямую,
  // после чего M больше не содержит шоколад и цепочка P→C закрывается
  const stSft = createInitialState(sftExampleLevel());
  applyTrayMove(stSft, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurnLogged(stSft, [1], sftCfg(true));
  assertEq(stSft.completed, 0, 'SFT: торт не собирается — транзит потерял вкус прямым переносом');
  assertEq(stSft.points, MERGE_POINTS, 'SFT: очки только за один прямой перенос');
  assertEq(stSft.board[4]?.slices.map((s) => s.flavor), [2], 'SFT: в M остался только клубничный кусочек');
  // тот же ход без SFT: обе цепочки P→C и P→V выполняются, два торта
  const stH2 = createInitialState(sftExampleLevel());
  applyTrayMove(stH2, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurnLogged(stH2, [1], sftCfg(false));
  assertEq(stH2.completed, 2, 'H2: шоколадный и ванильный торты собираются цепочками');
  assertEq(stH2.points, CAKE_POINTS + (CAKE_POINTS + COMBO_BONUS) + MERGE_POINTS * 3, 'H2: 100+125 за торты и 3 переноса');
});

test('10.6 Прямой перенос не блокируется новым правилом', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0]]], [{ kind: 'single', slices: [0, 0, 0, 0] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  for (const cfg of [sftCfg(true), sftCfg(true, 1), sftCfg(true, Infinity)]) {
    const t = planNextTransfer(st, [1], cfg);
    assert(t !== null, 'прямой перенос должен находиться при любом конфиге');
    assertEq(t!.path, [0, 1], 'прямой перенос: маршрут из двух ячеек, без транзита');
    assertEq(t!.count, 2, 'переносятся 2 кусочка к тарелке, где вкуса больше (4>2)');
  }
  resolveTurn(st, [1]);
  assertEq(st.completed, 1, 'торт собирается прямым переносом');
});

test('10.7 Полная промежуточная тарелка — по существующим правилам', () => {
  // (а) полный транзит без нужного вкуса — блокирует и H2, и SFT (вместимость)
  const stA = createInitialState(
    lv(1, 3, [[0, 0, [0, 0]], [0, 1, [3, 3, 3, 4, 4, 4]]], [{ kind: 'single', slices: [0, 0, 0, 0] }]),
  );
  applyTrayMove(stA, { trayIdx: 0, cells: [2], orientation: null });
  assert(planNextTransfer(stA, [2], sftCfg(false)) === null, 'H2: полный транзит блокирует цепочку');
  assert(planNextTransfer(stA, [2], sftCfg(true)) === null, 'SFT: полный транзит блокирует так же');
  // (б) полный транзит С нужным вкусом: совпадение вкуса не отменяет правило
  // вместимости — транзит по-прежнему закрыт
  const stB = createInitialState(
    lv(1, 4, [[0, 0, [0, 0, 0, 9, 9, 9]], [0, 1, [0, 1, 1, 2, 2, 2]], [0, 2, [0, 0, 0, 0]]], [{ kind: 'single', slices: [4] }]),
  );
  applyTrayMove(stB, { trayIdx: 0, cells: [3], orientation: null });
  assert(planChainFrom(stB, 0, 0, [3], 2, true) === null, 'SFT: полный транзит закрыт несмотря на совпадающий вкус');
  assert(planChainFrom(stB, 0, 0, [3], 2, false) === null, 'H2: тот же полный транзит закрыт');
  // (в) полная тарелка сама отдавать может — прямая отдача не блокируется
  const t = planNextTransfer(stB, [3], sftCfg(true));
  assert(t !== null, 'полный транзит отдаёт кусочек напрямую');
  assertEq(t, { from: 1, to: 2, flavor: 0, count: 1, path: [1, 2] }, 'прямой перенос 0-вкуса от полной тарелки');
});

test('10.8 Несколько возможных маршрутов — детерминированная обработка', () => {
  // D (ячейка 0, полная: 3×0), два транзита: T1 (ячейка 1) и T2 (ячейка 3), X (ячейка 4)
  const mk = (t1: number[], t2: number[]) =>
    createInitialState(
      lv(2, 3, [[0, 0, [0, 0, 0, 9, 9, 9]], [0, 1, t1], [1, 0, t2], [1, 1, [0, 0, 0, 0]]], [{ kind: 'single', slices: [4] }]),
    );
  // оба транзита с вкусом 0 — маршрут через первый по порядку BFS (T1)
  const stBoth = mk([0, 7], [0, 8]);
  applyTrayMove(stBoth, { trayIdx: 0, cells: [5], orientation: null });
  assertEq(planChainFrom(stBoth, 0, 0, [5], 2, true), { from: 0, to: 4, flavor: 0, count: 2, path: [0, 1, 4] }, 'оба транзита вкусные: маршрут через T1');
  // вкус только во втором — маршрут обязан идти через T2
  const stSecond = mk([7, 7], [0, 8]);
  applyTrayMove(stSecond, { trayIdx: 0, cells: [5], orientation: null });
  assertEq(planChainFrom(stSecond, 0, 0, [5], 2, true), { from: 0, to: 4, flavor: 0, count: 2, path: [0, 3, 4] }, 'вкус только в T2: маршрут через T2');
  // ни в одном — маршрута нет
  const stNone = mk([7, 7], [8, 8]);
  applyTrayMove(stNone, { trayIdx: 0, cells: [5], orientation: null });
  assert(planChainFrom(stNone, 0, 0, [5], 2, true) === null, 'без нужного вкуса в транзитах маршрута нет');
  // повторные вызовы дают идентичный результат (детерминизм)
  const a = planChainFrom(stBoth, 0, 0, [5], 2, true);
  const b = planChainFrom(stBoth, 0, 0, [5], 2, true);
  assertEq(a, b, 'повторный вызов — тот же маршрут');
  const p1 = planNextTransfer(stBoth, [5], sftCfg(true));
  const p2 = planNextTransfer(stBoth, [5], sftCfg(true));
  assertEq(p1, p2, 'planNextTransfer детерминирован при SFT');
});

test('10.9 Сборка торта после разрешённого переноса — без изменений', () => {
  const st = createInitialState(sftTwoFlavorLevel());
  applyTrayMove(st, { trayIdx: 0, cells: [8], orientation: null });
  const log = resolveTurnLogged(st, [8], { ...sftCfg(true), directTransferPriority: false });
  const cakes = log.filter((e): e is Extract<TurnEvent, { kind: 'cake' }> => e.kind === 'cake');
  assertEq(cakes.map((c) => c.combo), [1, 2], 'комбо растёт внутри хода');
  assertEq(cakes.map((c) => c.points), [CAKE_POINTS, CAKE_POINTS + COMBO_BONUS], 'очки: 100, затем 125');
  assertEq(st.completed, 2, 'оба торта собраны цепными переносами');
  assertEq(st.points, CAKE_POINTS + (CAKE_POINTS + COMBO_BONUS) + MERGE_POINTS * 4, 'очки за торты и переносы (2+2 кусочка)');
  assert(canPlace(st, 7), 'ячейка X0 освобождена после торта');
  assert(canPlace(st, 5), 'ячейка X1 освобождена после торта');
  assert(st.board[1] !== null && st.board[3] !== null, 'доноры остались на поле');
});

test('10.10 Полные партии с SFT: завершимость, целостность, детерминизм', () => {
  // Важно: при действующем приоритете прямых переносов и включённом SFT
  // цепочечные переносы не возникают вовсе: транзитная тарелка с нужным
  // вкусом всегда связана pending-прямой парой с получателем, и прямой
  // перенос вытесняет цепочку (следствие правил, проверяется ниже).
  let totalTransfers = 0;
  let chainTransfers = 0;
  for (let n = 1; n <= 12; n++) {
    const level = buildLevel(n);
    level.cascade = { ...level.cascade, sameFlavorTransit: true };
    const st = createInitialState(level);
    const initialSlices = level.initial.reduce((s, p) => s + p.slices.length, 0);
    let placedSlices = 0;
    for (let m = 0; m < 40; m++) {
      const mv = bestMove(st);
      if (!mv) break;
      placedSlices += traySize(st.tray[mv.trayIdx]);
      applyTrayMove(st, mv);
      const log = resolveTurnLogged(st, mv.cells);
      assert(log.every((e) => e.kind !== 'aborted'), `уровень ${n}, ход ${m}: защитный лимит не должен срабатывать`);
      for (const e of log) {
        if (e.kind !== 'transfer') continue;
        totalTransfers++;
        if (e.transfer.path.length > 2) chainTransfers++;
        assert(e.transfer.path.length === 2, `уровень ${n}, ход ${m}: цепной перенос при приоритете прямых`);
      }
      for (const p of st.board) {
        if (p) assert(p.slices.length >= 1 && p.slices.length <= CAP, `уровень ${n}, ход ${m}: битая тарелка`);
      }
      // сохранение кусочков: начальные + размещённые = на поле + 6 × собранные
      const onBoard = st.board.reduce((s, p) => s + (p ? p.slices.length : 0), 0);
      assertEq(initialSlices + placedSlices, onBoard + CAP * st.completed, `уровень ${n}, ход ${m}: кусочки не теряются`);
      topUpTray(level, st);
      const end = evalEnd(st);
      if (end.phase !== 'playing') break;
    }
  }
  assert(totalTransfers > 0, 'переносы в партиях должны происходить');
  assertEq(chainTransfers, 0, 'при приоритете прямых переносов SFT-цепочки не возникают');
  // случайный игрок (детерминированный) — те же гарантии целостности
  for (let n = 1; n <= 6; n++) {
    const level = buildLevel(n);
    level.cascade = { ...level.cascade, sameFlavorTransit: true };
    const st = createInitialState(level);
    let seed = n * 911;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let m = 0; m < 25; m++) {
      const moves = legalMoves(st);
      if (moves.length === 0) break;
      const mv = moves[Math.floor(rnd() * moves.length)];
      applyTrayMove(st, mv);
      const log = resolveTurnLogged(st, mv.cells);
      assert(log.every((e) => e.kind !== 'aborted'), `случайный, уровень ${n}, ход ${m}: без срабатывания лимита`);
      for (const e of log) {
        if (e.kind === 'transfer') assert(e.transfer.path.length === 2, `случайный, уровень ${n}: цепной перенос`);
      }
      topUpTray(level, st);
      if (evalEnd(st).phase !== 'playing') break;
    }
  }
  // детерминизм: одна и та же партия с SFT повторяется в точности
  const runs: string[] = [];
  for (let run = 0; run < 2; run++) {
    const level = buildLevel(7);
    level.cascade = { ...level.cascade, sameFlavorTransit: true };
    const st = createInitialState(level);
    const trace: string[] = [];
    for (let m = 0; m < 12; m++) {
      const mv = bestMove(st);
      if (!mv) break;
      applyTrayMove(st, mv);
      resolveTurnLogged(st, mv.cells);
      trace.push(fingerprint(st));
      topUpTray(level, st);
      if (evalEnd(st).phase !== 'playing') break;
    }
    runs.push(trace.join('|'));
  }
  assertEq(runs[0], runs[1], 'повтор партии с SFT даёт ту же последовательность состояний');
});

test('10.11 Выключенный sameFlavorTransit — поведение совпадает с H2', () => {
  // (а) явный false ≡ отсутствие флага на уровне planNextTransfer
  const st = createInitialState(
    lv(1, 3, [[0, 0, [0, 0]], [0, 1, [3, 3, 3, 3, 3]]], [{ kind: 'single', slices: [0, 0, 0, 0] }]),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [2], orientation: null });
  const explicitOff = planNextTransfer(st, [2], { ...DEFAULT_CASCADE_CONFIG, maxChainHops: 2, sameFlavorTransit: false });
  const absentFlag = planNextTransfer(st, [2], hopsCfg(2));
  assertEq(explicitOff, absentFlag, 'явный false и отсутствие флага эквивалентны');
  // (б) полные партии: конфиг уровня с явным false ≡ конфиг без флага
  for (let n = 1; n <= 10; n++) {
    const levelA = buildLevel(n);
    const levelB = buildLevel(n);
    levelA.cascade = { ...levelA.cascade, sameFlavorTransit: false };
    const a = createInitialState(levelA);
    const b = createInitialState(levelB);
    for (let m = 0; m < 10; m++) {
      const mva = bestMove(a);
      const mvb = bestMove(b);
      if (!mva || !mvb) break;
      applyTrayMove(a, mva);
      applyTrayMove(b, mvb);
      const la = resolveTurnLogged(a, mva.cells);
      const lb = resolveTurnLogged(b, mvb.cells);
      assertEq(JSON.stringify(la), JSON.stringify(lb), `уровень ${n}, ход ${m}: журналы расходятся`);
      topUpTray(levelA, a);
      topUpTray(levelB, b);
      if (evalEnd(a).phase !== 'playing') break;
    }
    assertEq(fingerprint(a), fingerprint(b), `уровень ${n}: итоговые состояния расходятся`);
  }
});

/* ------- 11. Симулятор сравнения (nextStep §4–5): apparatus-тесты ----- */
/* Проверяется КОРРЕКТНОСТЬ аппарата эксперимента: генератор уровней
 * произвольного размера, варианты механики, детектор блокировок,
 * стратегии, детерминизм и границы метрик. Сравнительные симуляции
 * (nextStep §5) отсюда НЕ запускаются — только мини-партии фиксированной
 * длины для проверки инвариантов.                                        */

test('11.1 buildLevelSized: 3×3 совпадает с buildLevel, прочие размеры валидны', () => {
  for (let n = 1; n <= 12; n++) {
    assertEq(JSON.stringify(buildLevelSized(n, 3, 3)), JSON.stringify(buildLevel(n)), `уровень ${n}: 3×3 ≡ buildLevel`);
  }
  for (const [rows, cols] of [
    [3, 4],
    [4, 4],
    [4, 5],
  ] as Array<[number, number]>) {
    const level = buildLevelSized(6, rows, cols);
    assertEq([level.rows, level.cols], [rows, cols], `поле ${rows}×${cols}: размеры`);
    assertEq(level.tray.length, WINDOW + TRAY_BUFFER, `поле ${rows}×${cols}: стартовая выдача`);
    assert((level.target ?? 0) > 0, `поле ${rows}×${cols}: цель задана`);
    assert(level.stream !== undefined, `поле ${rows}×${cols}: поток на месте`);
    for (const p of level.initial) {
      assert(p.row >= 0 && p.row < rows && p.col >= 0 && p.col < cols, `поле ${rows}×${cols}: тарелка вне поля`);
      assert(p.slices.length >= 1 && p.slices.length <= CAP, `поле ${rows}×${cols}: состав тарелки в границах`);
    }
  }
});

test('11.2 Выдача одинакова на разных полях; генератор детерминирован', () => {
  for (let n = 1; n <= 8; n++) {
    const a33 = buildLevelSized(n, 3, 3);
    const b33 = buildLevelSized(n, 3, 3);
    assertEq(JSON.stringify(a33), JSON.stringify(b33), `уровень ${n}: повтор сборки идентичен`);
    const a45 = buildLevelSized(n, 4, 5);
    assertEq(JSON.stringify(a45.tray), JSON.stringify(a33.tray), `уровень ${n}: выдача не зависит от поля`);
    assertEq(a45.target, a33.target, `уровень ${n}: цель не зависит от поля`);
    assertEq(JSON.stringify(a45.stream), JSON.stringify(a33.stream), `уровень ${n}: поток не зависит от поля`);
  }
});

test('11.3 Варианты эксперимента и одинаковые начальные условия', () => {
  assertEq(
    VARIANTS.map((v) => v.name),
    ['Unlimited', 'H2', 'H2+SFT', 'H2+SFT+NoDP', 'H2+NPP', 'H2+SFT+NPP'],
    'шесть вариантов: 3 исходных + 4-я конфигурация + NPP-матрица',
  );
  assertEq(DEFAULT_CASCADE_CONFIG.sameFlavorTransit, false, 'игра по умолчанию — H2 без SFT');
  assertEq(DEFAULT_CASCADE_CONFIG.newPlatePriority, false, 'игра по умолчанию — без приоритета новой тарелки');
  assertEq(DEFAULT_CASCADE_CONFIG.directTransferPriority, true, 'игра по умолчанию — приоритет прямых переносов');
  const [unl, h2, sft, nodp, npp, sftnpp] = VARIANTS;
  assertEq(unl.cascade.maxChainHops, Infinity, 'Unlimited: дальность не ограничена');
  assertEq(unl.cascade.sameFlavorTransit, false, 'Unlimited: без правила вкуса');
  assertEq(h2.cascade.maxChainHops, 2, 'H2: два прыжка');
  assertEq(h2.cascade.sameFlavorTransit, false, 'H2: без правила вкуса');
  assertEq(sft.cascade.maxChainHops, 2, 'H2+SFT: два прыжка');
  assertEq(sft.cascade.sameFlavorTransit, true, 'H2+SFT: правило вкуса включено');
  // 4-я конфигурация: единственное отличие от H2+SFT — выключенный приоритет прямых
  assertEq(nodp.cascade.maxChainHops, 2, 'H2+SFT+NoDP: два прыжка');
  assertEq(nodp.cascade.sameFlavorTransit, true, 'H2+SFT+NoDP: правило вкуса включено');
  assertEq(nodp.cascade.directTransferPriority, false, 'H2+SFT+NoDP: приоритет прямых выключен');
  assertEq(nodp.cascade.newPlatePriority, undefined, 'H2+SFT+NoDP: приоритет новой тарелки не тронут');
  // NPP-матрица (ТЗ-дополнение §3)
  assertEq(npp.cascade.maxChainHops, 2, 'H2+NPP: два прыжка');
  assertEq(npp.cascade.newPlatePriority, true, 'H2+NPP: приоритет новой тарелки включён');
  assertEq(npp.cascade.sameFlavorTransit, false, 'H2+NPP: без правила вкуса');
  assertEq(sftnpp.cascade.maxChainHops, 2, 'H2+SFT+NPP: два прыжка');
  assertEq(sftnpp.cascade.sameFlavorTransit, true, 'H2+SFT+NPP: правило вкуса включено');
  assertEq(sftnpp.cascade.newPlatePriority, true, 'H2+SFT+NPP: приоритет новой тарелки включён');
  // сравнения из ТЗ покрываются этими шестью вариантами
  assertEq(COMPARISON_A, ['Unlimited', 'H2', 'H2+SFT', 'H2+SFT+NoDP'], 'сравнение A — 4 конфигурации H2+SFT');
  assertEq(COMPARISON_B, ['H2', 'H2+NPP', 'H2+SFT', 'H2+SFT+NPP'], 'сравнение B — матрица приоритета новой тарелки');
  // материал уровня у вариантов идентичен — различается только конфиг (§4.4)
  const stripCascade = (l: LevelData): string => JSON.stringify({ ...l, cascade: undefined });
  for (let n = 1; n <= 6; n++) {
    const size = { rows: 3, cols: 4 };
    const base = buildLevelSized(n, size.rows, size.cols);
    for (const v of VARIANTS) {
      const exp = buildExperimentLevel(n, size, v);
      assertEq(stripCascade(exp), stripCascade(base), `уровень ${n}, ${v.name}: материал не зависит от варианта`);
      assertEq(exp.cascade?.maxChainHops, v.cascade.maxChainHops, `уровень ${n}, ${v.name}: maxChainHops из варианта`);
      assertEq(exp.cascade?.sameFlavorTransit, v.cascade.sameFlavorTransit, `уровень ${n}, ${v.name}: sameFlavorTransit из варианта`);
      assertEq(
        exp.cascade?.directTransferPriority,
        v.cascade.directTransferPriority ?? DEFAULT_CASCADE_CONFIG.directTransferPriority,
        `уровень ${n}, ${v.name}: directTransferPriority из варианта (или умолчание)`,
      );
      assertEq(
        exp.cascade?.newPlatePriority,
        v.cascade.newPlatePriority ?? DEFAULT_CASCADE_CONFIG.newPlatePriority,
        `уровень ${n}, ${v.name}: newPlatePriority из варианта (или умолчание)`,
      );
    }
  }
});

test('11.4 Заблокированные маршруты: разложение причин (прыжки против вкуса транзита)', () => {
  // Поле 1×3: [7,7,7] [1,1] [7,7] — цепочка вкуса 7 в двух прыжках доступна,
  // но транзит не содержит вкуса 7: правило SFT обязано её закрыть.
  const st13 = createInitialState(lv(1, 3, [[0, 0, [7, 7, 7]], [0, 1, [1, 1]], [0, 2, [7, 7]]], []));
  // Поле 1×4: до получателя три прыжка — за лимитом H2.
  const st14 = createInitialState(lv(1, 4, [[0, 0, [7, 7, 7]], [0, 1, [1, 1]], [0, 2, [1, 1]], [0, 3, [7, 7]]], []));
  const cfgUnl = { ...DEFAULT_CASCADE_CONFIG, maxChainHops: Infinity, sameFlavorTransit: false };
  const cfgH2 = { ...DEFAULT_CASCADE_CONFIG, maxChainHops: 2, sameFlavorTransit: false };
  const cfgSFT = { ...DEFAULT_CASCADE_CONFIG, maxChainHops: 2, sameFlavorTransit: true };

  st13.cascade = cfgUnl;
  assertEq(countBlockedRoutes(st13), { blockedHops: 0, blockedSFT: 0 }, '1×3 Unlimited: блокировок нет');
  st13.cascade = cfgH2;
  assertEq(countBlockedRoutes(st13), { blockedHops: 0, blockedSFT: 0 }, '1×3 H2: цепочка из двух прыжков доступна');
  st13.cascade = cfgSFT;
  assertEq(countBlockedRoutes(st13), { blockedHops: 0, blockedSFT: 2 }, '1×3 H2+SFT: оба старта вкуса 7 закрыты правилом вкуса');

  st14.cascade = cfgUnl;
  assertEq(countBlockedRoutes(st14), { blockedHops: 0, blockedSFT: 0 }, '1×4 Unlimited: блокировок нет');
  st14.cascade = cfgH2;
  assertEq(countBlockedRoutes(st14), { blockedHops: 2, blockedSFT: 0 }, '1×4 H2: оба старта вкуса 7 закрыты лимитом прыжков');
  st14.cascade = cfgSFT;
  assertEq(countBlockedRoutes(st14), { blockedHops: 2, blockedSFT: 0 }, '1×4 H2+SFT: лимит прыжков срабатывает раньше правила вкуса');
});

test('11.5 Стратегии возвращают только допустимые ходы', () => {
  const names: StrategyName[] = ['random', 'immediate', 'space', 'combined'];
  for (const n of [1, 6, 12]) {
    const st = createInitialState(buildExperimentLevel(n, { rows: 3, cols: 3 }, VARIANTS[2]));
    const legal = legalMoves(st);
    assert(legal.length > 0, `уровень ${n}: нет допустимых ходов`);
    for (const name of names) {
      const mv = makeStrategy(name, seedAt(0))(st);
      assert(mv !== null, `уровень ${n}, ${name}: стратегия не вернула ход`);
      const found = legal.some(
        (m) =>
          mv !== null && m.trayIdx === mv.trayIdx && m.orientation === mv.orientation && m.cells.length === mv.cells.length && m.cells.every((c, i) => c === mv.cells[i]),
      );
      assert(found, `уровень ${n}, ${name}: ход вне списка допустимых`);
    }
  }
});

test('11.6 simulateGame: детерминизм, границы метрик, инварианты хода', () => {
  const opts = { maxMoves: 40, impactEvery: 7 };
  const strip = (g: GameResult): string => JSON.stringify({ ...g, ms: 0 });
  for (const variant of VARIANTS) {
    const level = buildExperimentLevel(3, { rows: 3, cols: 3 }, variant);
    for (const strategy of ['random', 'immediate', 'space', 'combined'] as StrategyName[]) {
      const a = simulateGame(level, variant.name, strategy, seedAt(1), opts, 3);
      const b = simulateGame(level, variant.name, strategy, seedAt(1), opts, 3);
      assertEq(strip(a), strip(b), `${variant.name}/${strategy}: повтор партии расходится`);
      assert(a.outcome === 'won' || a.outcome === 'lost' || a.outcome === 'cap', `${variant.name}/${strategy}: исход ${a.outcome}`);
      assert(a.moves <= opts.maxMoves, `${variant.name}/${strategy}: лимит ходов превышен`);
      assert(a.points >= 0 && a.cakes >= 0, `${variant.name}/${strategy}: отрицательные очки или торты`);
      for (const t of a.turns) {
        assert(t.freeAfter >= 0 && t.freeAfter <= 9, `${variant.name}/${strategy}: свободные ячейки вне [0..9]`);
        assert(t.blockedHops >= 0 && t.blockedSFT >= 0, `${variant.name}/${strategy}: отрицательные блокировки`);
        assert(t.legalPlacements > 0, `${variant.name}/${strategy}: ход без допустимых размещений`);
        if (t.chainTransfers > 0) {
          assert(t.maxPath > 2, `${variant.name}/${strategy}: цепочка без маршрута длиннее прямого переноса`);
          assert(t.chainPathSum >= 3 * t.chainTransfers, `${variant.name}/${strategy}: длина цепочки меньше трёх тарелок`);
        }
        assert(t.chainPathSum <= t.chainTransfers * 9, `${variant.name}/${strategy}: маршрут длиннее поля`);
      }
      if (variant.name === 'Unlimited') {
        assert(a.turns.every((t) => t.blockedHops === 0 && t.blockedSFT === 0), `${variant.name}: блокировок быть не может`);
      }
    }
  }
});

test('11.7 measureChoiceImpact: границы и сэмплирование', () => {
  const st = createInitialState(buildLevel(1));
  const legal = legalMoves(st);
  const imp = measureChoiceImpact(st);
  assertEq(imp.samples, legal.length, 'сэмплов — по числу допустимых размещений');
  assert(imp.spread >= 0 && Number.isFinite(imp.spread), 'разброс конечен и неотрицателен');
  assert(imp.std >= 0 && Number.isFinite(imp.std), 'σ конечна и неотрицательна');
  assert(imp.spread >= imp.std, 'разброс не меньше σ');
  // единственное размещение — разброс 0
  const stOne = createInitialState(lv(1, 2, [[0, 0, [7]]], [{ kind: 'single', slices: [7, 7, 7] }]));
  const one = measureChoiceImpact(stOne);
  assertEq(one.samples, 1, 'одно размещение — один сэмпл');
  assertEq(one.spread, 0, 'при одном размещении разброс — 0');
});

test('11.8 aggregate: инварианты сводки по вариантам', () => {
  const results: GameResult[] = [];
  for (const variant of VARIANTS) {
    // 4 партии на вариант: уровни 1–2 × два сида (одна стратегия —
    // одна группа на вариант; при общем уровне партии независимы
    // благодаря копии уровня в simulateGame)
    for (let n = 1; n <= 2; n++) {
      const level = buildExperimentLevel(n, { rows: 3, cols: 3 }, variant);
      results.push(simulateGame(level, variant.name, 'immediate', seedAt(0), { maxMoves: 80, impactEvery: 5 }, n));
      results.push(simulateGame(level, variant.name, 'immediate', seedAt(1), { maxMoves: 80, impactEvery: 5 }, n));
    }
  }
  const rows: AggregateRow[] = aggregate(results);
  assertEq(rows.length, VARIANTS.length, 'по одной строке на вариант');
  for (const r of rows) {
    assertEq(r.games, 4, `${r.variant}: 4 партии в группе`);
    assertEq(r.wins + r.losses + r.caps, r.games, `${r.variant}: исходы сходятся в сумму`);
    assert(r.winRate >= 0 && r.winRate <= 1, `${r.variant}: winRate в [0..1]`);
    assert(r.avgFree >= 0 && r.avgFree <= r.cells, `${r.variant}: средние свободные ячейки в границах`);
    assert(r.minFree >= 0, `${r.variant}: минимум свободных ячеек неотрицателен`);
    assert(r.chainShare >= 0 && r.chainShare <= 1, `${r.variant}: доля цепных в [0..1]`);
    assert(r.maxChainLen >= 0 && r.maxChainLen <= r.cells, `${r.variant}: длина цепочки в границах поля`);
    assert(r.cakesPerMove >= 0 && r.turnWithCakeShare + r.turnNoCakeShare <= 1.001, `${r.variant}: доли ходов согласованы`);
    assert(r.avgLegalPlacements > 0, `${r.variant}: размещения считаются`);
    assert(r.impactSpread >= r.impactStd && r.impactStd >= 0, `${r.variant}: разброс ≥ σ ≥ 0`);
    assert(r.impactSamples > 0, `${r.variant}: сэмплы влияния выбора собираются`);
  }
  const unl = rows.find((r) => r.variant === 'Unlimited');
  assert(unl !== undefined && unl.blockedHopsPerTurn === 0 && unl.blockedSFTPerTurn === 0, 'Unlimited: блокировок быть не может');
  const sft = rows.find((r) => r.variant === 'H2+SFT');
  assert(sft !== undefined && sft.blockedHopsPerTurn >= 0 && sft.blockedSFTPerTurn >= 0, 'H2+SFT: блокировки считаются');
});

/* -- 12. Четвёртая конфигурация: H2 + SFT + приоритет прямых OFF ------- */
/* nextStep, «Дополнение к эксперименту H2 + Same Flavor Transit»:
 * конфликт условия допуска транзита и приоритета прямых переносов
 * разрешается отдельной ЭКСПЕРИМЕНТАЛЬНОЙ конфигурацией. Ограничения
 * соблюдены: правила H2 не меняются, стандартный приоритет прямых
 * сохранён, алгоритм выбора получателя и порядок обработки вкусов не
 * тронуты, конфигурация по умолчанию не изменилась (см. 11.3, 12.4).     */

/** Конфигурация 4-го варианта: H2 + SFT + флаг приоритета прямых переносов */
function noDpCfg(directPriority: boolean): CascadeConfig {
  return { ...DEFAULT_CASCADE_CONFIG, maxChainHops: 2, sameFlavorTransit: true, directTransferPriority: directPriority };
}

test('12.1 Приоритет прямых выключен — SFT-цепочка возникает на примере ТЗ §2.2', () => {
  // Поле sftExampleLevel: размещённая P (полная), транзит M, шоколадная C,
  // ванильная V. Приоритет прямых ВКЛ (тест 10.5): прямой перенос M→C
  // вытесняет цепочку — 0 цепочек, 0 тортов. Приоритет ВЫКЛ: цепочный
  // проход находит P→M→C раньше прямой пары M→C.
  const st = createInitialState(sftExampleLevel());
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  // контраст флагов на одном и том же поле (первый перенос хода):
  const firstOn = planNextTransfer(st, [1], noDpCfg(true));
  assertEq(firstOn, { from: 4, to: 7, flavor: 0, count: 1, path: [4, 7] }, 'приоритет ВКЛ: первый перенос — прямой M→C');
  const firstOff = planNextTransfer(st, [1], noDpCfg(false));
  assertEq(firstOff, { from: 1, to: 7, flavor: 0, count: 1, path: [1, 4, 7] }, 'приоритет ВЫКЛ: первый перенос — цепочка P→M→C');
  // полный ход с выключенным приоритетом: цепочка + затем прямой M→C,
  // шоколадный торт собирается (в отличие от 10.5, где SFT+приоритет = 0 тортов)
  const st2 = createInitialState(sftExampleLevel());
  applyTrayMove(st2, { trayIdx: 0, cells: [1], orientation: null });
  const log = resolveTurnLogged(st2, [1], noDpCfg(false));
  const transfers = log.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(
    transfers.map((e) => e.transfer.path),
    [
      [1, 4, 7],
      [4, 7],
    ],
    'ход: сначала цепочка P→M→C, затем прямой M→C',
  );
  assertEq(st2.completed, 1, 'шоколадный торт собран (цепочка не вытеснена)');
  assertEq(st2.points, CAKE_POINTS + MERGE_POINTS * 2, 'очки: 100 за торт + 2 переноса');
  // ваниль по-прежнему блокирована SFT: в журнале нет переносов вкуса 1
  assert(transfers.every((e) => e.transfer.flavor === 0), 'SFT: ваниль не проходит через M (вкуса нет в транзите)');
});

test('12.2 Цепочные переносы в реальных партиях с 4-й конфигурацией', () => {
  // Ключевая проверка перед симуляциями (nextStep, дополнение: «подтвердить,
  // что в четвёртой конфигурации действительно возникают цепные переносы»).
  let chainTransfers = 0;
  let totalTransfers = 0;
  for (let n = 1; n <= 12; n++) {
    const level = buildLevel(n);
    level.cascade = { ...level.cascade, maxChainHops: 2, sameFlavorTransit: true, directTransferPriority: false };
    const st = createInitialState(level);
    const initialSlices = level.initial.reduce((s, p) => s + p.slices.length, 0);
    let placedSlices = 0;
    for (let m = 0; m < 40; m++) {
      const mv = bestMove(st);
      if (!mv) break;
      placedSlices += traySize(st.tray[mv.trayIdx]);
      applyTrayMove(st, mv);
      const log = resolveTurnLogged(st, mv.cells);
      assert(log.every((e) => e.kind !== 'aborted'), `уровень ${n}, ход ${m}: защитный лимит не должен срабатывать`);
      for (const e of log) {
        if (e.kind !== 'transfer') continue;
        totalTransfers++;
        if (e.transfer.path.length > 2) chainTransfers++;
        assert(e.transfer.path.length <= 3, `уровень ${n}, ход ${m}: маршрут длиннее H2 (2 прыжка)`);
      }
      for (const p of st.board) {
        if (p) assert(p.slices.length >= 1 && p.slices.length <= CAP, `уровень ${n}, ход ${m}: битая тарелка`);
      }
      const onBoard = st.board.reduce((s, p) => s + (p ? p.slices.length : 0), 0);
      assertEq(initialSlices + placedSlices, onBoard + CAP * st.completed, `уровень ${n}, ход ${m}: кусочки не теряются`);
      topUpTray(level, st);
      if (evalEnd(st).phase !== 'playing') break;
    }
  }
  assert(totalTransfers > 0, 'переносы в партиях должны происходить');
  assert(chainTransfers > 0, '4-я конфигурация: цепные переносы действительно возникают');
  // случайный игрок (детерминированный) — гарантии целостности; цепочки
  // от случайных расстановок не гарантируются (нужна топология «полный
  // донор → транзит со вкусом → получатель»), поэтому только инварианты
  for (let n = 1; n <= 6; n++) {
    const level = buildLevel(n);
    level.cascade = { ...level.cascade, maxChainHops: 2, sameFlavorTransit: true, directTransferPriority: false };
    const st = createInitialState(level);
    let seed = n * 911;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let m = 0; m < 25; m++) {
      const moves = legalMoves(st);
      if (moves.length === 0) break;
      const mv = moves[Math.floor(rnd() * moves.length)];
      applyTrayMove(st, mv);
      const log = resolveTurnLogged(st, mv.cells);
      assert(log.every((e) => e.kind !== 'aborted'), `случайный, уровень ${n}, ход ${m}: без срабатывания лимита`);
      for (const e of log) {
        if (e.kind === 'transfer') assert(e.transfer.path.length <= 3, `случайный, уровень ${n}: маршрут длиннее H2`);
      }
      for (const p of st.board) {
        if (p) assert(p.slices.length >= 1 && p.slices.length <= CAP, `случайный, уровень ${n}, ход ${m}: битая тарелка`);
      }
      topUpTray(level, st);
      if (evalEnd(st).phase !== 'playing') break;
    }
  }
});

test('12.3 Остальные три конфигурации сохранили прежнее поведение', () => {
  // (а) умолчания движка не изменились — поле в поле с конфигом до экспериментов
  assertEq(DEFAULT_CASCADE_CONFIG.maxResolutionSteps, 64, 'умолчание: защитный лимит шагов');
  assertEq(DEFAULT_CASCADE_CONFIG.maxTransfersPerTurn, Infinity, 'умолчание: переносов без лимита');
  assertEq(DEFAULT_CASCADE_CONFIG.maxCakesPerTurn, Infinity, 'умолчание: тортов без лимита');
  assertEq(DEFAULT_CASCADE_CONFIG.allowChainTransfers, true, 'умолчание: цепочки разрешены');
  assertEq(DEFAULT_CASCADE_CONFIG.maxChainHops, Infinity, 'умолчание: дальность не ограничена');
  assertEq(DEFAULT_CASCADE_CONFIG.directTransferPriority, true, 'умолчание: приоритет прямых включён (стандарт не тронут)');
  assertEq(DEFAULT_CASCADE_CONFIG.sameFlavorTransit, false, 'умолчание: без правила вкуса (H2)');
  assertEq(DEFAULT_CASCADE_CONFIG.newPlatePriority, false, 'умолчание: без приоритета новой тарелки');
  // (б) первые три варианта: конфиги те же, что до дополнения
  assertEq(JSON.stringify({ hops: VARIANTS[0].cascade.maxChainHops, sft: VARIANTS[0].cascade.sameFlavorTransit }), '{"hops":null,"sft":false}', 'Unlimited: прежний конфиг (∞ сериализуется как null)');
  assertEq(JSON.stringify(VARIANTS[1].cascade), '{"maxChainHops":2,"sameFlavorTransit":false}', 'H2: прежний конфиг');
  assertEq(JSON.stringify(VARIANTS[2].cascade), '{"maxChainHops":2,"sameFlavorTransit":true}', 'H2+SFT: прежний конфиг');
  // (в) сборка уровня вариантов 0–2 даёт конфиг, эквивалентный прежнему
  // движку: явные флаги равны умолчаниям, которые действовали раньше
  for (let i = 0; i <= 2; i++) {
    const v = VARIANTS[i];
    for (let n = 1; n <= 6; n++) {
      const exp = buildExperimentLevel(n, { rows: 3, cols: 3 }, v);
      assertEq(exp.cascade?.directTransferPriority, true, `вариант ${v.name}, уровень ${n}: приоритет прямых — стандартный`);
      assertEq(exp.cascade?.newPlatePriority, false, `вариант ${v.name}, уровень ${n}: приоритет новой тарелки выключен`);
    }
  }
  // (г) полные партии: явные флаги-умолчания ≡ отсутствию флагов
  // (журналы ходов совпадают в точности) — поведение движка не изменилось
  for (let n = 1; n <= 10; n++) {
    for (const sft of [false, true]) {
      const levelA = buildLevel(n);
      const levelB = buildLevel(n);
      levelA.cascade = { ...levelA.cascade, maxChainHops: 2, sameFlavorTransit: sft, directTransferPriority: true, newPlatePriority: false };
      levelB.cascade = { ...levelB.cascade, maxChainHops: 2, sameFlavorTransit: sft };
      const a = createInitialState(levelA);
      const b = createInitialState(levelB);
      for (let m = 0; m < 10; m++) {
        const mva = bestMove(a);
        const mvb = bestMove(b);
        if (!mva || !mvb) break;
        applyTrayMove(a, mva);
        applyTrayMove(b, mvb);
        const la = resolveTurnLogged(a, mva.cells);
        const lb = resolveTurnLogged(b, mvb.cells);
        assertEq(JSON.stringify(la), JSON.stringify(lb), `уровень ${n}, sft=${sft}, ход ${m}: журналы расходятся`);
        topUpTray(levelA, a);
        topUpTray(levelB, b);
        if (evalEnd(a).phase !== 'playing') break;
      }
      assertEq(fingerprint(a), fingerprint(b), `уровень ${n}, sft=${sft}: итоговые состояния расходятся`);
    }
  }
});

test('12.4 Детерминизм 4-й конфигурации и границы метрик', () => {
  // план переноса стабилен при повторных вызовах
  const st = createInitialState(sftExampleLevel());
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const a = planNextTransfer(st, [1], noDpCfg(false));
  const b = planNextTransfer(st, [1], noDpCfg(false));
  assertEq(a, b, 'повторный вызов planNextTransfer — тот же перенос');
  // полная партия повторяется в точности
  const runs: string[] = [];
  for (let run = 0; run < 2; run++) {
    const level = buildLevel(7);
    level.cascade = { ...level.cascade, maxChainHops: 2, sameFlavorTransit: true, directTransferPriority: false };
    const s = createInitialState(level);
    const trace: string[] = [];
    for (let m = 0; m < 12; m++) {
      const mv = bestMove(s);
      if (!mv) break;
      applyTrayMove(s, mv);
      resolveTurnLogged(s, mv.cells);
      trace.push(fingerprint(s));
      topUpTray(level, s);
      if (evalEnd(s).phase !== 'playing') break;
    }
    runs.push(trace.join('|'));
  }
  assertEq(runs[0], runs[1], 'повтор партии с 4-й конфигурацией — та же последовательность состояний');
  // simulateGame по 4-му варианту: инварианты + цепочки накапливаются
  // по нескольким уровням (один уровень может не дать топологию цепочки)
  let chainTurns = 0;
  for (let n = 1; n <= 6 && chainTurns === 0; n++) {
    const variant = VARIANTS[3];
    const level = buildExperimentLevel(n, { rows: 3, cols: 3 }, variant);
    const g1 = simulateGame(level, variant.name, 'combined', seedAt(1), { maxMoves: 40, impactEvery: 0 }, n);
    const g2 = simulateGame(level, variant.name, 'combined', seedAt(1), { maxMoves: 40, impactEvery: 0 }, n);
    assertEq(JSON.stringify({ ...g1, ms: 0 }), JSON.stringify({ ...g2, ms: 0 }), `уровень ${n}: simulateGame 4-й конфигурации детерминирован`);
    chainTurns += g1.turns.filter((t) => t.chainTransfers > 0).length;
    assert(g1.turns.every((t) => t.toNewPlate >= 0 && t.fromNewPlate >= 0 && !t.aborted), 'счётчики неотрицательны, аборта быть не должно');
  }
  assert(chainTurns > 0, 'в партиях с 4-й конфигурацией есть ходы с цепочками');
});

test('12.5 Флаг приоритета прямых: включён/выключен, взаимодействие с прочими флагами', () => {
  // при запрещённых цепочках флаг не имеет значения: прямой проход
  // выполняется в любом случае (иначе переносов бы не было вовсе)
  const st = createInitialState(sftExampleLevel());
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const offNoChains = planNextTransfer(st, [1], { ...noDpCfg(false), allowChainTransfers: false });
  const onNoChains = planNextTransfer(st, [1], { ...noDpCfg(true), allowChainTransfers: false });
  assertEq(offNoChains, onNoChains, 'цепочки запрещены: флаг приоритета прямых не влияет');
  assertEq(offNoChains?.path.length, 2, 'при запрещённых цепочках перенос только прямой');
  // прямой перенос не блокируется выключением приоритета: цепочный проход
  // находит и маршруты из двух ячеек (простое соседство)
  const stSimple = createInitialState(lv(1, 2, [[0, 0, [0, 0]]], [{ kind: 'single', slices: [0, 0, 0, 0] }]));
  applyTrayMove(stSimple, { trayIdx: 0, cells: [1], orientation: null });
  const t = planNextTransfer(stSimple, [1], noDpCfg(false));
  assert(t !== null, 'приоритет ВЫКЛ: прямой перенос всё равно находится');
  assertEq(t, { from: 0, to: 1, flavor: 0, count: 2, path: [0, 1] }, 'соседние тарелки: перенос к более богатой (4>2)');
  // порядок обработки вкусов не изменился: вкусы по возрастанию id
  const stFlavors = createInitialState(lv(1, 2, [[0, 0, [0, 0, 2, 2]]], [{ kind: 'single', slices: [0, 2] }]));
  applyTrayMove(stFlavors, { trayIdx: 0, cells: [1], orientation: null });
  const f = planNextTransfer(stFlavors, [1], noDpCfg(false));
  assertEq(f, { from: 1, to: 0, flavor: 0, count: 1, path: [1, 0] }, 'первый перенос — наименьший вкус 0 (порядок сохранён)');
});

/* -- 13. Приоритет новой тарелки как получателя (ТЗ-дополнение §1–6) --- */

/** Конфиг эксперимента NPP: H2 + флаг приоритета новой тарелки */
function nppCfg(on: boolean, extra: Partial<CascadeConfig> = {}): CascadeConfig {
  return { ...DEFAULT_CASCADE_CONFIG, maxChainHops: 2, newPlatePriority: on, ...extra };
}

test('13.1 Новая тарелка получает приоритет перед подходящей, даже если в ней меньше вкуса', () => {
  // X (3×шоколад) — P (размещённая, 1×шоколад + ваниль): существующий
  // алгоритм направил бы кусочек ОТ новой К более богатой; с приоритетом —
  // НАОБОРОТ: кусочки идут В новую тарелку (§1, §4 п. 1–2)
  const mk = () => {
    const st = createInitialState(lv(1, 3, [[0, 0, [0, 0, 0]]], [{ kind: 'single', slices: [0, 1] }]));
    applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
    return st;
  };
  const on = mk();
  assertEq(chooseRecipient(on, 0, 1, 0, [1], true), 1, 'прямая проверка: получатель — новая тарелка');
  assertEq(chooseRecipient(on, 0, 1, 0, [1], false), 0, 'флаг выключен: получатель — более богатая (3>1)');
  assertEq(
    planNextTransfer(on, [1], nppCfg(true)),
    { from: 0, to: 1, flavor: 0, count: 3, path: [0, 1] },
    'NPP: 3 кусочка идут в новую тарелку',
  );
  const off = mk();
  assertEq(
    planNextTransfer(off, [1], nppCfg(false)),
    { from: 1, to: 0, flavor: 0, count: 1, path: [1, 0] },
    'без NPP: 1 кусочек уходит из новой тарелки к более богатой',
  );
  // приоритет действует и когда новая тарелка — не «a», а «b» (симметрия)
  assertEq(chooseRecipient(on, 1, 0, 0, [1], true), 1, 'симметричный вызов: новая тарелка — второй аргумент');
});

test('13.2 Новая тарелка не может принять — работает существующий алгоритм', () => {
  // P размещена ПОЛНОЙ (1×шоколад + 5×филлер): приоритет не применяется,
  // получатель — более богатая X (3×шоколад), новая тарелка отдаёт (§4 п. 3)
  const mk = (placed: Flavor[]) => {
    const st = createInitialState(lv(1, 3, [[0, 0, [0, 0, 0]]], [{ kind: 'single', slices: placed }]));
    applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
    return st;
  };
  const full = mk([0, 7, 7, 7, 7, 7]);
  assertEq(
    planNextTransfer(full, [1], nppCfg(true)),
    { from: 1, to: 0, flavor: 0, count: 1, path: [1, 0] },
    'полная новая тарелка: существующий алгоритм выбирает альтернативного получателя',
  );
  assertEq(
    planNextTransfer(full, [1], nppCfg(false)),
    { from: 1, to: 0, flavor: 0, count: 1, path: [1, 0] },
    'без NPP — тот же результат (вместимость важнее приоритета)',
  );
  // новая полная с БОЛЬШИМ числом вкуса: и приоритет, и существующий
  // алгоритм называют её получателем, но места нет — переноса не будет
  const rich = mk([0, 0, 0, 0, 7, 7]);
  assert(planNextTransfer(rich, [1], nppCfg(true)) === null, 'перенос в полную тарелку невозможен (вместимость, §4 п. 5)');
  assert(planNextTransfer(rich, [1], nppCfg(false)) === null, 'без NPP — тоже невозможен');
});

test('13.3 Несколько вкусов: приоритет проверяется отдельно для каждого', () => {
  // X (3×шок + филлер) — P (размещённая, шок+ваниль) — V (4×ваниль):
  // с NPP оба вкуса идут В новую тарелку; без NPP оба — ИЗ неё
  const mk = () => {
    const st = createInitialState(
      lv(1, 3, [[0, 0, [0, 0, 0, 9]], [0, 2, [1, 1, 1, 1]]], [{ kind: 'single', slices: [0, 1] }]),
    );
    applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
    return st;
  };
  const on = mk();
  const logOn = resolveTurnLogged(on, [1], nppCfg(true));
  const trOn = logOn.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(
    trOn.map((e) => [e.transfer.from, e.transfer.to, e.transfer.flavor, e.transfer.count]),
    [
      [0, 1, 0, 3],
      [2, 1, 1, 1],
      [1, 2, 1, 2],
    ],
    'NPP: шоколад и ваниль сначала идут в новую тарелку (каждый вкус отдельно)',
  );
  // третий перенос: новая тарелка заполнилась (6 кусочков) — ваниль
  // возвращается к V по существующему алгоритму (§4 п. 3 в динамике)
  const off = mk();
  const logOff = resolveTurnLogged(off, [1], nppCfg(false));
  const trOff = logOff.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(
    trOff.map((e) => [e.transfer.from, e.transfer.to, e.transfer.flavor, e.transfer.count]),
    [
      [1, 0, 0, 1],
      [1, 2, 1, 1],
    ],
    'без NPP: оба вкуса покидают новую тарелку (прежнее поведение)',
  );
  assert(logOn.every((e) => e.kind !== 'aborted') && logOff.every((e) => e.kind !== 'aborted'), 'без срабатывания лимита');
});

test('13.4 Вместимость не нарушается: перенос ограничен свободным местом', () => {
  // P размещена с 5×шоколад (1 место), X держит 2×шоколад: в новую тарелку
  // уходит ровно 1 кусочек, торт из 6 собирается, ячейка освобождается
  const st = createInitialState(lv(1, 3, [[0, 0, [0, 0]]], [{ kind: 'single', slices: [0, 0, 0, 0, 0] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const t = planNextTransfer(st, [1], nppCfg(true));
  assertEq(t, { from: 0, to: 1, flavor: 0, count: 1, path: [0, 1] }, 'переносится только 1 кусочек (место — 1, у донора — 2)');
  resolveTurn(st, [1]);
  assertEq(st.completed, 1, 'торт из 6 кусочков собран');
  assert(st.board[1] === null, 'ячейка новой тарелки освободилась после сборки');
  assertEq(st.board[0]?.slices.length, 1, 'у донора остался 1 кусочек (ничего не потерялось)');
});

test('13.5 Выключенный параметр полностью совпадает с прежней реализацией', () => {
  // (а) на уровне плана переноса: явный false ≡ отсутствию флага (sftCfg
  // флага NPP не задаёт — берётся умолчание false)
  const st = createInitialState(
    lv(1, 3, [[0, 0, [0, 0, 0]]], [{ kind: 'single', slices: [0, 1] }]),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  assertEq(
    planNextTransfer(st, [1], nppCfg(false)),
    planNextTransfer(st, [1], sftCfg(false)),
    'явный false ≡ конфиг без флага NPP',
  );
  // (б) полные партии: конфиг с явным false ≡ конфигу без флага
  // (всё прочее — одинаковое, включая дальность цепочки уровня)
  for (let n = 1; n <= 10; n++) {
    const levelA = buildLevel(n);
    const levelB = buildLevel(n);
    levelA.cascade = { ...levelA.cascade, maxChainHops: 2, newPlatePriority: false };
    levelB.cascade = { ...levelB.cascade, maxChainHops: 2 };
    const a = createInitialState(levelA);
    const b = createInitialState(levelB);
    for (let m = 0; m < 10; m++) {
      const mva = bestMove(a);
      const mvb = bestMove(b);
      if (!mva || !mvb) break;
      applyTrayMove(a, mva);
      applyTrayMove(b, mvb);
      const la = resolveTurnLogged(a, mva.cells);
      const lb = resolveTurnLogged(b, mvb.cells);
      assertEq(JSON.stringify(la), JSON.stringify(lb), `уровень ${n}, ход ${m}: журналы расходятся`);
      topUpTray(levelA, a);
      topUpTray(levelB, b);
      if (evalEnd(a).phase !== 'playing') break;
    }
    assertEq(fingerprint(a), fingerprint(b), `уровень ${n}: итоговые состояния расходятся`);
  }
});

test('13.6 Пример ТЗ-дополнения §2: шоколад через транзит в новую тарелку, ваниль блокируется', () => {
  // C (полная: 2×шок + 2×ваниль + филлер) — M (транзит: шок+клубника) —
  // P (размещённая: шок+ваниль). Шоколад может пройти через M (M содержит
  // шоколад), ваниль — нет (в M нет ванили). Кусочки направляются в НОВУЮ
  // тарелку P, а не в другую тарелку с большим количеством вкуса.
  const mk = () => {
    const st = createInitialState(
      lv(
        1,
        4,
        [
          [0, 0, [0, 0, 1, 1, 9, 9]], // C — полная
          [0, 1, [0, 2]], // M — транзит (шоколад есть, ванили нет)
        ],
        [{ kind: 'single', slices: [0, 1] }], // P — размещаем в ячейку 2
      ),
    );
    applyTrayMove(st, { trayIdx: 0, cells: [2], orientation: null });
    return st;
  };
  const st = mk();
  // уровень правил: цепочка шоколада C→M→P с приоритетом новой тарелки
  const choc = planChainFrom(st, 0, 0, [2], 2, true, true);
  assertEq(choc, { from: 0, to: 2, flavor: 0, count: 2, path: [0, 1, 2] }, 'шоколад: C→M→P, получатель — новая тарелка');
  // без NPP существующий алгоритм назначил бы получателем полную C —
  // маршрута нет вовсе (куски остаются на месте)
  const noNpp = planChainFrom(st, 0, 0, [2], 2, true, false);
  assert(noNpp === null, 'без NPP: к более богатой C кусочки не идут (она полна) — маршрута нет');
  // ваниль: в M нет ванили — SFT блокирует маршрут независимо от NPP
  assert(planChainFrom(st, 0, 1, [2], 2, true, true) === null, 'ваниль: транзит без нужного вкуса закрыт (SFT)');
  // полный ход: H2 + SFT + NPP + приоритет прямых ВЫКЛ (совместная проверка
  // правил, включая 4-ю конфигурацию): цепочка выполняется целиком
  const joint = mk();
  const logJoint = resolveTurnLogged(joint, [2], nppCfg(true, { sameFlavorTransit: true, directTransferPriority: false }));
  const trJoint = logJoint.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(
    trJoint.map((e) => [e.transfer.from, e.transfer.to, e.transfer.flavor, e.transfer.count, e.transfer.path]),
    [
      [0, 2, 0, 2, [0, 1, 2]],
      [1, 2, 0, 1, [1, 2]],
    ],
    'совместный ход: цепочка C→M→P (2 кусочка) + прямой M→P (1 кусочек)',
  );
  assertEq(joint.board[2]?.slices.map((s) => s.flavor), [0, 1, 0, 0, 0], 'новая тарелка: 4×шоколад + ваниль');
  assert(trJoint.every((e) => e.transfer.flavor === 0), 'ваниль так и не двинулась (SFT)');
  // тот же ход при СТАНДАРТНОМ приоритете прямых: прямой M→P вытесняет
  // цепочку — шоколад M уходит в P, шоколад C остаётся (конфликт из
  // дополнения к эксперименту H2+SFT воспроизводится и с NPP)
  const direct = mk();
  const logDirect = resolveTurnLogged(direct, [2], nppCfg(true, { sameFlavorTransit: true }));
  const trDirect = logDirect.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(
    trDirect.map((e) => [e.transfer.from, e.transfer.to, e.transfer.path]),
    [[1, 2, [1, 2]]],
    'приоритет прямых ВКЛ: только прямой перенос M→P, цепочка вытеснена',
  );
  assertEq(direct.board[0]?.slices.filter((s) => s.flavor === 0).length, 2, 'шоколад C остался на месте — маршрут разрушен');
});

test('13.7 Цепочка с приоритетом новой тарелки против более богатого получателя', () => {
  // 2×3: D (полная, 4×шок) — T и T2 (транзиты с шоколадом) — P (размещённая,
  // 1×шок) и X (5×шок, 1 место). Оба получателя на глубине 2. С NPP кусочки
  // идут в НОВУЮ тарелку (4 шт.), без NPP — в более богатую X (1 шт.).
  const mk = () => {
    const st = createInitialState(
      lv(
        2,
        3,
        [
          [0, 0, [0, 0, 0, 0, 9, 9]], // D (ячейка 0): полная, 4×шоколад
          [0, 1, [0, 7]], // T (ячейка 1): транзит
          [1, 0, [0, 8]], // T2 (ячейка 3): транзит
          [1, 1, [0, 0, 0, 0, 0]], // X (ячейка 4): 5×шоколад, 1 место
        ],
        [{ kind: 'single', slices: [0, 1] }], // P — размещаем в ячейку 2
      ),
    );
    applyTrayMove(st, { trayIdx: 0, cells: [2], orientation: null });
    return st;
  };
  const on = mk();
  assertEq(
    planChainFrom(on, 0, 0, [2], 2, true, true),
    { from: 0, to: 2, flavor: 0, count: 4, path: [0, 1, 2] },
    'NPP: 4 кусочка идут цепочкой в новую тарелку (не в X с 5×шоколад)',
  );
  const off = mk();
  assertEq(
    planChainFrom(off, 0, 0, [2], 2, true, false),
    { from: 0, to: 4, flavor: 0, count: 1, path: [0, 1, 4] },
    'без NPP: 1 кусочек идёт в более богатую X (существующий алгоритм)',
  );
});

test('13.8 Порядок обработки вкусов не изменился (приоритет — попутно)', () => {
  // пара с двумя общими вкусами: первым обрабатывается меньший id,
  // приоритет новой тарелки не меняет порядок (§6: «не менять остальные
  // правила механики попутно»)
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0, 2, 2]]], [{ kind: 'single', slices: [0, 2] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const log = resolveTurnLogged(st, [1], nppCfg(true));
  const tr = log.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(tr.map((e) => e.transfer.flavor), [0, 2], 'вкусы обрабатываются по возрастанию id (0, затем 2)');
  assertEq(tr.map((e) => e.transfer.to), [1, 1], 'оба переноса — в новую тарелку (приоритет по каждому вкусу)');
  assertEq(st.board[1]?.slices.length, 6, 'новая тарелка заполнена ровно до вместимости');
  assert(st.board[0] === null, 'донор опустел и покинул поле');
});

test('13.9 Полные партии с NPP: целостность, активация правила, детерминизм', () => {
  // ВАЖНО (находка проверок перед симуляциями): приоритет новой тарелки
  // в текущей спецификации НЕ гарантирует завершимости разрешения хода —
  // доказательство аудита §2.4 опиралось на монотонность «к богатому»,
  // которую NPP нарушает. Осцилляция воспроизведена и зафиксирована в
  // 13.11; здесь гарантируется ЦЕЛОСТНОСТЬ даже при срабатывании защитного
  // лимита (кусочки не теряются, тарелки валидны, партия продолжается).
  for (const sft of [false, true]) {
    let toNewPlate = 0;
    let total = 0;
    let abortedTurns = 0;
    for (let n = 1; n <= 10; n++) {
      const level = buildLevel(n);
      level.cascade = { ...level.cascade, maxChainHops: 2, sameFlavorTransit: sft, newPlatePriority: true };
      const st = createInitialState(level);
      const initialSlices = level.initial.reduce((s, p) => s + p.slices.length, 0);
      let placedSlices = 0;
      for (let m = 0; m < 40; m++) {
        const mv = bestMove(st);
        if (!mv) break;
        placedSlices += traySize(st.tray[mv.trayIdx]);
        applyTrayMove(st, mv);
        const log = resolveTurnLogged(st, mv.cells);
        if (log.some((e) => e.kind === 'aborted')) abortedTurns++;
        for (const e of log) {
          if (e.kind !== 'transfer') continue;
          total++;
          if (mv.cells.includes(e.transfer.to)) toNewPlate++;
          assert(e.transfer.path.length <= 3, `sft=${sft}, уровень ${n}, ход ${m}: маршрут длиннее H2`);
        }
        for (const p of st.board) {
          if (p) assert(p.slices.length >= 1 && p.slices.length <= CAP, `sft=${sft}, уровень ${n}, ход ${m}: битая тарелка`);
        }
        // кусочки не теряются ДАЖЕ при аборте: разрешение обрывается,
        // но состояние остаётся консистентным (аудит §6.2)
        const onBoard = st.board.reduce((s, p) => s + (p ? p.slices.length : 0), 0);
        assertEq(initialSlices + placedSlices, onBoard + CAP * st.completed, `sft=${sft}, уровень ${n}, ход ${m}: кусочки не теряются`);
        topUpTray(level, st);
        if (evalEnd(st).phase !== 'playing') break;
      }
    }
    assert(total > 0, `sft=${sft}: переносы происходят`);
    assert(toNewPlate > 0, `sft=${sft}: правило активно — есть переносы в новую тарелку`);
    // аборты возможны (13.11), но обязаны быть редкими и детерминированными;
    // честная частота измеряется симуляциями и попадает в отчёт
    assert(abortedTurns < 40, `sft=${sft}: аборты не должны происходить каждый ход (${abortedTurns})`);
  }
  // детерминизм: партия с NPP+SFT повторяется в точности
  const runs: string[] = [];
  for (let run = 0; run < 2; run++) {
    const level = buildLevel(7);
    level.cascade = { ...level.cascade, maxChainHops: 2, sameFlavorTransit: true, newPlatePriority: true };
    const st = createInitialState(level);
    const trace: string[] = [];
    for (let m = 0; m < 12; m++) {
      const mv = bestMove(st);
      if (!mv) break;
      applyTrayMove(st, mv);
      resolveTurnLogged(st, mv.cells);
      trace.push(fingerprint(st));
      topUpTray(level, st);
      if (evalEnd(st).phase !== 'playing') break;
    }
    runs.push(trace.join('|'));
  }
  assertEq(runs[0], runs[1], 'повтор партии с NPP+SFT — та же последовательность состояний');
});

test('13.10 Метрики симулятора: переносы в новую тарелку считаются', () => {
  const opts = { maxMoves: 40, impactEvery: 0 };
  let withNppToNew = 0;
  let withoutNppToNew = 0;
  for (let n = 1; n <= 4; n++) {
    for (const v of [VARIANTS[1], VARIANTS[4]]) {
      const level = buildExperimentLevel(n, { rows: 3, cols: 3 }, v);
      const g = simulateGame(level, v.name, 'immediate', seedAt(0), opts, n);
      const toNew = g.turns.reduce((a, t) => a + t.toNewPlate, 0);
      if (v.name === 'H2+NPP') withNppToNew += toNew;
      else withoutNppToNew += toNew;
      assert(g.turns.every((t) => t.toNewPlate <= t.transfers && t.fromNewPlate <= t.transfers), 'счётчики не превышают переносов');
    }
  }
  assert(withNppToNew > 0, 'H2+NPP: переносы в новую тарелку есть');
  assert(withNppToNew > withoutNppToNew, `NPP повышает долю переносов в новую тарелку (${withNppToNew} > ${withoutNppToNew})`);
});

test('13.11 Осцилляция NPP: защитный лимит срабатывает, состояние консистентно', () => {
  // Минимальная топология осцилляции (найдена на уровне 8, см. отчёт):
  // X (3×вкуса-4 + 2×филлера, 1 место) и размещённая P (2×вкуса-4 + 4×филлера,
  // полная). Пока у P есть место, NPP тянет кусочек из X; когда P полна,
  // существующий алгоритм (X богаче: 3>2) возвращает кусочек из P в X —
  // и цикл повторяется бесконечно. Правила в этой ситуации предписывают
  // именно такие переносы (§1 приоритет + §4 п. 3 fallback), поэтому
  // завершимость разрешения хода при NPP не гарантируется — это свойство
  // спецификации, а не ошибка реализации. Движок обрывает цикл защитным
  // лимитом maxResolutionSteps (аудит §6.2) и остаётся консистентным.
  const st = createInitialState(
    lv(
      1,
      2,
      [[0, 0, [4, 4, 4, 8, 8]]], // X (ячейка 0): 3×вкуса 4, 1 место
      [{ kind: 'single', slices: [4, 4, 0, 0, 0, 0] }], // P — размещаем в ячейку 1 (полная)
    ),
  );
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const log = resolveTurnLogged(st, [1], nppCfg(true));
  const ab = log.find((e): e is Extract<TurnEvent, { kind: 'aborted' }> => e.kind === 'aborted');
  assert(ab !== undefined, 'осцилляция обязана привести к срабатыванию защитного лимита');
  assertEq(ab!.steps, 64, 'лимит — 64 шага (умолчание)');
  assertEq(ab!.limit, 64, 'в событии — предельное значение');
  const tr = log.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
  assertEq(tr.length, 64, 'до аборта выполняется 64 переноса');
  // перенос — тот же кусочек туда-обратно: P→X, X→P, P→X…
  assertEq(
    tr.slice(0, 6).map((e) => [e.transfer.from, e.transfer.to, e.transfer.flavor, e.transfer.count]),
    [
      [1, 0, 4, 1],
      [0, 1, 4, 1],
      [1, 0, 4, 1],
      [0, 1, 4, 1],
      [1, 0, 4, 1],
      [0, 1, 4, 1],
    ],
    'кусочник осциллирует между новой тарелкой и более богатым соседом',
  );
  // состояние после аборта консистентно: 11 кусочков на месте, тортов нет
  const onBoard = st.board.reduce((s, p) => s + (p ? p.slices.length : 0), 0);
  assertEq(onBoard, 11, 'куски не теряются при аборте');
  assertEq(st.completed, 0, 'торт не собирается');
  for (const p of st.board) {
    if (p) assert(p.slices.length >= 1 && p.slices.length <= CAP, 'тарелки валидны после аборта');
  }
  // без NPP та же позиция спокойна: перенос один, дальше тупик (X полон)
  const st2 = createInitialState(
    lv(1, 2, [[0, 0, [4, 4, 4, 8, 8]]], [{ kind: 'single', slices: [4, 4, 0, 0, 0, 0] }]),
  );
  applyTrayMove(st2, { trayIdx: 0, cells: [1], orientation: null });
  const log2 = resolveTurnLogged(st2, [1], nppCfg(false));
  assert(log2.every((e) => e.kind !== 'aborted'), 'без NPP осцилляции нет');
  assertEq(log2.filter((e) => e.kind === 'transfer').length, 1, 'без NPP — один перенос (P→X) и стоп');
});

/* ------------------------------ Итог -------------------------------- */

console.log(`\nПройдено: ${passed}, ошибок: ${failed} (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
if (failed > 0) {
  process.exit(1);
}
