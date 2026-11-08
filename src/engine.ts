/**
 * Cake Sort — Auto Merge Mechanic
 * Игровой движок: сцена three.js, физика Rapier, автослияние десертов.
 * Класс не зависит от фреймворка: одинаково работает в Next.js и Vite-версии.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import gsap from 'gsap';
import { TIERS, TIER_COUNT, WORLD, PALETTE, randomSpawnTier } from './config';
import { buildDessertMesh, tierColor } from './desserts';
import { Sfx } from './sfx';

/* ------------------------------------------------------------------ */
/* Публичные типы                                                      */
/* ------------------------------------------------------------------ */

export interface CakeSortUI {
  onStats(moves: number, collected: number): void;
  onToast(text: string): void;
  onEnd(win: boolean, moves: number, collected: number): void;
}

type GameState = 'playing' | 'won' | 'over';

interface Dessert {
  tier: number;
  body: RAPIER.RigidBody;
  colliderHandle: number;
  mesh: THREE.Group;
  merging: boolean;
  hasContact: boolean;
  overfill: number;
}

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
}

/* ------------------------------------------------------------------ */
/* Инициализация Rapier (кэш на уровне модуля)                         */
/* ------------------------------------------------------------------ */

let rapierPromise: Promise<void> | null = null;

function ensureRapier(): Promise<void> {
  if (!rapierPromise) rapierPromise = RAPIER.init();
  return rapierPromise;
}

/* ------------------------------------------------------------------ */
/* Движок                                                              */
/* ------------------------------------------------------------------ */

export class CakeSortEngine {
  static async create(container: HTMLElement, ui: CakeSortUI): Promise<CakeSortEngine> {
    await ensureRapier();
    return new CakeSortEngine(container, ui);
  }

  private readonly container: HTMLElement;
  private readonly ui: CakeSortUI;
  private readonly sfx = new Sfx();

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private raycaster = new THREE.Raycaster();

  private world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private colliderToDessert = new Map<number, Dessert>();
  private desserts = new Set<Dessert>();
  private mergePairs: Array<[Dessert, Dessert]> = [];

  // Превью «текущий / следующий»
  private currentHolder!: THREE.Group;
  private currentMesh!: THREE.Group;
  private nextMesh!: THREE.Group;
  private aimLine!: THREE.Mesh;
  private currentTier = 0;
  private nextTier = 0;
  private targetX = 0;

  // Частицы
  private particlePool: Particle[] = [];
  private activeParticles: Particle[] = [];

  // Состояние партии
  private state: GameState = 'playing';
  private moves = 0;
  private collected = 0;
  private canDrop = true;
  private dropReadyAt = 0;

  // Цикл
  private raf = 0;
  private lastT = 0;
  private acc = 0;
  private readonly step = 1 / 60;
  private clockStart = 0;

  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  private constructor(container: HTMLElement, ui: CakeSortUI) {
    this.container = container;
    this.ui = ui;
    this.initScene();
    this.initPhysics();
    this.initPreview();
    this.initParticles();
    this.bindInput();
    this.resetRound(true);
  }

  /* ------------------------- Инициализация ------------------------- */

  private initScene(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.background);

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    this.fitCamera();

