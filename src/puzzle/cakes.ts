/**
 * Cake Sort — Кондитерская (люкс)
 * Типы тортиков и процедурные 3D-модели: кусочки-секторы, тарелки,
 * мраморный стол, золотая фурнитура. Стиль: тёмная витрина бутика.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/* ------------------------------------------------------------------ */
/* Типы тортиков                                                       */
/* ------------------------------------------------------------------ */

export interface CakeType {
  readonly name: string;
  /** Цвет бисквита */
  readonly main: number;
  /** Цвет крема */
  readonly cream: number;
  /** Цвет топпинга */
  readonly topping: number;
}

export const CAKE_TYPES: readonly CakeType[] = [
  { name: 'Шоколадный',    main: 0x4a2c1a, cream: 0xd9a566, topping: 0xd4af37 },
  { name: 'Красный бархат', main: 0x8e2438, cream: 0xf5e9d6, topping: 0xc0283f },
  { name: 'Матча',         main: 0x7fae6a, cream: 0xf2f7ea, topping: 0x3e6b3a },
  { name: 'Лимонный',      main: 0xf2c94c, cream: 0xfdf3d0, topping: 0xe8a13c },
  { name: 'Черничный',     main: 0x5b4a8a, cream: 0xe8e2f5, topping: 0x3d2f66 },
  { name: 'Фисташковый',   main: 0xb5cf9e, cream: 0xf7f3e3, topping: 0x6e8f5a },
  { name: 'Малиновый',     main: 0xc94f6d, cream: 0xfbe8ec, topping: 0xa63a52 },
  { name: 'Карамельный',   main: 0xc98a3d, cream: 0xf6e3c2, topping: 0xa96b22 },
  { name: 'Ванильный',     main: 0xf0e2c4, cream: 0xfffaf0, topping: 0xd4af37 },
  { name: 'Тирамису',      main: 0x6b4a35, cream: 0xf0e4d0, topping: 0x3c2a1e },
] as const;

/* ------------------------------------------------------------------ */
/* Геометрия кусочка-сектора (60°)                                     */
/* ------------------------------------------------------------------ */

export const SLICE_RADIUS = 0.78;
export const SLICE_HEIGHT = 0.2;
/** Угол сектора: 6 кусков = полный торт */
export const SECTOR = Math.PI / 3;

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<string, THREE.MeshStandardMaterial>();

function mat(color: number, roughness = 0.55, metalness = 0.04, env = 1): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}|${env}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: env });
    matCache.set(key, m);
  }
  return m;
}

/** Клиновидный сектор (ExtrudeGeometry), лежащий горизонтально: остриё в (0,0,0), смотрит в +X */
function wedgeGeometry(radius: number, height: number): THREE.ExtrudeGeometry {
  const key = `wedge|${radius}|${height}`;
  let g = geoCache.get(key) as THREE.ExtrudeGeometry | undefined;
  if (!g) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.absarc(0, 0, radius, -SECTOR / 2, SECTOR / 2, false);
    shape.lineTo(0, 0);
    g = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 14,
    });
    g.rotateX(-Math.PI / 2);
    geoCache.set(key, g);
  }
  return g;
}

function sphere(r: number, seg = 12): THREE.SphereGeometry {
  const key = `sph|${r}|${seg}`;
  let g = geoCache.get(key) as THREE.SphereGeometry | undefined;
  if (!g) {
    g = new THREE.SphereGeometry(r, seg + 4, seg);
    geoCache.set(key, g);
  }
  return g;
}

/* ------------------------------------------------------------------ */
/* Кусочек торта                                                       */
/* ------------------------------------------------------------------ */

export interface SliceMesh extends THREE.Group {
  /** Ярус-анимация не должна конфликтовать с логикой — храним тип прямо в объекте */
  userData: { type: number };
}

/**
 * Кусочек-сектор: бисквит + кремовая шапочка + топпинг.
 * Остриё в центре тарелки (локальный origin), лежит горизонтально, смотрит в +X.
 */
export function buildSlice(typeIdx: number): SliceMesh {
  const t = CAKE_TYPES[typeIdx];
  const g = new THREE.Group() as SliceMesh;
  g.userData.type = typeIdx;

  const body = new THREE.Mesh(wedgeGeometry(SLICE_RADIUS, SLICE_HEIGHT), mat(t.main, 0.62));
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const cap = new THREE.Mesh(wedgeGeometry(SLICE_RADIUS * 0.995, 0.055), mat(t.cream, 0.42));
  cap.position.y = SLICE_HEIGHT;
  cap.castShadow = true;
  g.add(cap);

  const topping = new THREE.Mesh(sphere(0.065, 8), mat(t.topping, 0.3, 0.5, 1.4));
  topping.position.set(SLICE_RADIUS * 0.62, SLICE_HEIGHT + 0.11, 0);
  g.add(topping);

  return g;
}

