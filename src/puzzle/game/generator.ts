/**
 * Cake Sort — «Кондитерская»
 * Слой 2: генератор уровней (итерация 3 — очки и бесконечная очередь).
 *
 * Уровня больше не «рассчитываются вручную» и не проверяются солвером:
 * собираем ОЧКИ, а не N тортов, поэтому уровень не может быть «нерешаемым»
 * в принципе — материал бесконечен. Поражение только одно: стол 3×3
 * забился до отказа. Сложность управляется конфигом: цель в очках, число
 * доступных вкусов, состав тарелок, двойные тарелки.
 *
 * Поток выдачи детерминирован: элемент с номером i вычисляется из
 * (seed уровня, i) без состояния — один и тот же уровень всегда раздаёт
 * одни и те же тарелки в одном порядке. Двойные тарелки встречаются не
 * чаще, чем одна на 7 элементов: в видимой выдаче (5) двойная всегда
 * максимум одна, а её половинки полноразмерные, как обычные тарелки.
 *
 * Прогрессия тортов: уровень n играет вкусами 0..min(FLAVOR_COUNT, n).
 * Прохождение уровня открывает следующий торт (карточка победы). Когда
 * открыты все — начинается «золотая серия»: карточка с золотым тортом.
 */

import {
  CAP,
  FLAVOR_COUNT,
  TRAY_BUFFER,
  WINDOW,
  type Flavor,
  type InitialPlate,
  type LevelData,
  type TrayItem,
  type TrayStream,
} from './types';

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

/** Детерминированный хеш пары чисел */
function hash2(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 2654435761) ^ Math.imul(b ^ 0x85ebca6b, 2246822519)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/* ------------------------------------------------------------------ */
/* Конфиг уровня                                                       */
/* ------------------------------------------------------------------ */

export interface LevelConfig {
  /** цель уровня в очках */
  target: number;
  /** вкусы уровня (пул выдачи): не больше MAX_POOL, всегда включает новинку */
  flavors: Flavor[];
  /** всего открыто вкусов (для карточек/коллекции) */
  unlockedCount: number;
  /** торт, открываемый за прохождение (карточка победы) */
  unlockFlavor: number;
  /** золотая серия: все вкусы открыты, карточка — золотой торт */
  golden: boolean;
  /** начальных тарелок на столе */
  initialCount: number;
  /** двойные тарелки в потоке */
  doubles: boolean;
  /** редкие «почти торты» (5 кусочков одного вкуса) */
  heavy: boolean;
  /** макс. дальность цепочки в «прыжках» (Этап B, аудит §6.3):
   *  Infinity — обучение (длинные эффектные цепочки),
   *  2 — один транзит: головоломка «прокладывания маршрута» */
  maxChainHops: number;
  /** сид потока */
  seed: number;
}

/** Максимум вкусов в пуле уровня: с большим числом вкусов слияния
 *  становятся редкими и стол гарантированно забивается. Сложность
 *  растёт за счёт цели и состава тарелок, а не числа вкусов. */
export const MAX_POOL = 6;

/** Цель уровня в очках: мягкий рост с насыщением.
 *  Этап B: кривая сохранена — калибровка (scripts/tune-targets.ts)
 *  показала, что при согласованной оценке (подсказка играет правилами
 *  уровня) жадный берёт цель на всех уровнях, а случайный выигрывает
 *  ~43% — коридор аудита §8.2 выполняется без перенастройки. */
export function targetFor(n: number): number {
  return Math.min(1200, 250 + 60 * (n - 1));
}

/** Обучающие уровни: цепочки без ограничения дальности (аудит §6.3) */
export const TRAINING_LEVELS = 5;

