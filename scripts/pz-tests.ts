/**
 * Cake Sort — «Кондитерская»: автотесты игрового слоя (ТЗ итерации 2, п. 6).
 * Запуск: npm test (tsx scripts/pz-tests.ts). Three.js и GSAP не нужны.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adjacentFreePairs,
  applyTrayMove,
  canPlace,
  canPlaceDoubleAt,
  chooseRecipient,
  createInitialState,
  evalEnd,
  legalMoves,
  planNextTransfer,
  resolveTurn,
  totalCakes,
} from '../src/puzzle/game/rules';
import { FIXED_LEVELS, getLevel, solve } from '../src/puzzle/game/levels';
import { generateLevel, randomPlayWins } from '../src/puzzle/game/generator';
import { CAP, trayFlavors, type Flavor, type LevelData, type TrayItem } from '../src/puzzle/game/types';

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

function assert(cond: unknown, msg: string): void {
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

/** Уровень «на лету» для сценарных тестов */
function lv(rows: number, cols: number, initial: Array<[number, number, Flavor[]]>, tray: TrayItem[]): LevelData {
  return {
    rows,
    cols,
    initial: initial.map(([row, col, slices]) => ({ row, col, slices })),
    tray,
  };
}

console.log('Cake Sort — Кондитерская: автотесты игрового слоя\n');

/* ------------------- 1. Кратность 6 (уровни 1–100) ------------------ */

test('1. Кратность 6: каждый вкус во всех уровнях 1–100', () => {
  for (let i = 0; i < 100; i++) {
    const level = getLevel(i);
    const counts = new Map<Flavor, number>();
    for (const p of level.initial) for (const f of p.slices) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (const it of level.tray) for (const f of trayFlavors(it)) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (const [f, c] of counts) {
      assert(c % CAP === 0, `уровень ${i + 1}: вкус ${f} встречается ${c} раз (не кратно 6)`);
    }
    assert(totalCakes(level) >= 1, `уровень ${i + 1}: нет ни одного торта`);
  }
});

/* ------------------------ 2. Решаемость 1–100 ----------------------- */

test('2. Решаемость: solve() находит решение на уровнях 1–100', () => {
  for (let i = 0; i < 100; i++) {
    const sol = solve(createInitialState(getLevel(i)));
    assert(sol !== null, `уровень ${i + 1}: солвер не нашёл решение`);
  }
});

/* --------------------- 3. Детерминизм генератора -------------------- */

