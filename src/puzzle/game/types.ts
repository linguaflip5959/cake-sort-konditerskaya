/**
 * Cake Sort — «Кондитерская»
 * Слой 1 (ТЗ п. 9.1): игровые данные. Чистые типы без Three.js и GSAP.
 *
 * Итерация 3 — механика очков: собираем не «N тортов», а N очков. Торты и
 * слияния дают очки; при достижении цели уровень пройден и открывается
 * новый торт. Очередь — бесконечный поток (выдача 5), поле 3×3.
 */

/** Вместимость тарелки: 6 кусочков = целый торт (ТЗ п. 3.1) */
export const CAP = 6;

/** Видимая выдача очереди: 5 тарелок (ТЗ итерации 3) */
export const WINDOW = 5;

/** Сколько элементов держать в очереди про запас (за видимой выдачей) */
export const TRAY_BUFFER = 2;

/**
 * Число видов тортов в игре. Вкусы — индексы CAKE_TYPES (визуальный слой);
 * открытие: уровень n играет вкусами 0..min(FLAVOR_COUNT, n).
 * CAKE_TYPES обязан содержать ровно столько же записей (проверка в cakes.ts).
 */
export const FLAVOR_COUNT = 16;

/** Тип торта — индекс в CAKE_TYPES (визуальный слой). Не «произвольный цвет» (ТЗ п. 3.2) */
export type Flavor = number;

/** Ячейка поля: row * cols + col */
export type CellIndex = number;

/**
 * Ориентация двойной тарелки (ТЗ итерации 2, п. 3.4), шаг поворота 90°:
 * 0 — горизонтально, A слева;  1 — вертикально, A сверху;
 * 2 — горизонтально, A справа; 3 — вертикально, A снизу.
 */
export type Orientation = 0 | 1 | 2 | 3;

export interface SliceRef {
  id: number;
  flavor: Flavor;
}

export interface InitialPlate {
  row: number;
  col: number;
  /** 1..6 кусочков */
  slices: Flavor[];
}

/**
 * Элемент очереди (ТЗ итерации 2, п. 3.2):
 * обычная тарелка или двойная — две жёстко соединённые тарелки.
 */
export type TrayItem =
  | { kind: 'single'; slices: Flavor[] }
  | { kind: 'double'; a: Flavor[]; b: Flavor[] };

/** Все кусочки элемента очереди (для двойной — обе половинки) */
export function trayFlavors(item: TrayItem): Flavor[] {
  return item.kind === 'single' ? item.slices : [...item.a, ...item.b];
}

/** Число кусочков элемента очереди */
export function traySize(item: TrayItem): number {
  return item.kind === 'single' ? item.slices.length : item.a.length + item.b.length;
}

/** Независимая копия элемента очереди */
export function cloneTrayItem(item: TrayItem): TrayItem {
  return item.kind === 'single' ? { kind: 'single', slices: [...item.slices] } : { kind: 'double', a: [...item.a], b: [...item.b] };
}

/**
 * Бесконечный поток тарелок (итерация 3). Элемент с номером next
 * детерминированно вычисляется из seed и номера — один и тот же уровень
 * всегда раздаёт одни и те же тарелки в одном порядке. next увеличивает
 * движок по мере расхода очереди.
 */
export interface TrayStream {
  seed: number;
  /** номер следующего элемента потока */
  next: number;
  /** доступные вкусы уровня */
  flavors: Flavor[];
  /** двойные тарелки разрешены */
  doubles: boolean;
  /** редкие «почти торты» (5 кусочков одного вкуса) разрешены */
  heavy: boolean;
}

/** Данные уровня (ТЗ п. 7 + итерация 3): поле, цель в очках, поток */
export interface LevelData {
  rows: number;
  cols: number;
  initial: InitialPlate[];
  /** очередь: первые элементы + запас; при наличии stream — бесконечная */
  tray: TrayItem[];
  /** цель уровня в очках; 0/undefined — победа по очистке поля (тесты) */
  target?: number;
  /** торт, который открывается за прохождение (карточка победы) */
  unlockFlavor?: number;
  /** бесконечный поток тарелок */
  stream?: TrayStream;
  /** конфигурация цепной реакции (Этап B): переопределения над умолчанием */
  cascade?: Partial<CascadeConfig>;
}

/** Тарелка на поле */
export interface GPlate {
  id: number;
  cell: CellIndex;
  slices: SliceRef[];
}