/* ------------------------------------------------------------------ */
/* Украшения полного торта (при слиянии 6 кусков)                      */
/* ------------------------------------------------------------------ */

/** Кремовые «безешки» по кругу + топпинг в центре — надевается поверх собранного торта */
export function buildCakeCrown(typeIdx: number): THREE.Group {
  const t = CAKE_TYPES[typeIdx];
  const g = new THREE.Group();
  const creamM = mat(t.cream, 0.4);
  const dollopGeo = sphere(0.09, 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const d = new THREE.Mesh(dollopGeo, creamM);
    d.position.set(Math.cos(a) * SLICE_RADIUS * 0.86, 0, Math.sin(a) * SLICE_RADIUS * 0.86);
    g.add(d);
  }
  const cherry = new THREE.Mesh(sphere(0.13, 10), mat(t.topping, 0.25, 0.45, 1.5));
  cherry.position.y = 0.16;
  cherry.scale.set(1, 1.1, 1);
  g.add(cherry);
  return g;
}

/* ------------------------------------------------------------------ */
/* Тарелка: стекло + золотой ободок и ножка                            */
/* ------------------------------------------------------------------ */

export const PLATE_RADIUS = 1.0;

export function goldMaterial(): THREE.MeshStandardMaterial {
  return mat(0xd4af37, 0.26, 1.0, 1.35);
}

export function buildPlate(): THREE.Group {
  const g = new THREE.Group();
  const gold = goldMaterial();

  const glass = new THREE.Mesh(
    (() => {
      const key = 'plateGlass';
      let geo = geoCache.get(key) as THREE.CylinderGeometry | undefined;
      if (!geo) {
        geo = new THREE.CylinderGeometry(PLATE_RADIUS, PLATE_RADIUS * 0.94, 0.09, 40);
        geoCache.set(key, geo);
      }
      return geo;
    })(),
    new THREE.MeshPhysicalMaterial({
      color: 0xfff6e8,
      transparent: true,
      opacity: 0.42,
      roughness: 0.05,
      metalness: 0,
      envMapIntensity: 2.2,
      depthWrite: false,
    }),
  );
  glass.position.y = 0.045;
  glass.renderOrder = 4;
  g.add(glass);

  const rim = new THREE.Mesh(
    (() => {
      const key = 'plateRim';
      let geo = geoCache.get(key) as THREE.TorusGeometry | undefined;
      if (!geo) {
        geo = new THREE.TorusGeometry(PLATE_RADIUS, 0.045, 12, 44);
        geoCache.set(key, geo);
      }
      return geo;
    })(),
    gold,
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.085;
  rim.castShadow = true;
  g.add(rim);

  const stem = new THREE.Mesh(
    (() => {
      const key = 'plateStem';
      let geo = geoCache.get(key) as THREE.CylinderGeometry | undefined;
      if (!geo) {
        geo = new THREE.CylinderGeometry(0.16, 0.24, 0.16, 18);
        geoCache.set(key, geo);
      }
      return geo;
    })(),
    gold,
  );
  stem.position.y = -0.08;
  stem.castShadow = true;
  g.add(stem);

  return g;
}

/* ------------------------------------------------------------------ */
/* Двойная тарелка: золотая перемычка                                  */
/* ------------------------------------------------------------------ */

/** Перемычка с собственным материалом — движок растворяет её при разделении */
export interface BridgeMesh extends THREE.Mesh {
  material: THREE.MeshStandardMaterial;
}

/** Золотая перемычка, соединяющая две тарелки двойной (ТЗ итерации 2, п. 3.8) */
export function buildDoubleBridge(): BridgeMesh {
  const bridge = new THREE.Mesh(
    roundedBox(0.82, 0.075, 0.17, 0.03),
    new THREE.MeshStandardMaterial({
      color: 0xd4af37,
      roughness: 0.26,
      metalness: 1.0,
      envMapIntensity: 1.35,
      transparent: true,
    }),
  );
  bridge.position.y = 0.085;
  bridge.castShadow = true;
  return bridge as BridgeMesh;
}

/* ------------------------------------------------------------------ */
/* Подставка для готовых тортов: мраморный подиум + золотой ярус        */
/* ------------------------------------------------------------------ */

/** Высота посадки готового торта на подставку (мир, y) */
export const STAND_CAKE_Y = 1.16;

/** Скруглённый бокс с кэшем геометрии по размерам */
function roundedBox(w: number, h: number, d: number, r: number): RoundedBoxGeometry {
  const key = `rbox|${w}|${h}|${d}|${r}`;
  let g = geoCache.get(key) as RoundedBoxGeometry | undefined;
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 4, r);
    geoCache.set(key, g);
  }
  return g;
}

