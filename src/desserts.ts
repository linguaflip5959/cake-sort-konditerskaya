/**
 * Фабрика процедурных 3D-моделей десертов (three.js).
 * Все геометрии и материалы кэшируются — при удалении десерта
 * достаточно снять mesh со сцены, ничего не диспозим.
 */

import * as THREE from 'three';
import { TIERS } from './config';

/* ------------------------------------------------------------------ */
/* Кэши ресурсов                                                       */
/* ------------------------------------------------------------------ */

const matCache = new Map<string, THREE.MeshStandardMaterial>();
const geoCache = new Map<string, THREE.BufferGeometry>();

function mat(color: number, roughness = 0.55, metalness = 0.05): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    matCache.set(key, m);
  }
  return m;
}

function emissiveMat(color: number, emissive: number, intensity = 1): THREE.MeshStandardMaterial {
  const key = `em|${color}|${emissive}|${intensity}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity: intensity,
      roughness: 0.4,
    });
    matCache.set(key, m);
  }
  return m;
}

function cyl(rTop: number, rBottom: number, h: number, seg = 26): THREE.CylinderGeometry {
  const key = `cyl|${rTop}|${rBottom}|${h}|${seg}`;
  let g = geoCache.get(key) as THREE.CylinderGeometry | undefined;
  if (!g) {
    g = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
    geoCache.set(key, g);
  }
  return g;
}

function sph(r: number, w = 20, h = 14): THREE.SphereGeometry {
  const key = `sph|${r}|${w}|${h}`;
  let g = geoCache.get(key) as THREE.SphereGeometry | undefined;
  if (!g) {
    g = new THREE.SphereGeometry(r, w, h);
    geoCache.set(key, g);
  }
  return g;
}

function box(x: number, y: number, z: number): THREE.BoxGeometry {
  const key = `box|${x}|${y}|${z}`;
  let g = geoCache.get(key) as THREE.BoxGeometry | undefined;
  if (!g) {
    g = new THREE.BoxGeometry(x, y, z);
    geoCache.set(key, g);
  }
  return g;
}

function torus(R: number, tube: number, seg = 30): THREE.TorusGeometry {
  const key = `tor|${R}|${tube}|${seg}`;
  let g = geoCache.get(key) as THREE.TorusGeometry | undefined;
  if (!g) {
    g = new THREE.TorusGeometry(R, tube, 14, seg);
    geoCache.set(key, g);
  }
  return g;
}

function cone(r: number, h: number, seg = 18): THREE.ConeGeometry {
  const key = `cone|${r}|${h}|${seg}`;
  let g = geoCache.get(key) as THREE.ConeGeometry | undefined;
  if (!g) {
    g = new THREE.ConeGeometry(r, h, seg);
    geoCache.set(key, g);
  }
  return g;
}

function capsule(r: number, len: number): THREE.CapsuleGeometry {
  const key = `cap|${r}|${len}`;
  let g = geoCache.get(key) as THREE.CapsuleGeometry | undefined;
  if (!g) {
    g = new THREE.CapsuleGeometry(r, len, 6, 16);
    geoCache.set(key, g);
  }
  return g;
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
  const ms = new THREE.Mesh(geo, m);
  ms.castShadow = true;
  ms.receiveShadow = true;
  return ms;
}

/* ------------------------------------------------------------------ */
/* Текстура спирали для рулета                                         */
/* ------------------------------------------------------------------ */

let swirlTexture: THREE.CanvasTexture | null = null;

function getSwirlTexture(): THREE.CanvasTexture {
  if (swirlTexture) return swirlTexture;
  const size = 256;
  const cnv = document.createElement('canvas');
  cnv.width = size;
  cnv.height = size;
  const ctx = cnv.getContext('2d')!;
  ctx.fillStyle = '#f6e3c4';
  ctx.fillRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  ctx.strokeStyle = '#c98f5f';
  ctx.lineWidth = 21;
  ctx.lineCap = 'round';
  ctx.beginPath();
  // Архимедова спираль
  const turns = 4.5;
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = t * turns * Math.PI * 2;
    const r = 8 + t * (size / 2 - 22);
    const x = Math.cos(ang) * r;
    const y = Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  swirlTexture = new THREE.CanvasTexture(cnv);
  swirlTexture.colorSpace = THREE.SRGBColorSpace;
  swirlTexture.anisotropy = 4;
  return swirlTexture;
}

/* ------------------------------------------------------------------ */
/* Модели ярусов                                                       */
/* ------------------------------------------------------------------ */

/** Крошечные «посыпки» для пончика */
function addSprinkles(parent: THREE.Group, R: number, y: number): void {
  const colors = [0xffffff, 0xffe066, 0x7bc96f, 0xf48fb1, 0x6ec6ff];
  const sprinkleGeo = box(0.07, 0.03, 0.03);
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + 0.4;
    const rr = R * (0.55 + 0.4 * ((i * 37) % 10) / 10);
    const s = mesh(sprinkleGeo, mat(colors[i % colors.length], 0.35));
    s.position.set(Math.cos(ang) * rr, y, Math.sin(ang) * rr);
    s.rotation.y = ang + 0.7;
    s.castShadow = false;
    parent.add(s);
  }
}

/** Шарики-безе по краю яруса торта */
function addDollopRing(parent: THREE.Group, radius: number, y: number, count: number): void {
  const g = sph(0.1, 12, 10);
  const m = mat(0xfff6ec, 0.5);
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2;
    const d = mesh(g, m);
    d.position.set(Math.cos(ang) * radius, y, Math.sin(ang) * radius);
    parent.add(d);
  }
}

/** Шоколадные крошки для печенья */
function addChips(parent: THREE.Group, r: number, y: number): void {
  const g = sph(0.055, 10, 8);
  const m = mat(0x5c3a28, 0.6);
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2 + 0.9;
    const rr = r * (0.35 + 0.55 * ((i * 53) % 10) / 10);
    const c = mesh(g, m);
    c.position.set(Math.cos(ang) * rr, y, Math.sin(ang) * rr);
    parent.add(c);
  }
}

function buildCandy(): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(sph(0.34, 24, 18), mat(0xe8566b, 0.4));
  body.scale.set(1, 0.8, 0.8);
  g.add(body);
  // «Обёртки» по бокам
  const wrapL = mesh(cone(0.19, 0.3, 14), mat(0xd94f63, 0.45));
  wrapL.rotation.z = Math.PI / 2;
  wrapL.position.x = -0.42;
  const wrapR = wrapL.clone();
  wrapR.rotation.z = -Math.PI / 2;
  wrapR.position.x = 0.42;
  g.add(wrapL, wrapR);
  // Блик
  const stripe = mesh(torus(0.345, 0.022, 24), mat(0xffffff, 0.3));
  stripe.rotation.y = 0.5;
  g.add(stripe);
  return g;
}

function buildCookie(): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(cyl(0.46, 0.46, 0.22), mat(0xd9a05b, 0.75));
  g.add(body);
  addChips(g, 0.46, 0.115);
  return g;
}

function buildMacaron(): THREE.Group {
  const g = new THREE.Group();
  const shellM = mat(0xf2a9c4, 0.5);
  const top = mesh(sph(0.58, 24, 16), shellM);
  top.scale.set(1, 0.34, 1);
  top.position.y = 0.13;
  const bottom = mesh(sph(0.58, 24, 16), shellM);
  bottom.scale.set(1, 0.34, 1);
  bottom.position.y = -0.13;
  const cream = mesh(cyl(0.5, 0.5, 0.12), mat(0xfff7ee, 0.5));
  g.add(top, bottom, cream);
  return g;
}

function buildDonut(): THREE.Group {
  const g = new THREE.Group();
  const base = mesh(torus(0.52, 0.21), mat(0xe9b44c, 0.6));
  base.rotation.x = Math.PI / 2;
  const glaze = mesh(torus(0.52, 0.225), mat(0xf48fb1, 0.35));
  glaze.rotation.x = Math.PI / 2;
  glaze.scale.set(1, 1, 0.62);
  glaze.position.y = 0.06;
  g.add(base, glaze);
  addSprinkles(g, 0.52, 0.15);
  return g;
}

function buildCupcake(): THREE.Group {
  const g = new THREE.Group();
  const wrapper = mesh(cyl(0.62, 0.47, 0.44), mat(0xe0793f, 0.6));
  wrapper.position.y = -0.15;
  const creamM = mat(0xfff4e2, 0.5);
  const c1 = mesh(sph(0.55, 22, 16), creamM);
  c1.scale.set(1, 0.42, 1);
  c1.position.y = 0.13;
  const c2 = mesh(sph(0.44, 20, 14), creamM);
  c2.scale.set(1, 0.42, 1);
  c2.position.y = 0.31;
  const c3 = mesh(sph(0.29, 18, 12), creamM);
  c3.scale.set(1, 0.45, 1);
  c3.position.y = 0.46;
  const cherry = mesh(sph(0.12, 14, 10), mat(0xd63a4f, 0.3));
  cherry.position.y = 0.62;
  g.add(wrapper, c1, c2, c3, cherry);
  return g;
}

function buildEclair(): THREE.Group {
  const g = new THREE.Group();
  const body = mesh(capsule(0.34, 1.18), mat(0xc8905e, 0.6));
  body.rotation.z = Math.PI / 2;
  const glaze = mesh(capsule(0.36, 1.02), mat(0x5c3a28, 0.35));
  glaze.rotation.z = Math.PI / 2;
  glaze.scale.set(1, 1, 0.62);
  glaze.position.y = 0.1;
  g.add(body, glaze);
  return g;
}

function buildPancakes(): THREE.Group {
  const g = new THREE.Group();
  const m1 = mat(0xedbb58, 0.65);
  const m2 = mat(0xe8b04b, 0.65);
  const p1 = mesh(cyl(1.12, 1.14, 0.26), m1);
  p1.position.y = -0.29;
  const p2 = mesh(cyl(1.1, 1.12, 0.26), m2);
  p2.position.set(0.06, -0.02, -0.03);
  p2.rotation.y = 0.5;
  const p3 = mesh(cyl(1.08, 1.1, 0.26), m1);
  p3.position.set(-0.05, 0.25, 0.04);
  p3.rotation.y = 1.1;
  const butter = mesh(box(0.32, 0.16, 0.32), mat(0xffe066, 0.4));
  butter.position.set(0.02, 0.44, 0);
  butter.rotation.y = 0.6;
  g.add(p1, p2, p3, butter);
  return g;
}

function buildRoll(): THREE.Group {
  const g = new THREE.Group();
  const sideM = mat(0xe9c89a, 0.6);
  const swirlM = new THREE.MeshStandardMaterial({ map: getSwirlTexture(), roughness: 0.55 });
  const bottomM = mat(0xf6e3c4, 0.6);
  // CylinderGeometry с массивом материалов: [бок, верх, низ]
  const geoKey = 'rollBody';
  let bodyGeo = geoCache.get(geoKey) as THREE.CylinderGeometry | undefined;
  if (!bodyGeo) {
    bodyGeo = new THREE.CylinderGeometry(1.3, 1.3, 1.0, 30);
    geoCache.set(geoKey, bodyGeo);
  }
  const body = new THREE.Mesh(bodyGeo, [sideM, swirlM, bottomM]);
  body.castShadow = true;
  body.receiveShadow = true;
  const rim = mesh(torus(1.2, 0.11), mat(0xfff6ec, 0.5));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.5;
  const cherry = mesh(sph(0.16, 14, 10), mat(0xd63a4f, 0.3));
  cherry.position.y = 0.66;
  g.add(body, rim, cherry);
  return g;
}

function buildBigCake(): THREE.Group {
  const g = new THREE.Group();
  const white = mat(0xfff6ec, 0.5);
  const pink = mat(0xf9d9e2, 0.5);
  const t1 = mesh(cyl(1.5, 1.52, 0.62, 34), white);
  t1.position.y = -0.38;
  const t2 = mesh(cyl(1.1, 1.12, 0.52, 30), pink);
  t2.position.y = 0.18;
  const t3 = mesh(cyl(0.72, 0.74, 0.46, 28), white);
  t3.position.y = 0.67;
  addDollopRing(g, 1.34, -0.03, 9);
  addDollopRing(g, 0.94, 0.47, 7);
  const strawberry = mesh(sph(0.19, 14, 10), mat(0xd63a4f, 0.3));
  strawberry.scale.set(1, 1.15, 1);
  strawberry.position.y = 0.98;
  const leaf = mesh(sph(0.07, 8, 6), mat(0x7bc96f, 0.5));
  leaf.scale.set(1.6, 0.5, 1.6);
  leaf.position.y = 1.12;
  // Свечка
  const candle = mesh(cyl(0.05, 0.05, 0.34, 10), mat(0xffe066, 0.4));
  candle.position.y = 0.85;
  candle.position.x = 0.32;
  const flame = mesh(sph(0.07, 10, 8), emissiveMat(0xffb020, 0xff8c00, 1.6));
  flame.scale.set(0.8, 1.5, 0.8);
  flame.position.set(0.32, 1.1, 0);
  flame.castShadow = false;
  g.add(t1, t2, t3, strawberry, leaf, candle, flame);
  return g;
}

const BUILDERS: readonly (() => THREE.Group)[] = [
  buildCandy, buildCookie, buildMacaron, buildDonut, buildCupcake,
  buildEclair, buildPancakes, buildRoll, buildBigCake,
];

/**
 * Собрать модель десерта яруса `tier` (0..8).
 * Начало координат модели = центр физического тела.
 */
export function buildDessertMesh(tier: number): THREE.Group {
  const t = TIERS[tier];
  const g = BUILDERS[tier]();
  g.scale.setScalar(1);
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // Небольшая общая подстройка масштаба, чтобы модель не выпирала из коллайдера
  const bound = new THREE.Box3().setFromObject(g);
  const maxHalf = Math.max(
    Math.abs(bound.max.y),
    Math.abs(bound.min.y),
    bound.max.x,
    Math.abs(bound.min.x),
    bound.max.z,
    Math.abs(bound.min.z),
  );
  const limit = t.shape === 'ball' ? t.radius : Math.max(t.radius, t.halfHeight) * 1.02;
  if (maxHalf > limit) g.scale.setScalar(limit / maxHalf);
  return g;
}

/** Цвет яруса (для частиц) */
export function tierColor(tier: number): number {
  return TIERS[tier].color;
}
