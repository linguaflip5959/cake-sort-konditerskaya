/**
 * Cake Sort — Кондитерская (люкс)
 * Точка входа Vite-версии игры-сортировки: подключает движок к index.html.
 * Прогресс (уровень) и монеты хранятся в localStorage.
 *
 * Итерация 3 — очки вместо тортов: над столом прогрессбар до нового торта
 * с его иконкой, при достижении цели — карточка с открытым тортом, очки
 * за торты всплывают над столом. Стол 3×3, выдача — 5 тарелок.
 */

import { PuzzleEngine } from './engine';
import { CAKE_TYPES } from './cakes';

const app = document.getElementById('app') as HTMLElement;
const levelEl = document.getElementById('level') as HTMLElement;
const movesEl = document.getElementById('moves') as HTMLElement;
const coinsEl = document.getElementById('coinsNum') as HTMLElement;
const goalTextEl = document.getElementById('goalText') as HTMLElement;
const goalFillEl = document.getElementById('goalFill') as HTMLElement;
const goalIconEl = document.getElementById('goalIcon') as HTMLElement;
const goalLabelEl = document.getElementById('goalLabel') as HTMLElement;
const floatersEl = document.getElementById('floaters') as HTMLElement;
const restartBtn = document.getElementById('restart') as HTMLButtonElement;
const hintBtn = document.getElementById('hint') as HTMLButtonElement;
const rotateBtn = document.getElementById('rotate') as HTMLButtonElement;
const toastEl = document.getElementById('toast') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const cardEl = document.getElementById('card') as HTMLElement;
const ovCakeEl = document.getElementById('ovCake') as HTMLElement;
const ovBadgeEl = document.getElementById('ovBadge') as HTMLElement;
const ovTitle = document.getElementById('ovTitle') as HTMLElement;
const ovText = document.getElementById('ovText') as HTMLElement;
const ovBtn = document.getElementById('ovBtn') as HTMLButtonElement;

const LEVEL_KEY = 'cakesort.level';
const COINS_KEY = 'cakesort.coins';
const START_COINS = 30;
const HINT_COST = 15;
const LEVEL_REWARD = 10;

function loadInt(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function saveInt(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* приватный режим — играем без сохранения */
  }
}

let game: PuzzleEngine | null = null;
let toastTimer: number | undefined;
let endKind: 'level' | 'stuck' | null = null;
let coins = loadInt(COINS_KEY, START_COINS);
/** Туториалы: подсказки правил на старте уровней 1–3 (один раз за сессию) */
const tutorialShown = new Set<number>();
let tutorialTimer: number | undefined;

/** Подсказка правила на уровне (показывается один раз за сессию) */
function showTutorial(level: number, text: string, delay = 900): void {
  if (tutorialShown.has(level)) return;
  tutorialShown.add(level);
  window.clearTimeout(tutorialTimer);
  tutorialTimer = window.setTimeout(() => showToast(text, 4200), delay);
}

function renderCoins(): void {
  coinsEl.textContent = String(coins);
}

function addCoins(delta: number): void {
  coins += delta;
  saveInt(COINS_KEY, coins);
  renderCoins();
}

function pluralMoves(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return 'ход';
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return 'хода';
  return 'ходов';
}

function showToast(text: string, duration = 2200): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), duration);
}