test('3. Детерминизм: номер уровня даёт один и тот же LevelData', () => {
  const probeLevels = [4, 5, 7, 12, 21, 40];
  const inProcess = probeLevels.map((n) => JSON.stringify(generateLevel(n)));

  // отдельные процессы: исключаем влияние кеша модуля и порядка вызовов
  const dir = mkdtempSync(join(tmpdir(), 'pz-det-'));
  try {
    const probe = join(dir, 'probe.ts');
    const genUrl = new URL('../src/puzzle/game/generator.ts', import.meta.url).href;
    writeFileSync(
      probe,
      `import { generateLevel } from '${genUrl}';\n` +
        `const out = [4, 5, 7, 12, 21, 40].map((n) => JSON.stringify(generateLevel(n)));\n` +
        `console.log(JSON.stringify(out));\n`,
    );
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const runA = execSync(`npx tsx "${probe}"`, { cwd, encoding: 'utf8' }).trim();
    const runB = execSync(`npx tsx "${probe}"`, { cwd, encoding: 'utf8' }).trim();
    assertEq(runA, runB, 'два запуска в отдельных процессах дали разные уровни');
    assertEq(JSON.parse(runA), inProcess, 'уровни в отдельном процессе отличаются от основного процесса');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------- 4. Качество рандома (4–50) ------------------- */

test('4. Случайная игра: доля побед ниже порога (уровни 4–50, 1000 партий)', () => {
  for (let i = 3; i < 50; i++) {
    const levelNumber = i + 1;
    const level = getLevel(i);
    const wins = randomPlayWins(level, 1000, levelNumber * 7919);
    const limit = levelNumber >= 11 ? 10 : 30; // 1% на сложных, 3% на остальных
    assert(wins <= limit, `уровень ${levelNumber}: случайных побед ${wins}/1000, лимит ${limit}`);
  }
});

test('4b. Рост сложности: средняя длина решения не убывает (полосы уровней)', () => {
  const band = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i <= to; i++) sum += solve(createInitialState(getLevel(i)))?.length ?? 0;
    return sum / (to - from + 1);
  };
  const b1 = band(3, 9); // уровни 4–10
  const b2 = band(10, 19); // уровни 11–20
  const b3 = band(20, 29); // уровни 21–30
  assert(b2 >= b1 - 0.5, `средняя длина решения упала: 4–10 → ${b1.toFixed(1)}, 11–20 → ${b2.toFixed(1)}`);
  assert(b3 >= b2 - 0.5, `средняя длина решения упала: 11–20 → ${b2.toFixed(1)}, 21–30 → ${b3.toFixed(1)}`);
  console.log(`      средняя длина решения: 4–10: ${b1.toFixed(1)}, 11–20: ${b2.toFixed(1)}, 21–30: ${b3.toFixed(1)}`);
});

test('4c. Скорость генерации: в среднем не более ~450 мс на уровень', () => {
  const started = Date.now();
  const from = 101; // уровни вне диапазона остальных тестов — точно не в кеше
  const to = 110;
  for (let n = from; n <= to; n++) generateLevel(n);
  const perLevel = (Date.now() - started) / (to - from + 1);
  console.log(`      среднее время генерации (уровни ${from}–${to}): ${perLevel.toFixed(0)} мс`);
  assert(perLevel <= 450, `генерация слишком медленная: ${perLevel.toFixed(0)} мс на уровень`);
});

/* ------------------------ 5. Двойная тарелка ------------------------ */

test('5.1 Двойная тарелка: размещения только на пары свободных соседей', () => {
  const level = lv(2, 2, [], [{ kind: 'double', a: [0, 0], b: [1, 1] }]);
  const st = createInitialState(level);
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
  // горизонтальная пара: 0 — A слева, 2 — A справа
  const horiz = legalMoves(createInitialState(lv(1, 2, [], [{ kind: 'double', a: [0], b: [1] }])));
  assertEq(
    horiz.map((m) => [m.orientation, m.cells]).sort(),
    [[0, [0, 1]], [2, [1, 0]]],
    'горизонтальные ориентации',
  );
  // вертикальная пара: 1 — A сверху, 3 — A снизу
  const vert = legalMoves(createInitialState(lv(2, 1, [], [{ kind: 'double', a: [0], b: [1] }])));
  assertEq(
    vert.map((m) => [m.orientation, m.cells]).sort(),
    [[1, [0, 1]], [3, [1, 0]]],
    'вертикальные ориентации',
  );
  // на свободном поле 2×2 встречаются все четыре состояния
  const all = legalMoves(createInitialState(lv(2, 2, [], [{ kind: 'double', a: [0], b: [1] }])));
  for (const o of [0, 1, 2, 3] as const) {
    assert(all.some((m) => m.orientation === o), `ориентация ${o} не встретилась`);
  }
});

test('5.3 После размещения половинки ведут себя как независимые тарелки', () => {
  // поле 1×3: слева тарелка из пяти «5», очередь: двойная A=[0×5], B=[5] и обычная [0]
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
  // ставим двойную так, что B=[5] — к начальной тарелке, A=[0×5] — отдельно
  applyTrayMove(st, { trayIdx: 0, cells: [2, 1], orientation: 2 });
  resolveTurn(st, [2, 1]);
  // B собралась с начальной в торт и освободила ячейку, A осталась с пятью «0»
  assert(st.board[1] === null, 'ячейка B не освободилась после сборки торта');
  assertEq(st.board[2]?.slices.map((s) => s.flavor), [0, 0, 0, 0, 0], 'A должна остаться с пятью кусочками');
  // обычной тарелкой докрываем торт A — половинки действительно независимы
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurn(st, [1]);
  assert(evalEnd(st).phase === 'won', 'уровень должен быть пройден');
});

test('5.4 Солвер учитывает ориентации двойной тарелки', () => {
  // 2×2: в ячейке 1 тарелка из пяти «0»; двойная A=[0], B=[1×6].
  // Выигрывает только размещение, где A оказывается рядом с пятёркой.
  const level = lv(
    2,
    2,
    [[0, 1, [0, 0, 0, 0, 0]]],
    [{ kind: 'double', a: [0], b: [1, 1, 1, 1, 1, 1] }],
  );
  const sol = solve(createInitialState(level));
  assert(sol !== null && sol.length === 1, 'солвер не нашёл решение в один ход');
  const mv = sol[0];
  assert(mv.orientation === 1 || mv.orientation === 2, `выигрышная ориентация ${mv.orientation}, ожидалась 1 или 2`);
  const st = createInitialState(level);
  applyTrayMove(st, mv);
  resolveTurn(st, mv.cells);
  assert(evalEnd(st).phase === 'won', 'ход солвера не привёл к победе');
  // неправильная ориентация (A далеко от пятёрки) ведёт к поражению
  const wrong = legalMoves(createInitialState(level)).find((m) => m.orientation === 0);
  assert(wrong, 'нет хода с ориентацией 0');
  const st2 = createInitialState(level);
  applyTrayMove(st2, wrong);
  resolveTurn(st2, wrong.cells);
  assert(evalEnd(st2).phase === 'lost', 'неправильная ориентация не должна выигрывать');
});

/* --------------------------- 6. Сортировка -------------------------- */

test('6.1 Простое совпадение: кусочки уходят к размещённой тарелке', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0, 0]]], [{ kind: 'single', slices: [0, 0, 0] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  const t = planNextTransfer(st, [1]);
  assert(t !== null && t.to === 1 && t.from === 0 && t.count === 3, 'получатель — размещённая тарелка (правило хода)');
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

test('6.3 Диагональ: не соседи — переноса нет', () => {
  const st = createInitialState(lv(2, 2, [[0, 0, [0, 0, 0]], [1, 1, [0, 0, 0]]], []));
  assert(planNextTransfer(st, []) === null, 'диагональные тарелки не должны обмениваться');
});

test('6.4 Вместимость: перенос ограничен свободным местом', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0, 0, 0, 0]]], [{ kind: 'single', slices: [0, 0] }]));
  applyTrayMove(st, { trayIdx: 0, cells: [1], orientation: null });
  resolveTurn(st, [1]);
  // получатель (5 кусочков) взял только 1 и стал тортом, у размещённой остался 1
  assertEq(st.completed, 1, 'начальная тарелка должна стать тортом');
  assert(st.board[0] === null, 'ячейка торта должна освободиться');
  assertEq(st.board[1]?.slices.length, 1, 'перенос должен ограничиться свободным местом');
});

