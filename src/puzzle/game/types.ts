/**
 * Cake Sort — «Кондитерская»
 * Слой 1 (ТЗ п. 9.1): игровые данные. Чистые типы без Three.js и GSAP.
 */

/** Вместимость тарелки: 6 кусочков = целый торт (ТЗ п. 3.1) */
export const CAP = 6;

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
 * обычная тарелка или двойная — две жёстко соединённые тарелки,
 * которая занимает два соседних слота очереди как один предмет.
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

/** Данные уровня (ТЗ п. 7): поле, начальные тарелки, конечная очередь */
export interface LevelData {
  rows: number;
  cols: number;
  initial: InitialPlate[];
  /** очередь тарелок; у каждой тарелки 1..6 кусочков */
  tray: TrayItem[];
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
  /** оставшаяся очередь (первые три видны игроку) */
  tray: TrayItem[];
  completed: number;
  nextPlateId: number;
  nextSliceId: number;
}

/** Атомарный перенос кусочков между соседними тарелками (ТЗ п. 5.3) */
export interface Transfer {
  from: CellIndex;
  to: CellIndex;
  flavor: Flavor;
  count: number;
}

/** Причина поражения: поле заполнено (некуда ставить) или очередь кончилась с остатком (ТЗ п. 6.3) */
export type EndReason = 'full' | 'leftover';