/** Конфиг уровня по 1-номеру n */
export function levelConfig(n: number): LevelConfig {
  const N = Math.max(1, Math.floor(n));
  // вкусы 0..unlocked-1 доступны в игре; уровень n открывает вкус n+1
  const unlocked = Math.min(FLAVOR_COUNT, N + 1);
  const golden = N + 1 >= FLAVOR_COUNT; // открывать больше нечего
  const unlockFlavor = golden ? (Math.imul(N, 7) + 3) % FLAVOR_COUNT : N + 1;
  // новинка уровня: только что открытый прошлым уровнем вкус; в золотой
  // серии — тот самый торт, что показан на карточке (в золотом исполнении)
  const featured = golden ? unlockFlavor : unlocked - 1;

  // пул: маленький в начале, максимум MAX_POOL; новинка — всегда в игре
  const poolSize = Math.min(MAX_POOL, unlocked);
  const rng = mulberry32(hash2(N, 0x2545f491));
  const candidates: Flavor[] = [];
  for (let i = 0; i < unlocked; i++) if (i !== featured) candidates.push(i);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const flavors: Flavor[] = [featured, ...candidates.slice(0, poolSize - 1)];
  flavors.sort((a, b) => a - b);

  return {
    target: targetFor(N),
    flavors,
    unlockedCount: unlocked,
    unlockFlavor,
    golden,
    initialCount: N <= 2 ? 2 : 3,
    doubles: N >= 3,
    heavy: N >= 4,
    // Этап B: обучение на длинных цепочках, дальше — два прыжка (один
    // транзит); порог совпадает с выходом пула вкусов на максимум (6)
    maxChainHops: N <= TRAINING_LEVELS ? Infinity : 2,
    seed: hash2(N, 0x51ed270b),
  };
}

/* ------------------------------------------------------------------ */
/* Состав тарелок                                                      */
/* ------------------------------------------------------------------ */

/**
 * Одна тарелка потока: обычно 2–3 вкуса по 1–2 кусочка (4-й вкус — редкая
 * роскошь на поздних уровнях), иногда чистая тарелка на 1–2 кусочка и
 * совсем редко — «почти торт» из 5 одинаковых (cfg.heavy).
 */
function plateSlices(rng: () => number, cfg: { flavors: Flavor[]; heavy: boolean }, maxSlices: number): Flavor[] {
  const F = cfg.flavors;

  // «почти торт» — редкий подарок: 5 кусочков одного вкуса
  if (cfg.heavy && rng() < 0.025 && maxSlices >= 5) {
    return new Array(5).fill(pick(rng, F));
  }

  // чистая тарелка: 1–2 кусочка одного вкуса — топливо для слияний
  if (rng() < 0.09) {
    const f = pick(rng, F);
    return new Array(1 + Math.floor(rng() * 2)).fill(f);
  }

  // обычная тарелка: 2 вкуса, на просторных уровнях — 3, изредка 4
  const wide = F.length >= 8;
  let distinct = 2;
  const r = rng();
  if (r < (wide ? 0.34 : 0.16)) distinct = 3;
  if (wide && r > 0.93) distinct = 4;
  distinct = Math.min(distinct, Math.max(2, maxSlices - 1), F.length);

  const chosen: Flavor[] = [];
  while (chosen.length < distinct) {
    const f = pick(rng, F);
    if (!chosen.includes(f)) chosen.push(f);
  }

  const out: Flavor[] = [];
  for (const f of chosen) {
    // по 1–2 кусочка; тройка — редкость (не «полторта одним вкусом»)
    let k = rng() < 0.62 ? 1 : 2;
    if (k === 2 && rng() < 0.12) k = 3;
    while (k > 0 && out.length + k > maxSlices) k--;
    if (k <= 0) continue;
    for (let i = 0; i < k; i++) out.push(f);
  }
  if (out.length === 0) out.push(pick(rng, F));
  return out;
}

