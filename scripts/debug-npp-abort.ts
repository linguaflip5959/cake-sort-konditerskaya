/**
 * Отладка: почему при newPlatePriority=true на уровне 8 срабатывает
 * защитный лимит maxResolutionSteps? Печатаем ходы с событием aborted
 * и последовательность переносов внутри такого хода.
 */
import { applyTrayMove, bestMove, createInitialState, evalEnd, resolveTurnLogged } from '../src/puzzle/game/rules';
import { buildLevel, topUpTray } from '../src/puzzle/game/generator';
import { traySize, type TurnEvent } from '../src/puzzle/game/types';

const n = Number(process.argv[2] ?? 8);
const level = buildLevel(n);
level.cascade = { ...level.cascade, maxChainHops: 2, sameFlavorTransit: false, newPlatePriority: true };
const st = createInitialState(level);

for (let m = 0; m < 40; m++) {
  const mv = bestMove(st);
  if (!mv) break;
  applyTrayMove(st, mv);
  const log = resolveTurnLogged(st, mv.cells);
  const aborted = log.find((e) => e.kind === 'aborted');
  if (aborted) {
    console.log(`Ход ${m} (размещение в ${mv.cells.join(',')}): ABORTED после ${aborted.steps} шагов`);
    const transfers = log.filter((e): e is Extract<TurnEvent, { kind: 'transfer' }> => e.kind === 'transfer');
    console.log(`Переносов до аборта: ${transfers.length}`);
    // печатаем последние 24 переноса — ищем цикл
    for (const t of transfers.slice(-24)) {
      console.log(
        `  ${t.transfer.from}→${t.transfer.to} вкус ${t.transfer.flavor} кол-во ${t.transfer.count} путь [${t.transfer.path.join(',')}]`,
      );
    }
    const ab = aborted as Extract<TurnEvent, { kind: 'aborted' }>;
    console.log('Снимок поля при аборте:', ab.snapshot);
    break;
  }
  topUpTray(level, st);
  if (evalEnd(st).phase !== 'playing') break;
}
