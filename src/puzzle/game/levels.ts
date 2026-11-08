/**
 * Cake Sort — «Кондитерская»
 * Слой 2: доступ к уровням и солвер.
 *
 * Уровни 1–3 — обучающие, заданы вручную в fixed.ts (ТЗ итерации 2, п. 4).
 * С уровня 4 уровни детерминированно генерируются по номеру и проверяются
 * солвером (generator.ts, ТЗ п. 2). Уровней бесконечно много.
 */

import type { LevelData } from './types';
import { FIXED_LEVELS } from './fixed';
import { generateLevel } from './generator';

export { solve } from './solver';
export type { SolveMove } from './solver';
export { FIXED_LEVELS } from './fixed';

/**
 * Уровень по 0-индексу (движок хранит levelIdx, сейв — level-1).
 * Индексы 0–2 — фиксированные, далее генерация по номеру levelIdx + 1.
 */
export function getLevel(index: number): LevelData {
  const i = Math.max(0, Math.floor(index));
  if (i < FIXED_LEVELS.length) return FIXED_LEVELS[i];
  return generateLevel(i + 1);
}
