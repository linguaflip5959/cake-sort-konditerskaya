/**
 * Cake Sort — Кондитерская (люкс)
 * Движок (слои 3–4 по ТЗ п. 9): Three.js-сцена и GSAP-анимации поверх
 * чистой логики game/. Игрок перетаскивает тарелки из нижней очереди
 * на свободные ячейки поля; совпадающие кусочки перемещаются автоматически
 * по правилам game/rules.ts. Ручной перенос кусочков запрещён (ТЗ п. 0.2).
 *
 * Сцена: квадратный мраморный стол, ячейки поля с золотыми метками,
 * поднос очереди на три тарелки, золотая подставка готовых тортов.
 */

import * as THREE from 'three';
import gsap from 'gsap';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  CAKE_TYPES,
  buildSlice,
  buildCakeCrown,
  buildPlate,
  buildCenterStand,
  buildSquareTable,
  goldMaterial,
  sparkMaterial,
  STAND_CAKE_Y,
  SLICE_HEIGHT,
  PLATE_RADIUS,
  type SliceMesh,
} from './cakes';
import { PuzzleSfx } from './sfx';
import {
  applyCompletion,
  applyTransfer,
  canPlace,
  cloneState,
  evalEnd,
  findCompletion,
  freeCells,
  planNextTransfer,
  placePlate,
} from './game/rules';
import { createInitialState, getLevel, solve, totalCakes } from './game/levels';
import type { CellIndex, EndReason, Flavor, GState, LevelData, Phase } from './game/types';

/* ------------------------------------------------------------------ */
/* Типы                                                                */
/* ------------------------------------------------------------------ */

export interface PuzzleStats {
  level: number;
  moves: number;
  collected: number;
  cakes: number;
}

export interface PuzzleUI {
  onStats(s: PuzzleStats): void;
  onToast(text: string): void;
  onLevelDone(level: number, moves: number): void;
  onStuck(moves: number, collected: number, cakes: number, reason: EndReason): void;
}

/** Визуальная тарелка: на поле или в очереди */
interface PlateView {
  group: THREE.Group;
  slices: SliceMesh[];
  /** ячейка поля; -1, пока тарелка в очереди */
  cell: number;
  /** индекс в очереди 0..2; -1 после размещения */
  trayIdx: number;
  pos: THREE.Vector3;
}

interface BoardLayout {
  cellPositions: THREE.Vector3[];
  slotPositions: THREE.Vector3[];
  side: number;
  tableZ: number;
  standZ: number;
  queueZ: number;
}

/* ------------------------------------------------------------------ */
/* Константы раскладки                                                 */
/* ------------------------------------------------------------------ */

/** Шаг сетки ячеек (диаметр тарелки + просвет) */
const CELL = 2.5;
/** Высота кусочка над тарелкой */
const SLOT_Y = 0.1;
/** Лёгкая «лесенка» кусочков — читается верхний (последний) кусок */
const STAIR = 0.032;
/** Высота переноса тарелки при перетаскивании */
const DRAG_Y = 1.35;
/** Высота полки очереди — ниже уровня стола (отдельная зона, ТЗ п. 2.2) */
const TRAY_Y = -0.45;
/** Сектор одного кусочка (60°) */
const SECTOR = Math.PI / 3;
/** Радиус захвата свободной ячейки при перетаскивании */
const SNAP_DIST = CELL * 0.55;

/** Угол слота i: кусочек №0 «смотрит» на игрока, дальше — по кругу */
function slotAngle(i: number): number {
  return -Math.PI / 2 + i * SECTOR;
}

/** Кратчайший путь поворота: возвращает целевой угол рядом с from */
function nearAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return from + d;
}

/** Поле rows×cols по центру; подставка сзади, полка очереди — отдельной зоной спереди */
function gridLayout(rows: number, cols: number): BoardLayout {
  const w = (cols - 1) * CELL;
  const h = (rows - 1) * CELL;
  const standZ = -h / 2 - 1.75;
  const boardFrontZ = h / 2 + PLATE_RADIUS;
  const tableBackZ = standZ - 1.15;
  const tableFrontZ = boardFrontZ + 0.55;
  const boardW = w + PLATE_RADIUS * 2;
  const side = THREE.MathUtils.clamp(Math.max(boardW + 2.6, tableFrontZ - tableBackZ + 0.8), 8.8, 14.5);
  const tableZ = (tableFrontZ + tableBackZ) / 2;
  // полка вплотную к реальному переднему краю стола (clamp может его расширить)
  const realFront = tableZ + side / 2;
  const queueZ = Math.max(tableFrontZ, realFront) + 0.62 + 1.28;
  const slotPositions = [-2.35, 0, 2.35].map((x) => new THREE.Vector3(x, TRAY_Y, queueZ));
  const cellPositions: THREE.Vector3[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cellPositions.push(new THREE.Vector3(c * CELL - w / 2, 0, r * CELL - h / 2));
    }
  }
  return { cellPositions, slotPositions, side, tableZ, standZ, queueZ };
}