/** Элемент потока с номером i: детерминирован (seed, i) */
function streamItem(seed: number, i: number, cfg: { flavors: Flavor[]; doubles: boolean; heavy: boolean }): TrayItem {
  const rng = mulberry32(hash2(seed, i));
  // двойные: с 6-го элемента, не чаще одной на 7 позиций
  if (cfg.doubles && i >= 6 && i % 7 === 3 && rng() < 0.8) {
    return {
      kind: 'double',
      a: plateSlices(rng, cfg, 4),
      b: plateSlices(rng, cfg, 4),
    };
  }
  return { kind: 'single', slices: plateSlices(rng, cfg, 5) };
}

/* ------------------------------------------------------------------ */
/* Сборка уровня                                                       */
/* ------------------------------------------------------------------ */

/** Поле уровня: всегда 3×3 (ТЗ итерации 3) */
export const LEVEL_ROWS = 3;
export const LEVEL_COLS = 3;

/**
 * Уровень по 1-номеру: стол 3×3, начальные тарелки, первая выдача
 * (WINDOW + TRAY_BUFFER элементов) и бесконечный поток с сидом.
 */
export function buildLevel(n: number): LevelData {
  return buildLevelSized(n, LEVEL_ROWS, LEVEL_COLS);
}

/**
 * Уровень на поле произвольного размера (nextStep §4.1: «размер поля не
 * должен быть жёстко привязан к генератору»). Конфигурация, состав потока
 * и сид совпадают с buildLevel(n) — различаются только геометрия поля и
 * раскладка начальных тарелок. Выдача (tray/stream) от размера поля не
 * зависит: одинаковые уровни на разных полях раздают один и тот же материал.
 *
 * Игровой код продолжает использовать buildLevel (3×3); функция — для
 * симулятора сравнения механик и будущей прогрессии размеров.
 */
export function buildLevelSized(n: number, rows: number, cols: number): LevelData {
  const cfg = levelConfig(n);
  const rng = mulberry32(cfg.seed);

  // начальные тарелки: 2–3 штуки в случайных разных ячейках поля rows×cols
  const cells = new Array(rows * cols).fill(0).map((_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const initial: InitialPlate[] = [];
  for (let k = 0; k < cfg.initialCount; k++) {
    const cell = cells[k];
    initial.push({
      row: Math.floor(cell / cols),
      col: cell % cols,
      slices: plateSlices(rng, cfg, 5),
    });
  }

  const stream: TrayStream = {
    seed: cfg.seed,
    next: WINDOW + TRAY_BUFFER,
    flavors: cfg.flavors,
    doubles: cfg.doubles,
    heavy: cfg.heavy,
  };
  const tray: TrayItem[] = [];
  for (let i = 0; i < WINDOW + TRAY_BUFFER; i++) {
    tray.push(streamItem(stream.seed, i, stream));
  }

  return {
    rows,
    cols,
    initial,
    tray,
    target: cfg.target,
    unlockFlavor: cfg.unlockFlavor,
    stream,
    // Этап B: конфигурация цепной реакции уровня (дальность цепочки)
    cascade: { maxChainHops: cfg.maxChainHops },
  };
}

/**
 * Пополнить очередь из потока: в состоянии всегда WINDOW + TRAY_BUFFER
 * элементов (5 видимых + запас). Вызывается движком после каждого хода.
 */
export function topUpTray(level: LevelData, state: { tray: TrayItem[] }): void {
  const stream = level.stream;
  if (!stream) return;
  while (state.tray.length < WINDOW + TRAY_BUFFER) {
    state.tray.push(streamItem(stream.seed, stream.next++, stream));
  }
}

/* ------------------------------------------------------------------ */
/* Диагностика (тесты)                                                 */
/* ------------------------------------------------------------------ */

/** Первые count элементов потока уровня — без изменения состояния */
export function peekStream(n: number, count: number): TrayItem[] {
  const cfg = levelConfig(n);
  const out: TrayItem[] = [];
  for (let i = 0; i < count; i++) out.push(streamItem(cfg.seed, i, cfg));
  return out;
}

/** Проверка вместимости тарелки (диагностика генератора) */
export function slicesFit(slices: Flavor[]): boolean {
  return slices.length >= 1 && slices.length <= CAP;
}