/** Фазы хода (ТЗ п. 9.4): ввод разрешён в idle и dragging (поворот двойной) */
export type Phase = 'idle' | 'dragging' | 'placing' | 'resolving' | 'won' | 'lost';

/** Состояние партии — источник истины (ТЗ п. 9.5) */
export interface GState {
  rows: number;
  cols: number;
  /** тарелка в ячейке или null */
  board: Array<GPlate | null>;
  /** оставшаяся очередь (видимая выдача — первые WINDOW) */
  tray: TrayItem[];
  completed: number;
  /** набранные очки (итерация 3) */
  points: number;
  /** цель уровня в очках; 0 — режим очистки поля (тесты) */
  target: number;
  /** торты, собранные в текущем ходе (для комбо-бонуса) */
  combo: number;
  /** конфигурация цепной реакции уровня (Этап B); отсутствует — по умолчанию */
  cascade?: CascadeConfig;
  nextPlateId: number;
  nextSliceId: number;
}

/**
 * Атомарный перенос кусочков между тарелками (ТЗ п. 5.3 + правило цепочек).
 * path — полный маршрут: [от кого, транзитные тарелки…, кому].
 */
export interface Transfer {
  from: CellIndex;
  to: CellIndex;
  flavor: Flavor;
  count: number;
  /** маршрут: from → промежуточные ячейки → to */
  path: CellIndex[];
}

/** Причина поражения: поле заполнено (некуда ставить) или очередь кончилась с остатком (ТЗ п. 6.3) */
export type EndReason = 'full' | 'leftover';

/* ------------------------------------------------------------------ */
/* Конфигурация цепной реакции (Этап B, аудит §6.2)                    */
/* ------------------------------------------------------------------ */

/**
 * Параметры разрешения хода. Значения по умолчанию воспроизводят
 * поведение до Этапа B; лимиты переносов и тортов — защита на будущее,
 * а не инструмент балансировки (аудит §5: лимит тортов порождает патологию
 * «шесть кусочков, но торт не собирается», лимит переносов неотличим).
 */
export interface CascadeConfig {
  /** защитный лимит шагов разрешения за ход (шаг = перенос или торт).
   *  Доказанный максимум — 54 (9 тарелок × 6 вкусов), запас — 64. */
  maxResolutionSteps: number;
  /** лимит переносов за ход; Infinity — отключено */
  maxTransfersPerTurn: number;
  /** лимит тортов за ход; Infinity — отключено */
  maxCakesPerTurn: number;
  /** цепочечные переносы разрешены (V3 аудита: выключение ломает игру 2/30) */
  allowChainTransfers: boolean;
  /** макс. число «прыжков» маршрута: 1 — только прямые соседи,
   *  2 — один транзит, Infinity — без ограничения (аудит §5, H-варианты) */
  maxChainHops: number;
  /** прямые переносы раньше цепочек (уже реализовано до Этапа B) */
  directTransferPriority: boolean;
}

/** Конфиг по умолчанию: текущие правила без ограничений + защитный лимит */
export const DEFAULT_CASCADE_CONFIG: CascadeConfig = {
  maxResolutionSteps: 64,
  maxTransfersPerTurn: Infinity,
  maxCakesPerTurn: Infinity,
  allowChainTransfers: true,
  maxChainHops: Infinity,
  directTransferPriority: true,
};

/* ------------------------------------------------------------------ */
/* Журнал событий хода (Этап B, аудит §6.1)                            */
/* ------------------------------------------------------------------ */

/** Фазы разрешения хода (ТЗ 3.3): контракт для визуального слоя */
export type TurnPhase = 'detect' | 'move' | 'bake' | 'cleanup' | 'recheck' | 'done';

/**
 * Одно событие разрешения хода. Логика применяет состояние полностью и
 * независимо от анимаций (ТЗ 3.7); визуальный слой воспроизводит журнал.
 */
export type TurnEvent =
  | { kind: 'place'; cells: CellIndex[] }
  | { kind: 'transfer'; transfer: Transfer }
  | { kind: 'cake'; cell: CellIndex; flavor: Flavor; combo: number; points: number }
  | { kind: 'plateGone'; cell: CellIndex }
  | { kind: 'aborted'; steps: number; limit: number; snapshot: string }
  | { kind: 'phase'; phase: TurnPhase };