/* ------------------------------------------------------------------ */
/* Движок                                                              */
/* ------------------------------------------------------------------ */

export class PuzzleEngine {
  static async create(container: HTMLElement, ui: PuzzleUI, startLevel = 0): Promise<PuzzleEngine> {
    return new PuzzleEngine(container, ui, startLevel);
  }

  private readonly container: HTMLElement;
  private readonly ui: PuzzleUI;
  private readonly sfx = new PuzzleSfx();

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private raycaster = new THREE.Raycaster();
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private state!: GState;
  private level!: LevelData;
  private levelIdx = 0;
  private targetCakes = 0;
  private moves = 0;
  private phase: Phase = 'idle';

  private layout!: BoardLayout;
  private table: THREE.Group | null = null;
  private tableSide = 0;
  private stand: THREE.Group | null = null;

  /** тарелки на поле: ячейка → вид */
  private plateViews = new Map<CellIndex, PlateView>();
  /** видимые тарелки очереди, отсортированы по trayIdx */
  private trayItems: PlateView[] = [];
  /** тарелки, растворяющиеся после сборки торта/переноса */
  private dyingPlates: PlateView[] = [];
  /** Летящие на подставку торты */
  private activeCakes = new Set<THREE.Group>();
  /** Номер поколения уровня — сбрасывает отложенные колбэки при перезагрузке */
  private gen = 0;

  /** активное перетаскивание */
  private drag: { view: PlateView; pointerId: number; targetCell: CellIndex | null } | null = null;
  private highlightCell: CellIndex | null = null;