/* ------------------------------------------------------------------ */
/* SVG-иконка торта (вид сверху: 6 кусочков + крем + вишенка)           */
/* ------------------------------------------------------------------ */

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Вид торта сверху для иконок — как собранный торт на подставке */
export function cakeSVG(flavor: number, golden = false): string {
  const t = CAKE_TYPES[flavor] ?? CAKE_TYPES[0];
  const main = golden ? '#e9c76a' : hex(t.main);
  const cream = golden ? '#fff3cf' : hex(t.cream);
  const top = golden ? '#d4af37' : hex(t.topping);
  const C = 50;
  const R = 40;

  const wedges: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a0 = -90 + i * 60 + 2.6;
    const a1 = -90 + (i + 1) * 60 - 2.6;
    const rad0 = (a0 * Math.PI) / 180;
    const rad1 = (a1 * Math.PI) / 180;
    const x0 = C + R * Math.cos(rad0);
    const y0 = C + R * Math.sin(rad0);
    const x1 = C + R * Math.cos(rad1);
    const y1 = C + R * Math.sin(rad1);
    const mid = ((a0 + a1) / 2) * (Math.PI / 180);
    // кремовая «безешка» у края и топпинг ближе к центру
    const dx = C + R * 0.8 * Math.cos(mid);
    const dy = C + R * 0.8 * Math.sin(mid);
    const tx = C + R * 0.52 * Math.cos(mid);
    const ty = C + R * 0.52 * Math.sin(mid);
    wedges.push(
      `<path d="M ${C} ${C} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" fill="${main}" stroke="rgba(0,0,0,0.28)" stroke-width="0.7"/>` +
        `<circle cx="${dx.toFixed(2)}" cy="${dy.toFixed(2)}" r="4.6" fill="${cream}"/>` +
        `<circle cx="${tx.toFixed(2)}" cy="${ty.toFixed(2)}" r="2.5" fill="${top}"/>`,
    );
  }

  return (
    `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${t.name}">` +
    `<circle cx="50" cy="50" r="47" fill="rgba(255,246,232,0.06)" stroke="#d4af37" stroke-width="2.4"/>` +
    wedges.join('') +
    `<circle cx="50" cy="50" r="8.5" fill="${top}"/>` +
    `<ellipse cx="47.4" cy="47.2" rx="2.6" ry="1.8" fill="rgba(255,255,255,0.5)"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* Прогрессбар до нового торта                                         */
/* ------------------------------------------------------------------ */

let goalLevelShown = -1;

function renderGoal(
  level: number,
  points: number,
  target: number,
  unlockFlavor: number,
  golden: boolean,
): void {
  const pct = target > 0 ? Math.min(100, (points / target) * 100) : 0;
  goalFillEl.style.width = `${pct.toFixed(1)}%`;
  goalTextEl.textContent = `${Math.min(points, target)} / ${target}`;
  if (goalLevelShown !== level) {
    goalLevelShown = level;
    goalIconEl.innerHTML = cakeSVG(unlockFlavor, golden);
    const name = CAKE_TYPES[unlockFlavor]?.name ?? '';
    goalIconEl.title = golden ? `Золотой ${name.toLowerCase()} торт` : `Новый торт: ${name}`;
    goalLabelEl.textContent = golden ? 'До золотого торта' : 'До нового торта';
  }
}

/* ------------------------------------------------------------------ */
/* Всплывающие очки за торт                                            */
/* ------------------------------------------------------------------ */

function spawnFloater(sx: number, sy: number, points: number, combo: number): void {
  const rect = app.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'floater';
  const comboHtml = combo > 1 ? `<span class="combo">Комбо ×${combo}!</span>` : '';
  el.innerHTML = `+${points}${comboHtml}`;
  el.style.left = `${rect.left + sx}px`;
  el.style.top = `${rect.top + sy - 30}px`;
  floatersEl.appendChild(el);
  window.setTimeout(() => el.remove(), 1200);
}

/* ------------------------------------------------------------------ */
/* Оверлеи                                                             */
/* ------------------------------------------------------------------ */

function showOverlay(
  kind: 'level' | 'stuck',
  title: string,
  text: string,
  btn: string,
  opts?: { cake?: number; golden?: boolean; badge?: string },
): void {
  endKind = kind;
  if (opts?.cake !== undefined) {
    ovCakeEl.innerHTML = cakeSVG(opts.cake, opts.golden ?? false);
    ovCakeEl.style.display = 'flex';
    ovBadgeEl.style.display = 'inline-block';
    ovBadgeEl.textContent = opts.badge ?? 'Новый торт открыт!';
    cardEl.classList.toggle('gold', opts.golden ?? false);
  } else {
    ovCakeEl.style.display = 'none';
    ovBadgeEl.style.display = 'none';
    cardEl.classList.remove('gold');
  }
  ovTitle.textContent = title;
  ovText.textContent = text;
  ovBtn.textContent = btn;
  overlay.classList.add('show');
}

function hideOverlay(): void {
  overlay.classList.remove('show');
  endKind = null;
}

void PuzzleEngine.create(
  app,
  {
    onStats(s) {
      levelEl.textContent = `Уровень ${s.level}`;
      movesEl.textContent = `Ходов: ${s.moves}`;
      saveInt(LEVEL_KEY, s.level - 1);
      renderGoal(s.level, s.points, s.target, s.unlockFlavor, s.golden);
      // кнопка поворота видна только при двойной тарелке в выдаче
      rotateBtn.hidden = !s.doubleInTray;
      // подсказки правил на первых уровнях (один раз за сессию)
      if (s.level === 1 && s.moves === 0) {
        showTutorial(1, 'Ставь тарелку рядом с такой же — кусочки соединятся сами. Набери очки до цели!');
      } else if (s.level === 2 && s.moves === 0) {
        showTutorial(2, 'Кусочки летят и ЧЕРЕЗ соседние тарелки — если на промежуточных есть свободное место');
      } else if (s.level === 3 && s.moves === 0 && s.doubleInTray) {
        showTutorial(3, 'Двойная тарелка ставится сразу на две ячейки. Кнопка «Повернуть» выбирает положение', 1100);
      } else if (s.level === 4 && s.moves === 0) {
        showTutorial(4, 'Комбо: каждый следующий торт за один ход даёт больше очков', 1100);
      }
    },
    onToast: showToast,
    onCakeScore(sx, sy, _flavor, points, combo) {
      spawnFloater(sx, sy, points, combo);
    },
    onLevelDone(level, moves, unlockFlavor, golden) {
      addCoins(LEVEL_REWARD);
      const name = CAKE_TYPES[unlockFlavor]?.name ?? 'Торт';
      showOverlay(
        'level',
        golden ? 'Золотой торт!' : name,
        golden
          ? `Золотая серия продолжается!\nУровень ${level} пройден за ${moves} ${pluralMoves(moves)}\n+${LEVEL_REWARD} монет`
          : `Новый торт открыт и ждёт на следующем уровне!\nУровень ${level} пройден за ${moves} ${pluralMoves(moves)}\n+${LEVEL_REWARD} монет`,
        'Играть дальше',
        { cake: unlockFlavor, golden, badge: golden ? 'Золотая серия' : 'Новый торт открыт!' },
      );
    },
    onStuck(_moves, points, target, reason) {
      const why =
        reason === 'full' ? 'Стол заполнен — свободных ячеек нет' : 'Выдача закончилась, но цель не взята';
      showOverlay('stuck', 'Ходов больше нет', `${why}\nОчков набрано: ${points} из ${target}`, 'Заново');
    },
  },
  loadInt(LEVEL_KEY, 0),
).then((g) => {
  game = g;
  (window as unknown as { __pz?: typeof g }).__pz = g; // хук для e2e-тестов
  g.start();
  renderCoins();
});

ovBtn.addEventListener('click', () => {
  const kind = endKind;
  hideOverlay();
  if (!game) return;
  if (kind === 'level') game.nextLevel();
  else game.restartLevel();
});

restartBtn.addEventListener('click', () => {
  hideOverlay();
  game?.restartLevel();
});

hintBtn.addEventListener('click', () => {
  if (!game) return;
  if (coins < HINT_COST) {
    showToast(`Не хватает монет — подсказка стоит ${HINT_COST} монет`);
    return;
  }
  if (game.hint()) {
    addCoins(-HINT_COST);
  } else {
    showToast('Подсказка недоступна');
  }
});

/** Поворот двойной тарелки: кнопкой или клавишей R */
function doRotate(): void {
  if (!game) return;
  game.rotateDouble();
}

rotateBtn.addEventListener('click', doRotate);

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyR') return;
  if (e.repeat) return;
  if (overlay.classList.contains('show')) return;
  doRotate();
});
