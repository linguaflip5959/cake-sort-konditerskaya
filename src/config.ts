/**
 * Cake Sort — Auto Merge Mechanic
 * Конфигурация: ярусы десертов, палитра, размеры игрового мира.
 */

export interface TierDef {
  /** Название десерта (для UI) */
  readonly name: string;
  /** Радиус коллайдера */
  readonly radius: number;
  /** Половина высоты коллайдера (для ball — не используется) */
  readonly halfHeight: number;
  /** Тип физического коллайдера */
  readonly shape: 'ball' | 'cylinder' | 'capsule-x';
  /** Эмодзи для тоста «новый десерт» */
  readonly emoji: string;
  /** Основной цвет (для частиц при слиянии) */
  readonly color: number;
}

export const TIERS: readonly TierDef[] = [
  { name: 'Конфета',  radius: 0.34, halfHeight: 0.34, shape: 'ball',     emoji: '🍬', color: 0xe8566b },
  { name: 'Печенье',  radius: 0.46, halfHeight: 0.11, shape: 'cylinder', emoji: '🍪', color: 0xd9a05b },
  { name: 'Макарон',  radius: 0.58, halfHeight: 0.20, shape: 'cylinder', emoji: '🌸', color: 0xf2a9c4 },
  { name: 'Пончик',   radius: 0.70, halfHeight: 0.17, shape: 'cylinder', emoji: '🍩', color: 0xe9b44c },
  { name: 'Капкейк',  radius: 0.84, halfHeight: 0.36, shape: 'cylinder', emoji: '🧁', color: 0xe0793f },
  { name: 'Эклер',    radius: 0.44, halfHeight: 0.58, shape: 'capsule-x', emoji: '🍫', color: 0xc8905e },
  { name: 'Панкейки', radius: 1.14, halfHeight: 0.42, shape: 'cylinder', emoji: '🥞', color: 0xedbb58 },
  { name: 'Рулет',    radius: 1.30, halfHeight: 0.50, shape: 'cylinder', emoji: '🍰', color: 0xe9c89a },
  { name: 'Торт',     radius: 1.50, halfHeight: 0.72, shape: 'cylinder', emoji: '🎂', color: 0xfff6ec },
] as const;

export const TIER_COUNT = TIERS.length; // 9

/** Веса появления ярусов в «руке» игрока (только первые 4) */
export const SPAWN_WEIGHTS: readonly number[] = [34, 28, 22, 16];

/** Геометрия игрового «стакана» */
export const WORLD = {
  /** Половина внутренней ширины (по X) */
  innerHalfWidth: 4.0,
  /** Половина внутренней глубины (по Z) */
  innerHalfDepth: 1.9,
  /** Высота стен (верхний край) */
  rimY: 9.6,
  /** Толщина стен */
  wall: 0.35,
  /** Y, на котором висит десерт перед броском */
  previewY: 10.8,
  /** Позиция подсказки «следующий» */
  nextX: 3.05,
  nextY: 11.05,
  /** Порог переполнения (центр тела выше этой отметки) */
  overflowY: 9.7,
  /** Сколько секунд десерт должен лежать выше отметки до проигрыша */
  overflowSeconds: 1.5,
  /** Пауза между бросками, с */
  dropCooldown: 0.42,
  /** Гравитация */
  gravityY: -22,
} as const;

/** Палитра сцены (согласована с оригинальным index.html) */
export const PALETTE = {
  background: 0xf4e9d7,
  table: 0xe9d9be,
  slab: 0xf6ede0,
  frame: 0xb85c2e,
  glass: 0xffffff,
} as const;

/** Взвешенный выбор яруса для спавна */
export function randomSpawnTier(): number {
  const total = SPAWN_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < SPAWN_WEIGHTS.length; i++) {
    r -= SPAWN_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 0;
}