  /** метки ячеек поля */
  private cellRings: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }> = [];
  private cellDiscs: THREE.Mesh[] = [];
  private cellDiscMat: THREE.MeshStandardMaterial | null = null;
  private markGeometry: { disc: THREE.CylinderGeometry; ring: THREE.TorusGeometry } | null = null;
  private queueTray: THREE.Group | null = null;

  private particlePool: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }> = [];
  private activeParticles: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }> = [];
  /** Золотые кольца-подсказки */
  private hintRings: THREE.Mesh[] = [];

  private raf = 0;
  private clockStart = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  /** Точки контента уровня для кадрирования камеры */
  private contentPts: THREE.Vector3[] = [];
  private readonly camElev = THREE.MathUtils.degToRad(51);

  private constructor(container: HTMLElement, ui: PuzzleUI, startLevel = 0) {
    this.container = container;
    this.ui = ui;
    this.initScene();
    this.initParticles();
    this.bindInput();
    this.loadLevel(startLevel);
  }

  /* --------------------------- Сцена -------------------------------- */

  private initScene(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x161009);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);

    // Свет: тёплая витрина
    const key = new THREE.DirectionalLight(0xffe2b8, 3.0);
    key.position.set(5, 12, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -9;
    key.shadow.camera.right = 9;
    key.shadow.camera.top = 9;
    key.shadow.camera.bottom = -9;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 40;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xfff4e0, 0.95);
    fill.position.set(-6, 6, 8);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffd9a0, 1.1);
    rim.position.set(-3, 8, -9);
    this.scene.add(rim);

    const hemi = new THREE.HemisphereLight(0x3a2f22, 0x120d08, 0.5);
    this.scene.add(hemi);

    // Золотая подставка для готовых тортов (позиция — в loadLevel)
    this.stand = buildCenterStand();
    this.scene.add(this.stand);

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  private initParticles(): void {
    const geo = new THREE.SphereGeometry(0.07, 8, 6);
    for (let i = 0; i < 80; i++) {
      const m = new THREE.Mesh(geo, sparkMaterial());
      m.visible = false;
      this.scene.add(m);
      const p = { mesh: m, vel: new THREE.Vector3(), life: 0, maxLife: 1 };
      this.particlePool.push(p);
    }
  }

  private frameLevel(): void {
    const l = this.layout;
    const pad = PLATE_RADIUS + 0.18;
    const pts: THREE.Vector3[] = [];
    for (const p of l.cellPositions) {
      pts.push(new THREE.Vector3(p.x - pad, 0, p.z + pad));
      pts.push(new THREE.Vector3(p.x + pad, 0, p.z + pad));
      pts.push(new THREE.Vector3(p.x, 2.25, p.z));
    }
    for (const s of l.slotPositions) {
      pts.push(new THREE.Vector3(s.x - pad, TRAY_Y, s.z + pad));
      pts.push(new THREE.Vector3(s.x + pad, TRAY_Y, s.z + pad));
      pts.push(new THREE.Vector3(s.x, DRAG_Y, s.z));
    }
    pts.push(new THREE.Vector3(-1.15, 0, l.standZ - 1.15));
    pts.push(new THREE.Vector3(1.15, 0, l.standZ - 1.15));
    pts.push(new THREE.Vector3(-1.1, 1.4, l.standZ));
    pts.push(new THREE.Vector3(1.1, 1.4, l.standZ));
    this.contentPts = pts;
    this.fitToContent();
  }

  /** Численная подгонка камеры: все точки контента — в кадре, сверху запас под HUD */
  private fitToContent(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = Math.max(0.3, w / h);
    this.camera.aspect = aspect;

    const elev = this.camElev;
    let cz = 0;
    let dist = 13;
    for (let iter = 0; iter < 12; iter++) {
      this.camera.position.set(0, 0.85 + dist * Math.sin(elev), cz + dist * Math.cos(elev));
      this.camera.lookAt(0, 0.85, cz);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld(true);

      let top = 0;
      let bot = 0;
      let side = 0;
      for (const p of this.contentPts) {
        const v = p.clone().project(this.camera);
        if (v.y > top) top = v.y;
        if (-v.y > bot) bot = -v.y;
        if (Math.abs(v.x) > side) side = Math.abs(v.x);
      }

      cz -= (top - bot) * dist * 0.06;
      const need = Math.max(top / 0.8, bot / 0.88, side / 0.92);
      dist *= THREE.MathUtils.clamp(need, 0.8, 1.25);
      if (Math.abs(need - 1) < 0.006 && Math.abs(top - bot) < 0.012) break;
    }
    this.camera.position.set(0, 0.85 + dist * Math.sin(elev), cz + dist * Math.cos(elev));
    this.camera.lookAt(0, 0.85, cz);
    this.camera.updateProjectionMatrix();
  }

  private onResize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.fitToContent();
  }

  /* -------------------------- Уровень -------------------------------- */

  private killView(view: PlateView): void {
    for (const s of view.slices) {
      gsap.killTweensOf(s.position);
      gsap.killTweensOf(s.rotation);
      gsap.killTweensOf(s.scale);
    }
    gsap.killTweensOf(view.group.position);
    gsap.killTweensOf(view.group.scale);
    view.group.removeFromParent();
  }

  private clearBoard(): void {
    for (const v of this.plateViews.values()) this.killView(v);
    for (const v of this.trayItems) this.killView(v);
    for (const v of this.dyingPlates) this.killView(v);
    this.plateViews.clear();
    this.trayItems = [];
    this.dyingPlates = [];
    this.drag = null;
    this.setHighlight(null);
    this.clearHints();
    for (const cake of this.activeCakes) {
      gsap.killTweensOf(cake.position);
      gsap.killTweensOf(cake.rotation);
      gsap.killTweensOf(cake.scale);
      cake.removeFromParent();
    }
    this.activeCakes.clear();
    for (const r of this.cellRings) {
      gsap.killTweensOf(r.mesh.scale);
      gsap.killTweensOf(r.mat);
      r.mesh.removeFromParent();
      r.mat.dispose();
    }
    this.cellRings = [];
    for (const d of this.cellDiscs) d.removeFromParent();
    this.cellDiscs = [];
    this.cellDiscMat?.dispose();
    this.cellDiscMat = null;
    if (this.queueTray) {
      this.queueTray.removeFromParent();
      this.queueTray = null;
    }
  }

  private rebuildTable(side: number, tableZ: number): void {
    if (this.table && this.tableSide === side) {
      this.table.position.z = tableZ;
      return;
    }
    this.table?.removeFromParent();
    this.table = buildSquareTable(side);
    this.table.position.z = tableZ;
    this.scene.add(this.table);
    this.tableSide = side;
  }

  loadLevel(idx: number): void {
    this.clearBoard();
    this.gen += 1;
    this.levelIdx = idx;
    this.level = getLevel(idx);
    this.state = createInitialState(this.level);
    this.targetCakes = totalCakes(this.level);
    this.moves = 0;
    this.phase = 'idle';

    this.layout = gridLayout(this.state.rows, this.state.cols);
    this.rebuildTable(this.layout.side, this.layout.tableZ);
    this.stand?.position.set(0, 0, this.layout.standZ);

    this.buildCellMarks();
    this.buildQueueTray();

    // начальные тарелки на поле
    let spawnDelay = 0.05;
    for (let cell = 0; cell < this.state.board.length; cell++) {
      const p = this.state.board[cell];
      if (!p) continue;
      const view = this.makePlateView(p.slices.map((s) => s.flavor));
      const pos = this.layout.cellPositions[cell];
      view.cell = cell;
      view.pos.copy(pos);
      view.group.position.copy(pos);
      this.scene.add(view.group);
      this.plateViews.set(cell, view);
      view.slices.forEach((m, i) => {
        m.scale.setScalar(0.01);
        gsap.to(m.scale, { x: 1, y: 1, z: 1, duration: 0.3, ease: 'back.out(2)', delay: spawnDelay + i * 0.03 });
      });
      spawnDelay += 0.07;
    }

    // очередь: первые три тарелки
    for (let i = 0; i < Math.min(3, this.state.tray.length); i++) {
      this.spawnTrayItem(i, 0.3 + i * 0.09);
    }

    this.frameLevel();
    this.emitStats();
    this.ui.onToast(`Уровень ${idx + 1} — тортов: ${this.targetCakes}`);
  }

  /** Метки ячеек поля: тёмный диск + тонкое золотое кольцо */
  private buildCellMarks(): void {
    if (!this.markGeometry) {
      this.markGeometry = {
        disc: new THREE.CylinderGeometry(1.06, 1.06, 0.025, 36),
        ring: new THREE.TorusGeometry(1.06, 0.028, 8, 48),
      };
    }
    const { disc, ring } = this.markGeometry;
    const discMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.85, metalness: 0.03 });
    this.cellDiscMat = discMat;
    for (const pos of this.layout.cellPositions) {
      const d = new THREE.Mesh(disc, discMat);
      d.position.set(pos.x, 0.005, pos.z);
      d.receiveShadow = true;
      this.scene.add(d);
      this.cellDiscs.push(d);

      const mat = new THREE.MeshBasicMaterial({ color: 0xd4af37, transparent: true, opacity: 0.38 });
      const r = new THREE.Mesh(ring, mat);
      r.rotation.x = -Math.PI / 2;
      r.position.set(pos.x, 0.03, pos.z);
      this.scene.add(r);
      this.cellRings.push({ mesh: r, mat });
    }
  }

  /** Мраморный поднос очереди на золотой кромке */
  private buildQueueTray(): void {
    const g = new THREE.Group();
    const trayW = 7.5;
    const trayD = 2.55;

    // тёплое тёмное дерево — зона очереди отличается от мраморного поля
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 0.55, metalness: 0.06 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(trayW, 0.2, trayD), woodMat);
    top.position.y = TRAY_Y - 0.1;
    top.receiveShadow = true;
    top.castShadow = true;
    g.add(top);

    const band = new THREE.Mesh(new THREE.BoxGeometry(trayW + 0.12, 0.075, trayD + 0.12), goldMaterial());
    band.position.y = TRAY_Y - 0.17;
    band.castShadow = true;
    g.add(band);

    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(trayW * 0.82, 1.15, trayD * 0.72),
      new THREE.MeshStandardMaterial({ color: 0x241609, roughness: 0.72, metalness: 0.05 }),
    );
    apron.position.y = TRAY_Y - 0.72;
    g.add(apron);

    g.position.set(0, 0, this.layout.queueZ);
    this.scene.add(g);
    this.queueTray = g;
  }

  /* ----------------------- Представление тарелок --------------------- */

  /** Кусочек в свой сектор (локальные координаты тарелки) */
  private setSlotLocal(slice: SliceMesh, slot: number): void {
    slice.position.set(0, SLOT_Y + slot * STAIR, 0);
    slice.rotation.y = slotAngle(slot);
  }

  private makePlateView(flavors: Flavor[]): PlateView {
    const group = buildPlate();
    const slices: SliceMesh[] = [];
    flavors.forEach((f, slot) => {
      const m = buildSlice(f);
      this.setSlotLocal(m, slot);
      group.add(m);
      slices.push(m);
    });
    return { group, slices, cell: -1, trayIdx: -1, pos: new THREE.Vector3() };
  }

  private spawnTrayItem(trayIdx: number, delay = 0): PlateView {
    const flavors = this.state.tray[trayIdx] ?? [];
    const view = this.makePlateView(flavors);
    view.trayIdx = trayIdx;
    const pos = this.layout.slotPositions[trayIdx];
    view.pos.copy(pos);
    view.group.position.copy(pos);
    view.group.scale.setScalar(0.01);
    this.scene.add(view.group);
    gsap.to(view.group.scale, { x: 1, y: 1, z: 1, duration: 0.34, ease: 'back.out(1.9)', delay });
    this.trayItems.push(view);
    this.trayItems.sort((a, b) => a.trayIdx - b.trayIdx);
    return view;
  }

  /** После размещения: оставшиеся тарелки сдвигаются, справа новая */
  private refreshTray(): void {
    this.trayItems.forEach((it, i) => {
      it.trayIdx = i;
      const target = this.layout.slotPositions[i];
      it.pos.copy(target);
      gsap.to(it.group.position, { x: target.x, z: target.z, duration: 0.3, ease: 'power2.inOut', overwrite: 'auto' });
    });
    if (this.state.tray.length > this.trayItems.length) {
      this.spawnTrayItem(this.trayItems.length, 0.16);
    }
  }

  private discardPlateView(view: PlateView): void {
    this.dyingPlates.push(view);
    const gen = this.gen;
    gsap.to(view.group.scale, {
      x: 0.01,
      y: 0.01,
      z: 0.01,
      duration: 0.3,
      delay: 0.45,
      ease: 'back.in(1.6)',
      onComplete: () => {
        view.group.removeFromParent();
        if (gen === this.gen) {
          const i = this.dyingPlates.indexOf(view);
          if (i >= 0) this.dyingPlates.splice(i, 1);
        }
      },
    });
  }

  /* --------------------------- Ввод ---------------------------------- */

  private bindInput(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
  }

  private unbindInput(): void {
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerCancel);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.sfx.unlock();
    if (this.phase !== 'idle' || this.disposed || this.drag) return;
    const idx = this.pickTraySlot(e.clientX, e.clientY);
    if (idx < 0) return;
    const view = this.trayItems[idx];
    this.drag = { view, pointerId: e.pointerId, targetCell: null };
    this.phase = 'dragging';
    this.sfx.select();
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* стилизованные тесты/странные устройства — не критично */
    }
    gsap.killTweensOf(view.group.position);
    gsap.to(view.group.position, { y: DRAG_Y, duration: 0.2, ease: 'power2.out', overwrite: 'auto' });
    this.updateDragTarget(e.clientX, e.clientY);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const p = this.pointerToWorld(e.clientX, e.clientY);
    if (p) {
      this.drag.view.group.position.x = p.x;
      this.drag.view.group.position.z = p.z;
    }
    this.updateDragTarget(e.clientX, e.clientY);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const { view, targetCell } = this.drag;
    this.drag = null;
    if (targetCell !== null && canPlace(this.state, targetCell)) {
      void this.placeFromTray(view, targetCell);
    } else {
      this.cancelDrag(view);
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const view = this.drag.view;
    this.drag = null;
    this.cancelDrag(view);
  };

  /** Отпустить тарелку вне поля — плавный возврат в слот очереди (ТЗ 4.2) */
  private cancelDrag(view: PlateView): void {
    this.setHighlight(null);
    this.phase = 'idle';
    gsap.to(view.group.position, {
      x: view.pos.x,
      y: view.pos.y,
      z: view.pos.z,
      duration: 0.3,
      ease: 'back.out(1.3)',
      overwrite: 'auto',
    });
  }

  /** Тарелка очереди по экранным координатам: ближайший центр в радиусе тарелки */
  private pickTraySlot(clientX: number, clientY: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const v = new THREE.Vector3();
    let best = -1;
    let bestD = Infinity;

    for (let i = 0; i < this.trayItems.length; i++) {
      const pos = this.trayItems[i].group.position;
      v.set(pos.x, TRAY_Y + 0.4, pos.z).project(this.camera);
      const cx = ((v.x + 1) / 2) * rect.width;
      const cy = ((-v.y + 1) / 2) * rect.height;
      v.set(pos.x + PLATE_RADIUS, TRAY_Y + 0.4, pos.z).project(this.camera);
      const rx = Math.abs(((v.x + 1) / 2) * rect.width - cx);
      const limit = Math.max(rx * 1.3, 30);
      const d = Math.hypot(px - cx, py - cy);
      if (d < limit && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Мировая точка на плоскости стола под указателем */
  private pointerToWorld(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.dragPlane, out) ? out : null;
  }

  /** Ближайшая свободная ячейка под тарелкой + подсветка (ТЗ 4.1.3–4) */
  private updateDragTarget(clientX: number, clientY: number): void {
    if (!this.drag) return;
    const p = this.pointerToWorld(clientX, clientY);
    let found: CellIndex | null = null;
    if (p) {
      let bestD = SNAP_DIST * SNAP_DIST;
      for (const cell of freeCells(this.state)) {
        const cp = this.layout.cellPositions[cell];
        const d = (cp.x - p.x) ** 2 + (cp.z - p.z) ** 2;
        if (d < bestD) {
          bestD = d;
          found = cell;
        }
      }
    }
    if (found !== this.drag.targetCell) {
      this.drag.targetCell = found;
      this.setHighlight(found);
    }
  }

  private setHighlight(cell: CellIndex | null): void {
    if (this.highlightCell !== null) {
      const prev = this.cellRings[this.highlightCell];
      if (prev) {
        gsap.killTweensOf(prev.mesh.scale);
        gsap.killTweensOf(prev.mat);
        prev.mesh.scale.setScalar(1);
        prev.mat.opacity = 0.38;
        prev.mat.color.setHex(0xd4af37);
      }
    }
    this.highlightCell = cell;
    if (cell !== null) {
      const ring = this.cellRings[cell];
      if (ring) {
        ring.mat.opacity = 0.95;
        ring.mat.color.setHex(0xffe9a8);
        gsap.fromTo(
          ring.mesh.scale,
          { x: 1, y: 1, z: 1 },
          { x: 1.1, y: 1, z: 1.1, duration: 0.4, yoyo: true, repeat: -1, ease: 'sine.inOut' },
        );
      }
    }
  }

  /* --------------------------- Ходы ----------------------------------- */

  /** Размещение тарелки из очереди на ячейку (ТЗ 4.1.5) */
  private async placeFromTray(view: PlateView, cell: CellIndex): Promise<void> {
    this.setHighlight(null);
    this.phase = 'placing';
    this.moves += 1;
    this.emitStats();
    this.sfx.place();

    // 1) данные — источник истины (ТЗ 9.5)
    placePlate(this.state, view.trayIdx, cell);

    // 2) вид: тарелка летит в ячейку
    const gen = this.gen;
    view.trayIdx = -1;
    view.cell = cell;
    view.pos.copy(this.layout.cellPositions[cell]);
    this.plateViews.set(cell, view);
    this.trayItems = this.trayItems.filter((it) => it !== view);
    const target = this.layout.cellPositions[cell];
    gsap.to(view.group.position, {
      x: target.x,
      y: 0,
      z: target.z,
      duration: 0.3,
      ease: 'power2.inOut',
      overwrite: 'auto',
    });
    this.refreshTray();

    await pzDelay(0.34);
    if (gen !== this.gen || this.disposed) return;
    await this.runResolution(cell);
  }

  /**
   * Автоматическая сортировка (ТЗ 5.5): перенос → торт → повтор.
   * Данные применяются до анимации; анимация отражает уже изменённое
   * состояние. Ввод заблокирован до завершения (ТЗ 4.4).
   */
  private async runResolution(lastPlaced: CellIndex): Promise<void> {
    this.phase = 'resolving';
    const gen = this.gen;

    const done0 = findCompletion(this.state);
    if (done0) {
      applyCompletion(this.state, done0.cell);
      await this.playCake(done0.cell, done0.flavor);
      if (gen !== this.gen || this.disposed) return;
    }

    for (;;) {
      const t = planNextTransfer(this.state, lastPlaced);
      if (!t) break;
      applyTransfer(this.state, t);
      await this.playTransfer(t);
      if (gen !== this.gen || this.disposed) return;
      if (!this.state.board[t.from]) this.discardPlateView(this.plateViews.get(t.from)!);
      const done = findCompletion(this.state);
      if (done) {
        applyCompletion(this.state, done.cell);
        await this.playCake(done.cell, done.flavor);
        if (gen !== this.gen || this.disposed) return;
      }
    }

    this.finishTurn();
  }

  /** Перелёт кусочков с донора на получателя (ТЗ 8.3.6) */
  private async playTransfer(t: { from: CellIndex; to: CellIndex; flavor: Flavor; count: number }): Promise<void> {
    const fromView = this.plateViews.get(t.from);
    const toView = this.plateViews.get(t.to);
    if (!fromView || !toView) {
      await pzDelay(0.1);
      return;
    }
    const moving: SliceMesh[] = [];
    for (let i = fromView.slices.length - 1; i >= 0 && moving.length < t.count; i--) {
      if (fromView.slices[i].userData.type === t.flavor) {
        moving.unshift(fromView.slices.splice(i, 1)[0]);
      }
    }

    const baseSlot = toView.slices.length;
    const flightDur = 0.42;
    moving.forEach((m, i) => {
      const slot = baseSlot + i;
      toView.slices.push(m);
      // репарентинг с сохранением мировой трансформации (группы без вращения/масштаба)
      toView.group.attach(m);
      const targetY = SLOT_Y + slot * STAIR;
      const targetRy = nearAngle(m.rotation.y, slotAngle(slot));
      const peak = Math.max(m.position.y, SLOT_Y) + 1.25;
      const delay = i * 0.07;

      gsap.to(m.position, { x: 0, z: 0, duration: flightDur, delay, ease: 'power1.inOut', overwrite: 'auto' });
      gsap.to(m.rotation, { y: targetRy, duration: flightDur, delay, ease: 'power1.inOut', overwrite: 'auto' });
      gsap.to(m.position, { y: peak, duration: flightDur * 0.45, delay, ease: 'power1.out', overwrite: 'auto' });
      gsap.to(m.position, {
        y: targetY,
        duration: flightDur * 0.55,
        delay: delay + flightDur * 0.45,
        ease: 'power1.in',
        onComplete:
          i === moving.length - 1
            ? () => {
                if (this.disposed) return;
                this.burst(toView.pos.x, 0.5, toView.pos.z, 6, 0xf0d9a8);
              }
            : undefined,
      });
    });

    await pzDelay(flightDur + Math.max(0, moving.length - 1) * 0.07 + 0.06);
  }

  /* --------------------------- Сборка торта --------------------------- */

  /** Шесть одинаковых кусочков: торт с короной летит на подставку (ТЗ 5.7, 8.3.7–8) */
  private async playCake(cell: CellIndex, flavor: Flavor): Promise<void> {
    const view = this.plateViews.get(cell);
    if (!view) {
      await pzDelay(0.2);
      return;
    }
    this.plateViews.delete(cell);
    const meshes = view.slices;
    view.slices = [];
    const gen = this.gen;
    const platePos = view.pos.clone();

    // 1) «Утряска»: лесенка выравнивается в ровный круг + лёгкий пульс
    meshes.forEach((m, i) => {
      gsap.to(m.position, { y: SLOT_Y, duration: 0.26, delay: i * 0.02, ease: 'power2.inOut' });
      gsap.fromTo(
        m.scale,
        { x: 1, y: 1, z: 1 },
        { x: 1.07, y: 1.07, z: 1.07, duration: 0.13, delay: 0.1 + i * 0.02, yoyo: true, repeat: 1, ease: 'sine.inOut' },
      );
    });

    // пустая тарелка растворяется следом за тортом
    this.discardPlateView(view);

    // 2) Торт получает корону, взлетает и летит на подставку
    gsap.delayedCall(0.55, () => {
      if (gen !== this.gen || this.disposed) return;

      const cake = new THREE.Group();
      cake.position.copy(platePos);
      this.scene.add(cake);
      this.activeCakes.add(cake);
      for (const m of meshes) {
        gsap.killTweensOf(m.position);
        gsap.killTweensOf(m.scale);
        cake.attach(m);
      }
      const crown = buildCakeCrown(flavor);
      crown.position.y = SLICE_HEIGHT + 0.055;
      cake.add(crown);

      const tl = gsap.timeline({
        onComplete: () => {
          this.activeCakes.delete(cake);
          cake.removeFromParent();
          if (gen !== this.gen || this.disposed) return;
          this.sfx.merge();
          this.ui.onToast(`${CAKE_TYPES[flavor].name} торт — готов!`);
        },
      });

      // взлёт + оборот
      tl.to(cake.position, { y: 1.2, duration: 0.32, ease: 'back.out(1.8)' });
      tl.to(cake.rotation, { y: Math.PI * 2, duration: 0.55, ease: 'power1.inOut' }, '<');
      // полёт на золотую подставку
      tl.to(cake.position, {
        x: 0,
        z: this.layout.standZ,
        y: STAND_CAKE_Y + 0.5,
        duration: 0.6,
        ease: 'power1.inOut',
      });
      tl.to(cake.position, { y: STAND_CAKE_Y, duration: 0.16, ease: 'power1.out' }, '<+=0.6');
      tl.call(() => this.burst(0, STAND_CAKE_Y + 0.4, this.layout.standZ, 14, 0xffd97a));
      tl.to(cake.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 0.28, ease: 'back.in(1.6)' }, '+=0.4');
      tl.to(cake.position, { y: STAND_CAKE_Y + 0.55, duration: 0.28, ease: 'power1.in' }, '<');
    });

    // утряска 0.55 + полёт ~1.9
    await pzDelay(2.35);
  }

  /* ------------------------ Конец хода/уровня ------------------------- */

  private finishTurn(): void {
    const end = evalEnd(this.state);
    if (end.phase === 'won') {
      this.phase = 'won';
      this.burst(0, 2.0, this.layout.standZ, 20, 0xffd97a);
      this.sfx.levelWin();
      this.ui.onLevelDone(this.levelIdx + 1, this.moves);
      return;
    }
    if (end.phase === 'lost') {
      this.phase = 'lost';
      this.sfx.stuck();
      this.ui.onStuck(this.moves, this.state.completed, this.targetCakes, end.reason);
      return;
    }
    this.phase = 'idle';
  }

  /* -------------------------- Частицы --------------------------------- */

  private burst(x: number, y: number, z: number, count: number, color: number): void {
    if (this.disposed) return;
    for (let i = 0; i < count; i++) {
      const p = this.particlePool.pop();
      if (!p) return;
      (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      p.mesh.position.set(x, y, z);
      p.mesh.visible = true;
      const ang = Math.random() * Math.PI * 2;
      p.vel.set(Math.cos(ang) * (1 + Math.random() * 2.4), 2.2 + Math.random() * 3.4, Math.sin(ang) * (0.8 + Math.random() * 1.6));
      p.maxLife = 0.5 + Math.random() * 0.45;
      p.life = p.maxLife;
      this.activeParticles.push(p);
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.activeParticles.length - 1; i >= 0; i--) {
      const p = this.activeParticles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        this.activeParticles.splice(i, 1);
        this.particlePool.push(p);
        continue;
      }
      p.vel.y -= 14 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(Math.max(0.01, p.life / p.maxLife));
    }
  }

  /* --------------------------- Подсказка ------------------------------ */

  /**
   * Подсказка: солвер решает текущее состояние и подсвечивает тарелку
   * очереди и ячейку первого хода. Возвращает true, если подсказка показана.
   */
  hint(): boolean {
    if (this.phase !== 'idle' || this.disposed) return false;
    const sol = solve(cloneState(this.state), 150000);
    if (!sol || sol.length === 0) return false;
    this.sfx.hint();
    const mv = sol[0];
    this.clearHints();
    const gen = this.gen;
    const item = this.trayItems.find((it) => it.trayIdx === mv.trayIdx);
    if (item) this.addHintRing(item.group.position);
    this.addHintRing(this.layout.cellPositions[mv.cell]);
    gsap.delayedCall(2.7, () => {
      if (this.gen === gen) this.clearHints();
    });
    return true;
  }

  /** Пульсирующее золотое кольцо-подсказка */
  private addHintRing(pos: THREE.Vector3): void {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(PLATE_RADIUS * 1.2, 0.055, 10, 48),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.95 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.08, pos.z);
    this.scene.add(ring);
    this.hintRings.push(ring);
    gsap.fromTo(
      ring.scale,
      { x: 1, y: 1, z: 1 },
      { x: 1.16, y: 1.16, z: 1, duration: 0.42, yoyo: true, repeat: 5, ease: 'sine.inOut' },
    );
  }

  private clearHints(): void {
    for (const r of this.hintRings) {
      gsap.killTweensOf(r.scale);
      r.geometry.dispose();
      (r.material as THREE.Material).dispose();
      r.removeFromParent();
    }
    this.hintRings = [];
  }

  /* --------------------------- Прочее ---------------------------------- */

  private emitStats(): void {
    this.ui.onStats({
      level: this.levelIdx + 1,
      moves: this.moves,
      collected: this.state.completed,
      cakes: this.targetCakes,
    });
  }

  restartLevel(): void {
    if (this.disposed) return;
    this.loadLevel(this.levelIdx);
  }

  nextLevel(): void {
    if (this.disposed) return;
    this.loadLevel(this.levelIdx + 1); // уровни зациклены после последнего
  }

  start(): void {
    this.clockStart = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private lastT = 0;
  private tick = (nowMs: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const t = (nowMs - this.clockStart) / 1000;
    const dt = Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;

    // лёгкое парение тарелки при перетаскивании
    if (this.drag) {
      const bob = Math.sin(t * 3.2) * 0.05;
      const g = this.drag.view.group;
      if (!gsap.isTweening(g.position)) g.position.y += (DRAG_Y + bob - g.position.y) * Math.min(1, dt * 8);
    }

    this.updateParticles(dt);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unbindInput();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.clearBoard();
    // ВАЖНО: не трогаем gsap.globalTimeline — при двойном монтировании
    // (React StrictMode) он убивал твины спавна второго экземпляра движка.
    for (const p of [...this.activeParticles, ...this.particlePool]) p.mesh.visible = false;
    if (this.markGeometry) {
      this.markGeometry.disc.dispose();
      this.markGeometry.ring.dispose();
      this.markGeometry = null;
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* ------------------- Отладка и автотесты ----------------------------- */

  /** Экранные координаты ячейки поля (для e2e-тестов) */
  screenPosCell(cell: CellIndex): { x: number; y: number } {
    const pos = this.layout.cellPositions[cell];
    const v = pos.clone().setY(0.5).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((-v.y + 1) / 2) * rect.height,
    };
  }

  /** Экранные координаты тарелки очереди по trayIdx (для e2e-тестов) */
  screenPosTray(trayIdx: number): { x: number; y: number } {
    const item = this.trayItems.find((it) => it.trayIdx === trayIdx);
    const pos = item ? item.group.position : this.layout.slotPositions[trayIdx];
    const v = pos.clone().setY(TRAY_Y + 0.4).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((-v.y + 1) / 2) * rect.height,
    };
  }

  /** Отладка кадрирования: позиция камеры и экстремумы контента в NDC */
  debugFrame(): { camY: number; camZ: number; top: number; bot: number; side: number } {
    let top = 0;
    let bot = 0;
    let side = 0;
    for (const p of this.contentPts) {
      const v = p.clone().project(this.camera);
      if (v.y > top) top = v.y;
      if (-v.y > bot) bot = -v.y;
      if (Math.abs(v.x) > side) side = Math.abs(v.x);
    }
    return { camY: this.camera.position.y, camZ: this.camera.position.z, top, bot, side };
  }

  /** Полное состояние для e2e-тестов */
  debugState(): {
    phase: string;
    moves: number;
    collected: number;
    cakes: number;
    free: number;
    tray: number[][];
    board: Array<{ cell: number; flavors: number[] }>;
    highlight: number | null;
  } {
    return {
      phase: this.phase,
      moves: this.moves,
      collected: this.state.completed,
      cakes: this.targetCakes,
      free: freeCells(this.state).length,
      tray: this.state.tray.map((t) => [...t]),
      board: this.state.board.flatMap((p, cell) => (p ? [{ cell, flavors: p.slices.map((s) => s.flavor) }] : [])),
      highlight: this.highlightCell,
    };
  }

  /** Ускорение анимаций (для тестов) */
  setSpeed(mult: number): void {
    gsap.globalTimeline.timeScale(mult);
  }

  /** Ожидание полного простоя (нет разрешения хода/анимаций) */
  async waitIdle(): Promise<void> {
    for (let i = 0; i < 3000; i++) {
      const calm = this.phase === 'idle' || this.phase === 'won' || this.phase === 'lost';
      if (calm && this.activeParticles.length === 0) return;
      await pzDelay(50);
    }
  }

  /** Автоматическое прохождение уровня солвером (тесты) */
  async autosolve(): Promise<void> {
    await this.waitIdle();
    if (this.phase !== 'idle' || this.disposed) return;
    const sol = solve(cloneState(this.state), 200000);
    if (!sol) return;
    for (const mv of sol) {
      if (this.disposed) return;
      await this.waitIdle();
      if (this.phase !== 'idle') return;
      const item = this.trayItems.find((it) => it.trayIdx === mv.trayIdx);
      if (!item) return;
      void this.placeFromTray(item, mv.cell);
    }
    await this.waitIdle();
  }
}

/** Пауза на тикере gsap — не троттлится браузером в фоне (для тестов) */
function pzDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    gsap.delayedCall(ms / 1000, resolve);
  });
}
