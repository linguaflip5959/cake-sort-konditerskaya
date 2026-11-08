/**
 * Cake Sort — «Кондитерская»
 * Слой 2: доступ к уровням (итерация 3).
 *
 * Все уровни собирает генератор: стол 3×3, цель в очках, бесконечная
 * выдача из детерминированного потока. Уровней бесконечно много,
 * «застрять на нерешаемом» невозможно — материал не кончается.
 */

import type { LevelData } from './types';
import { buildLevel } from './generator';

export { buildLevel, levelConfig, targetFor, peekStream, topUpTray, LEVEL_ROWS, LEVEL_COLS } from './generator';

/**
 * Уровень по 0-индексу (движок хранит levelIdx, сейв — level-1).
 * getLevel(i) === buildLevel(i + 1); генерация мгновенная, без кеша.
 */
export function getLevel(index: number): LevelData {
  return buildLevel(Math.max(0, Math.floor(index)) + 1);
}