test('6.5 Детерминизм: одинаковый вход — одинаковый результат', () => {
  const run = (): string => {
    const st = createInitialState(getLevel(6)); // сгенерированный уровень
    let moves = 0;
    for (;;) {
      const end = evalEnd(st);
      if (end.phase !== 'playing') break;
      const sol = solve(st);
      assert(sol !== null && sol.length > 0, 'нет решения');
      applyTrayMove(st, sol[0]);
      resolveTurn(st, sol[0].cells);
      moves++;
      if (moves > 30) throw new Error('слишком много ходов');
    }
    return JSON.stringify({
      moves,
      tray: st.tray,
      board: st.board.map((p) => (p ? p.slices.map((s) => s.flavor) : null)),
    });
  };
  assertEq(run(), run(), 'повторная партия должна пройти одинаково');
});

test('6.6 Приоритет при размещении двух тарелок за ход', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [4, 4, 4]], [0, 1, [4, 4, 4]]], []));
  // равенство счётчиков: размещённая в текущем ходе побеждает
  assertEq(chooseRecipient(st, 0, 1, 4, [1]), 1, 'размещённая ячейка 1 должна победить');
  assertEq(chooseRecipient(st, 0, 1, 4, [0]), 0, 'размещённая ячейка 0 должна победить');
  // обе размещены (двойная тарелка) — меньший индекс ячейки
  assertEq(chooseRecipient(st, 0, 1, 4, [0, 1]), 0, 'при двух размещённых побеждает меньший индекс');
  assertEq(chooseRecipient(st, 0, 1, 4, [1, 0]), 0, 'порядок в lastPlaced не должен влиять');
  // ничего не размещено — меньший индекс
  assertEq(chooseRecipient(st, 0, 1, 4, []), 0, 'без размещённых — меньший индекс');
});

