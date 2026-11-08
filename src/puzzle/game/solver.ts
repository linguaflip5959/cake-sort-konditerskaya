/**
 * Cake Sort — «Кондитерская»
 * Слой 2: солвер (DFS с мемоизацией и «жадной» эвристикой).
 *
 * Перебирает размещения видимого окна очереди: для обычной тарелки — все
 * свободные ячейки, для двойной — все пары свободных соседних ячеек во всех
 * ориентациях (ТЗ итерации 2, п. 3.7). Ключ мемоизации учитывает двойные
 * тарелки в очереди.
 */

import { applyTrayMove, cloneState, evalEnd, legalMoves, resolveTurn, type Move } from './rules';
import type { Flavor, GState, TrayItem } from './types';

/** Ход решения: элемент очереди, ячейки размещения и ориентация (для двойной) */
export type SolveMove = Move;

function trayKey(item: TrayItem): string {
  if (item.kind === 'single') return `S${item.slices.join('.')}`;
  const ka = item.a.join('.');
  const kb = item.b.join('.');
  // Половинки A|B и B|A дают одно и то же множество будущих состояний —
  // нормализуем, чтобы мемоизация не дублировала их.
  return ka <= kb ? `D${ka}|${kb}` : `D${kb}|${ka}`;
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
  return `${parts.join('|')}#${s.tray.map(trayKey).join(';')}`;
}

/**
 * Найти последовательность размещений, приводящую к победе.
 * Порядок перебора — по эвристике: сначала ходы, которые сразу собирают
 * торты и запускают автопереносы. Возвращает null, если решение не
 * найдено в пределах бюджета узлов.
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

    const moves = legalMoves(s);
    const candidates: Array<{ mv: SolveMove; next: GState; score: number }> = [];
    for (const mv of moves) {
      const next = cloneState(s);
      applyTrayMove(next, mv);
      const rep = resolveTurn(next, mv.cells);
      candidates.push({ mv, next, score: rep.cakes * 1000 + rep.transfers * 10 });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const cand of candidates) {
      path.push(cand.mv);
      if (dfs(cand.next)) return true;
      path.pop();
      if (nodes >= budget) return false;
    }
    return false;
  };

  return dfs(cloneState(start)) ? [...path] : null;
}
