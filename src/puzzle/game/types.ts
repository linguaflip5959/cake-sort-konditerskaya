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

export interface SliceRef {
  id: number;
  flavor: Flavor;
}

export interface InitialPlate {
  row: number;
  col: number;
  /** 1..6 вкусов кусочков */
  slices: Flavor[];
}

/** Данные уровня (ТЗ п. 7): поле, начальные тарелки, конечная очередь */
export interface LevelData {
  rows: number;
  cols: number;
  initial: InitialPlate[];
  /** конечная очередь тарелок; каждая содержит 1..6 кусочков */
  tray: Flavor[][];
}

/** Тарелка на поле */
export interface GPlate {
  id: number;
  cell: CellIndex;
  slices: SliceRef[];
}

/** Фазы хода (ТЗ п. 9.4): ввод разрешён только в idle */
export type Phase = 'idle' | 'dragging' | 'placing' | 'resolving' | 'won' | 'lost';

/** Состояние партии — источник истины (ТЗ п. 9.5) */
export interface GState {
  rows: number;
  cols: number;
  /** тарелка в ячейке или null */
  board: Array<GPlate | null>;
  /** оставшаяся очередь (первые три видны игроку) */
  tray: Flavor[][];
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

/** Причина поражения: поле заполнено или очередь кончилась с остатком (ТЗ п. 6.3) */
export type EndReason = 'full' | 'leftover';