    // Свет
    const hemi = new THREE.HemisphereLight(0xfff8ee, 0xe8d5c0, 0.85);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff2df, 1.5);
    dir.position.set(6, 14, 7);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -9;
    dir.shadow.camera.right = 9;
    dir.shadow.camera.top = 14;
    dir.shadow.camera.bottom = -3;
    dir.shadow.camera.near = 2;
    dir.shadow.camera.far = 42;
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.03;
    this.scene.add(dir);

    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-5, 6, 9);
    this.scene.add(fill);

    // Стол
    const tableMat = new THREE.MeshStandardMaterial({ color: PALETTE.table, roughness: 0.85 });
    const table = new THREE.Mesh(new THREE.CylinderGeometry(9, 9.4, 0.5, 48), tableMat);
    table.position.y = -0.6;
    table.receiveShadow = true;
    this.scene.add(table);

    // Дно коробки
    const slabMat = new THREE.MeshStandardMaterial({ color: PALETTE.slab, roughness: 0.7 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(8.7, 0.35, 4.5), slabMat);
    slab.position.y = -0.175;
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.scene.add(slab);

    // Стеклянные стены
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: PALETTE.glass,
      transparent: true,
      opacity: 0.16,
      roughness: 0.08,
      metalness: 0,
      depthWrite: false,
    });
    const glassFront = glassMat.clone();
    glassFront.opacity = 0.07;

    const wallH = WORLD.rimY;
    const cx = WORLD.innerHalfWidth + WORLD.wall / 2; // 4.175
    const cz = WORLD.innerHalfDepth + WORLD.wall / 2; // 2.075

    const mkGlass = (sx: number, sy: number, sz: number, x: number, y: number, z: number, m: THREE.Material) => {
      const g = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
      g.position.set(x, y, z);
      g.renderOrder = 5;
      return g;
    };
    this.scene.add(mkGlass(WORLD.wall, wallH, 4.5, -cx, wallH / 2, 0, glassMat));
    this.scene.add(mkGlass(WORLD.wall, wallH, 4.5, cx, wallH / 2, 0, glassMat));
    this.scene.add(mkGlass(8.7, wallH, WORLD.wall, 0, wallH / 2, -cz, glassMat));
    this.scene.add(mkGlass(8.7, wallH, WORLD.wall, 0, wallH / 2, cz, glassFront));

    // Рамка сверху
    const frameMat = new THREE.MeshStandardMaterial({ color: PALETTE.frame, roughness: 0.5 });
    const mkFrame = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const g = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), frameMat);
      g.position.set(x, y, z);
      g.castShadow = true;
      return g;
    };
    const ry = WORLD.rimY;
    this.scene.add(mkFrame(0.55, 0.3, 4.95, -cx, ry, 0));
    this.scene.add(mkFrame(0.55, 0.3, 4.95, cx, ry, 0));
    this.scene.add(mkFrame(8.9, 0.3, 0.55, 0, ry, -cz));
    this.scene.add(mkFrame(8.9, 0.3, 0.55, 0, ry, cz));

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  private initPhysics(): void {
    this.world = new RAPIER.World({ x: 0, y: WORLD.gravityY, z: 0 });
    this.world.timestep = this.step;
    this.eventQueue = new RAPIER.EventQueue(true);

    const fixed = RAPIER.RigidBodyDesc.fixed();
    const floorBody = this.world.createRigidBody(fixed);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(WORLD.innerHalfWidth, 0.18, WORLD.innerHalfDepth)
        .setTranslation(0, -0.18, 0)
        .setFriction(0.6),
      floorBody,
    );

    const wallCx = WORLD.innerHalfWidth + WORLD.wall / 2;
    const wallCz = WORLD.innerHalfDepth + WORLD.wall / 2;
    const wallHalfH = (WORLD.rimY + 0.4) / 2;

    const mkWall = (hx: number, hy: number, hz: number, x: number, y: number, z: number) => {
      const b = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.3).setRestitution(0.05),
        b,
      );
    };
    const hw = WORLD.wall / 2;
    const hd = WORLD.innerHalfDepth + WORLD.wall / 2 + 0.1;
    mkWall(hw, wallHalfH, hd, -wallCx, wallHalfH, 0);
    mkWall(hw, wallHalfH, hd, wallCx, wallHalfH, 0);
    mkWall(WORLD.innerHalfWidth + 0.2, wallHalfH, hw, 0, wallHalfH, -wallCz);
    mkWall(WORLD.innerHalfWidth + 0.2, wallHalfH, hw, 0, wallHalfH, wallCz);
  }

  private initPreview(): void {
    this.currentHolder = new THREE.Group();
    this.currentHolder.position.set(0, WORLD.previewY, 0);
    this.scene.add(this.currentHolder);

    // Линия-прицел
    const lineH = WORLD.previewY - WORLD.rimY + 0.2;
    const lineMat = new THREE.MeshBasicMaterial({
      color: PALETTE.frame,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    this.aimLine = new THREE.Mesh(new THREE.BoxGeometry(0.06, lineH, 0.06), lineMat);
    this.aimLine.position.set(0, WORLD.previewY - lineH / 2 - 0.3, 0);
    this.scene.add(this.aimLine);
  }

  private initParticles(): void {
    const geo = new THREE.SphereGeometry(0.09, 10, 8);
    for (let i = 0; i < 90; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const m = new THREE.Mesh(geo, material);
      m.visible = false;
      this.scene.add(m);
      this.particlePool.push({ mesh: m, vel: new THREE.Vector3(), life: 0, maxLife: 1, baseScale: 1 });
    }
  }

  /* --------------------------- Раунд ------------------------------- */

  private resetRound(first: boolean): void {
    for (const d of [...this.desserts]) this.removeDessert(d);
    this.mergePairs.length = 0;
    this.moves = 0;
    this.collected = 0;
    this.state = 'playing';
    this.targetX = 0;
    this.canDrop = true;

    // Превью
    if (this.currentMesh) this.disposePreviewMesh(this.currentMesh);
    if (this.nextMesh) this.disposePreviewMesh(this.nextMesh);
    this.currentTier = randomSpawnTier();
    this.nextTier = randomSpawnTier();
    this.currentMesh = buildDessertMesh(this.currentTier);
    this.currentMesh.scale.setScalar(0.01);
    this.currentHolder.add(this.currentMesh);
    gsap.to(this.currentMesh.scale, { x: 1, y: 1, z: 1, duration: 0.35, ease: 'back.out(2)' });
    this.nextMesh = this.buildNextPreview();
    this.currentHolder.position.x = 0;

    this.emitStats();
    if (first) {
      this.ui.onToast('Нажмите на коробку, чтобы бросить десерт');
    }
  }

  restart(): void {
    if (this.disposed) return;
    this.resetRound(false);
    this.dropReadyAt = this.nowSec();
  }

  /** Продолжить игру после победы (кнопка «Продолжить») */
  continueAfterWin(): void {
    if (this.state === 'won') this.state = 'playing';
  }

  /* --------------------------- Спавн -------------------------------- */

  private buildNextPreview(): THREE.Group {
    const m = buildDessertMesh(this.nextTier);
    m.position.set(WORLD.nextX, WORLD.nextY, 0);
    m.scale.setScalar(0.01);
    this.scene.add(m);
    gsap.to(m.scale, { x: 0.62, y: 0.62, z: 0.62, duration: 0.3, ease: 'back.out(2)' });
    return m;
  }

  private disposePreviewMesh(m: THREE.Group): void {
    gsap.killTweensOf(m.scale);
    gsap.killTweensOf(m.position);
    m.removeFromParent();
  }

  /** Горизонтальный и вертикальный «вылет» модели за пределы коллайдера */
  private extents(tier: number): { ex: number; ey: number } {
    const t = TIERS[tier];
    return {
      ex: t.shape === 'capsule-x' ? t.halfHeight + t.radius : t.radius,
      ey: t.shape === 'ball' ? t.radius : t.shape === 'capsule-x' ? t.radius : t.halfHeight,
    };
  }

  private spawnDessert(tier: number, x: number, y: number, z: number, vy = 0): Dessert {
    const t = TIERS[tier];
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinearDamping(0.12)
      .setAngularDamping(0.6)
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);
    if (vy !== 0) body.setLinvel({ x: 0, y: vy, z: 0 }, true);
    body.setAngvel({ x: (Math.random() - 0.5) * 0.6, y: (Math.random() - 0.5) * 0.8, z: 0 }, true);

    let colDesc: RAPIER.ColliderDesc;
    if (t.shape === 'ball') {
      colDesc = RAPIER.ColliderDesc.ball(t.radius);
    } else if (t.shape === 'capsule-x') {
      colDesc = RAPIER.ColliderDesc.capsule(t.halfHeight, t.radius).setRotation({
        x: 0,
        y: 0,
        z: Math.SQRT1_2,
        w: Math.SQRT1_2,
      });
    } else {
      colDesc = RAPIER.ColliderDesc.cylinder(t.halfHeight, t.radius);
    }
    colDesc = colDesc.setFriction(0.65).setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    const collider = this.world.createCollider(colDesc, body);

    const mesh = buildDessertMesh(tier);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);

    const d: Dessert = {
      tier,
      body,
      colliderHandle: collider.handle,
      mesh,
      merging: false,
      hasContact: false,
      overfill: 0,
    };
    this.desserts.add(d);
    this.colliderToDessert.set(collider.handle, d);
    return d;
  }

  private removeDessert(d: Dessert): void {
    d.merging = true;
    this.desserts.delete(d);
    this.colliderToDessert.delete(d.colliderHandle);
    gsap.killTweensOf(d.mesh.scale);
    this.world.removeRigidBody(d.body);
    d.mesh.removeFromParent();
  }

  /* --------------------------- Бросок ------------------------------- */

  private dropCurrent(): void {
    if (this.state !== 'playing' || !this.canDrop) return;
    this.canDrop = false;
    this.dropReadyAt = this.nowSec() + WORLD.dropCooldown;

    const x = this.currentHolder.position.x;
    this.spawnDessert(this.currentTier, x, WORLD.previewY - 0.4, 0);
    this.moves += 1;
    this.emitStats();
    this.sfx.drop();

    // Следующий десерт становится текущим
    this.disposePreviewMesh(this.currentMesh);
    this.currentTier = this.nextTier;
    this.currentMesh = buildDessertMesh(this.currentTier);
    this.currentMesh.scale.setScalar(0.4);
    this.currentHolder.add(this.currentMesh);
    gsap.to(this.currentMesh.scale, { x: 1, y: 1, z: 1, duration: 0.3, ease: 'back.out(2.5)' });

    this.disposePreviewMesh(this.nextMesh);
    this.nextTier = randomSpawnTier();
    this.nextMesh = this.buildNextPreview();
  }

  /* --------------------------- Слияние ------------------------------ */

  private processEvents(): void {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const d1 = this.colliderToDessert.get(h1);
      const d2 = this.colliderToDessert.get(h2);
      if (d1) d1.hasContact = true;
      if (d2) d2.hasContact = true;
      if (
        d1 && d2 && d1 !== d2 && d1.tier === d2.tier &&
        !d1.merging && !d2.merging &&
        d1.tier < TIER_COUNT - 1
      ) {
        d1.merging = true;
        d2.merging = true;
        this.mergePairs.push([d1, d2]);
      }
    });

    while (this.mergePairs.length > 0) {
      const [a, b] = this.mergePairs.pop()!;
      // Тела могли быть удалены ранее в этом же кадре
      if (!this.desserts.has(a) || !this.desserts.has(b)) continue;
      this.doMerge(a, b);
    }
  }

  private doMerge(a: Dessert, b: Dessert): void {
    const pa = a.body.translation();
    const pb = b.body.translation();
    const newTier = a.tier + 1;
    const t = TIERS[newTier];
    const { ex, ey } = this.extents(newTier);

    const mx = THREE.MathUtils.clamp((pa.x + pb.x) / 2, -(WORLD.innerHalfWidth - ex - 0.04), WORLD.innerHalfWidth - ex - 0.04);
    const mz = THREE.MathUtils.clamp((pb.z + pa.z) / 2, -(WORLD.innerHalfDepth - t.radius - 0.04), WORLD.innerHalfDepth - t.radius - 0.04);
    const my = Math.max((pa.y + pb.y) / 2, ey + 0.03);

    const color = tierColor(newTier);
    this.burst(mx, my, mz, color, 9 + newTier * 2);

    this.removeDessert(a);
    this.removeDessert(b);

    const d = this.spawnDessert(newTier, mx, my, mz, 2.4);
    d.mesh.scale.setScalar(0.35);
    gsap.to(d.mesh.scale, { x: 1, y: 1, z: 1, duration: 0.45, ease: 'back.out(2.2)' });
    this.sfx.pop(newTier);

    if (newTier + 1 > this.collected) {
      this.collected = newTier + 1;
      this.emitStats();
      if (newTier === TIER_COUNT - 1) {
        this.onWin();
      } else {
        this.ui.onToast(`Новый десерт: ${TIERS[newTier].name} ${TIERS[newTier].emoji}`);
        this.sfx.discover();
      }
    }
  }

  private onWin(): void {
    this.state = 'won';
    this.sfx.win();
    this.burst(0, 8.6, 0, 0xffd166, 26);
    gsap.delayedCall(0.35, () => this.burst(-2.2, 9.2, 0, 0xef476f, 18));
    gsap.delayedCall(0.7, () => this.burst(2.2, 9.2, 0, 0x06d6a0, 18));
    this.ui.onEnd(true, this.moves, this.collected);
  }

  private onLose(): void {
    this.state = 'over';
    this.sfx.lose();
    this.ui.onEnd(false, this.moves, this.collected);
  }

  private checkOverfill(dt: number): void {
    let worst = 0;
    for (const d of this.desserts) {
      if (!d.hasContact) continue;
      const p = d.body.translation();
      const v = d.body.linvel();
      const slow = v.x * v.x + v.y * v.y + v.z * v.z < 1.44;
      if (p.y > WORLD.overflowY && (slow || d.body.isSleeping())) {
        d.overfill += dt;
        worst = Math.max(worst, d.overfill);
      } else {
        d.overfill = 0;
      }
    }
    if (worst > WORLD.overflowSeconds) this.onLose();
  }

  /* -------------------------- Частицы ------------------------------- */

  private burst(x: number, y: number, z: number, color: number, count: number): void {
    if (this.disposed) return;
    for (let i = 0; i < count; i++) {
      const p = this.particlePool.pop();
      if (!p) return;
      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(color);
      p.mesh.position.set(x, y, z);
      p.mesh.visible = true;
      const ang = Math.random() * Math.PI * 2;
      const up = 2 + Math.random() * 4.5;
      const side = (Math.random() - 0.5) * 5;
      p.vel.set(Math.cos(ang) * side * 0.6, up, Math.sin(ang) * side * 0.4);
      p.maxLife = 0.55 + Math.random() * 0.4;
      p.life = p.maxLife;
      p.baseScale = 0.7 + Math.random() * 0.9;
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
      p.vel.y -= 26 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      const s = p.baseScale * (p.life / p.maxLife);
      p.mesh.scale.setScalar(s);
      p.mesh.rotation.x += dt * 4;
      p.mesh.rotation.y += dt * 3;
    }
  }

  /* ---------------------------- Ввод -------------------------------- */

  private bindInput(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
  }

  private unbindInput(): void {
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerCancel);
  }

  private pointerToSceneX(e: PointerEvent): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin;
    const dirv = this.raycaster.ray.direction;
    if (Math.abs(dirv.z) < 1e-6) return 0;
    const t = (0 - o.z) / dirv.z;
    if (t < 0) return 0;
    return o.x + dirv.x * t;
  }

  private setTargetFromEvent(e: PointerEvent): void {
    const t = TIERS[this.currentTier];
    const px = this.pointerToSceneX(e);
    this.targetX = THREE.MathUtils.clamp(
      px,
      -(WORLD.innerHalfWidth - t.radius - 0.06),
      WORLD.innerHalfWidth - t.radius - 0.06,
    );
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (this.state !== 'playing') return;
    this.setTargetFromEvent(e);
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.sfx.unlock();
    if (this.state !== 'playing') return;
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* игнорируем */
    }
    this.setTargetFromEvent(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.state !== 'playing') return;
    this.setTargetFromEvent(e);
    this.dropCurrent();
  };

  private onPointerCancel = (): void => {
    /* ничего */
  };

  /* ---------------------------- Камера ------------------------------ */

  private fitCamera(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = Math.max(0.3, w / h);
    const vFov = THREE.MathUtils.degToRad(42);
    const targetWidth = 10.8;
    const targetHeight = 14.4;
    const center = new THREE.Vector3(0, 4.75, 0);

    const dV = targetHeight / 2 / Math.tan(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const dH = targetWidth / 2 / Math.tan(hFov / 2);
    const dist = Math.max(dV, dH) * 1.04;
    const elev = THREE.MathUtils.degToRad(13);

    this.camera.aspect = aspect;
    this.camera.position.set(
      center.x,
      center.y + dist * Math.sin(elev),
      dist * Math.cos(elev),
    );
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
  }

  private onResize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.fitCamera();
  }

  /* ----------------------------- Цикл ------------------------------- */

  private nowSec(): number {
    return (performance.now() - this.clockStart) / 1000;
  }

  start(): void {
    this.clockStart = performance.now();
    this.lastT = performance.now() / 1000;
    this.dropReadyAt = 0.3;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (nowMs: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);

    const now = nowMs / 1000;
    const dt = Math.min(0.05, Math.max(0, now - this.lastT));
    this.lastT = now;

    // Физика с фиксированным шагом
    this.acc += dt;
    let steps = 0;
    while (this.acc >= this.step && steps < 4) {
      this.world.step(this.eventQueue);
      this.processEvents();
      this.acc -= this.step;
      steps += 1;
    }

    // Синхронизация мешей
    for (const d of this.desserts) {
      const p = d.body.translation();
      const q = d.body.rotation();
      d.mesh.position.set(p.x, p.y, p.z);
      d.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }

    // Превью следует за указателем
    if (this.state === 'playing') {
      const follow = Math.min(1, dt * 16);
      this.currentHolder.position.x += (this.targetX - this.currentHolder.position.x) * follow;
      const bob = Math.sin(now * 2.6) * 0.09;
      this.currentMesh.position.y = bob;
      this.aimLine.position.x = this.currentHolder.position.x;
      if (!this.canDrop && this.nowSec() >= this.dropReadyAt) this.canDrop = true;
      this.checkOverfill(dt);
    }

    this.updateParticles(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /* ----------------------------- Прочее ----------------------------- */

  private emitStats(): void {
    this.ui.onStats(this.moves, this.collected);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unbindInput();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const d of [...this.desserts]) this.removeDessert(d);
    this.disposePreviewMesh(this.currentMesh);
    this.disposePreviewMesh(this.nextMesh);
    gsap.globalTimeline.clear();
    for (const p of [...this.activeParticles, ...this.particlePool]) {
      p.mesh.visible = false;
    }
    try {
      this.eventQueue.free();
      this.world.free();
    } catch {
      /* уже освобождено */
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