/* ------------------------- 7. Конец партии -------------------------- */

test('7.1 Поражение: только двойные в окне, пар нет', () => {
  // диагональные свободные ячейки: пары не образуются
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
      ],
    ),
  );
  assertEq(adjacentFreePairs(st).length, 0, 'диагональные ячейки не должны давать пары');
  assertEq(evalEnd(st), { phase: 'lost', reason: 'full' }, 'должно быть поражение full');
});

test('7.2 В окне есть обычная тарелка — игра продолжается', () => {
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

test('7.3 Поражение leftover: очередь пуста, на поле остаток', () => {
  const st = createInitialState(lv(1, 2, [[0, 0, [0, 0]]], []));
  assertEq(evalEnd(st), { phase: 'lost', reason: 'leftover' }, 'остаток без очереди — поражение');
});

/* ---------------------- 8. Обучающие уровни ------------------------- */

test('8. Обучающие уровни 1–3 (ТЗ п. 4)', () => {
  assertEq(FIXED_LEVELS.length, 3, 'фиксированных уровней должно быть три');
  const sizes: Array<[number, number]> = [
    [FIXED_LEVELS[0].rows, FIXED_LEVELS[0].cols],
    [FIXED_LEVELS[1].rows, FIXED_LEVELS[1].cols],
    [FIXED_LEVELS[2].rows, FIXED_LEVELS[2].cols],
  ];
  assertEq(sizes, [[2, 3], [2, 3], [3, 3]], 'поля 2×3, 2×3, 3×3');
  for (let i = 0; i < 3; i++) {
    const sol = solve(createInitialState(FIXED_LEVELS[i]));
    assert(sol !== null, `обучающий уровень ${i + 1} не решается`);
    assert(sol.length >= 3 && sol.length <= 6, `обучающий уровень ${i + 1}: решение из ${sol?.length} ходов (нужно 3–6)`);
  }
  const doubles = FIXED_LEVELS[2].tray.filter((it) => it.kind === 'double').length;
  assertEq(doubles, 1, 'на уровне 3 должна быть ровно одна двойная тарелка');
  // двойная видна сразу (окно 3)
  assert(FIXED_LEVELS[2].tray.slice(0, 3).some((it) => it.kind === 'double'), 'двойная должна быть в видимом окне');
});

test('8b. Сохранения: любой номер уровня допустим, getLevel не ломается', () => {
  assert(getLevel(0).rows === 2, 'уровень 1');
  assert(getLevel(2).rows === 3, 'уровень 3');
  const far = getLevel(42);
  assert(far.tray.length >= 5, 'далёкий уровень должен генерироваться');
  assert(canPlace(createInitialState(getLevel(42)), 0) || true, 'getLevel не должен бросать');
});

/* ------------------------------ Итог -------------------------------- */

console.log(`\nПройдено: ${passed}, ошибок: ${failed} (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
if (failed > 0) {
  process.exit(1);
}