export function buildCenterStand(): THREE.Group {
  const g = new THREE.Group();
  const gold = goldMaterial();

  // Мраморный подиум
  const podiumH = 0.52;
  const podium = new THREE.Mesh(roundedBox(1.95, podiumH, 1.95, 0.1), marbleMaterial());
  podium.position.y = podiumH / 2;
  podium.castShadow = true;
  podium.receiveShadow = true;
  g.add(podium);

  // Золотая кромка подиума
  const trim = new THREE.Mesh(roundedBox(2.02, 0.07, 2.02, 0.03), gold);
  trim.position.y = podiumH - 0.035;
  g.add(trim);

  // Золотая подставка (база — ножка — диск)
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.68, 0.1, 32), gold);
  base.position.y = podiumH + 0.05;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.5, 16), gold);
  pole.position.y = podiumH + 0.32;
  pole.castShadow = true;
  g.add(pole);

  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.6, 0.08, 32), gold);
  top.position.y = podiumH + 0.6;
  top.castShadow = true;
  top.receiveShadow = true;
  g.add(top);

  return g;
}

/* ------------------------------------------------------------------ */
/* Квадратный мраморный стол с золотой кромкой                         */
/* ------------------------------------------------------------------ */

export function buildSquareTable(side: number): THREE.Group {
  const g = new THREE.Group();

  // Столешница — тёмный мрамор с золотыми жилками
  const top = new THREE.Mesh(roundedBox(side, 0.5, side, Math.min(0.22, side * 0.02 + 0.06)), marbleMaterial());
  top.position.y = -0.25;
  top.receiveShadow = true;
  g.add(top);

  // Золотой кантик по кромке столешницы
  const band = new THREE.Mesh(roundedBox(side + 0.14, 0.13, side + 0.14, 0.06), goldMaterial());
  band.position.y = -0.42;
  band.castShadow = true;
  g.add(band);

  // Тёмный цоколь, уходящий в тень витрины
  const apron = new THREE.Mesh(roundedBox(side * 0.62, 1.7, side * 0.62, 0.2), mat(0x0f0b07, 0.7, 0.08, 0.25));
  apron.position.y = -1.32;
  g.add(apron);

  return g;
}

/* ------------------------------------------------------------------ */
/* Мраморная текстура стола (canvas)                                   */
/* ------------------------------------------------------------------ */

let marbleTexture: THREE.CanvasTexture | null = null;
let marbleMat: THREE.MeshStandardMaterial | null = null;

export function marbleMaterial(): THREE.MeshStandardMaterial {
  if (marbleMat) return marbleMat;
  if (!marbleTexture) {
    const size = 512;
    const cnv = document.createElement('canvas');
    cnv.width = size;
    cnv.height = size;
    const ctx = cnv.getContext('2d')!;

    // Тёмная основа
    ctx.fillStyle = '#1c1611';
    ctx.fillRect(0, 0, size, size);

    // Мягкие разводы
    for (let i = 0; i < 30; i++) {
      const light = Math.random() > 0.5;
      ctx.strokeStyle = light
        ? `rgba(150, 124, 92, ${0.1 + Math.random() * 0.15})`
        : `rgba(8, 6, 4, ${0.1 + Math.random() * 0.14})`;
      ctx.lineWidth = 6 + Math.random() * 26;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const x0 = Math.random() * size;
      const y0 = Math.random() * size;
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(
        x0 + (Math.random() - 0.5) * 260,
        y0 + (Math.random() - 0.5) * 260,
        x0 + (Math.random() - 0.5) * 380,
        y0 + (Math.random() - 0.5) * 380,
        Math.random() * size,
        Math.random() * size,
      );
      ctx.stroke();
    }

    // Золотые жилки
    for (let i = 0; i < 11; i++) {
      ctx.strokeStyle = `rgba(212, 172, 88, ${0.2 + Math.random() * 0.2})`;
      ctx.lineWidth = 0.9 + Math.random() * 1.8;
      ctx.beginPath();
      const x0 = Math.random() * size;
      const y0 = Math.random() * size;
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(
        x0 + (Math.random() - 0.5) * 300,
        y0 + (Math.random() - 0.5) * 300,
        x0 + (Math.random() - 0.5) * 360,
        y0 + (Math.random() - 0.5) * 360,
        Math.random() * size,
        Math.random() * size,
      );
      ctx.stroke();
    }

    // Мелкое зерно
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = `rgba(${180 + Math.random() * 60 | 0}, ${150 + Math.random() * 50 | 0}, ${100 + Math.random() * 40 | 0}, ${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 1.4, 1.4);
    }

    marbleTexture = new THREE.CanvasTexture(cnv);
    marbleTexture.colorSpace = THREE.SRGBColorSpace;
    marbleTexture.anisotropy = 8;
  }
  marbleMat = new THREE.MeshStandardMaterial({
    map: marbleTexture,
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.05,
    envMapIntensity: 0.62,
  });
  return marbleMat;
}

/** Частица-искра (золото/крем) */
export function sparkMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: 0xffd97a, toneMapped: false });
}
