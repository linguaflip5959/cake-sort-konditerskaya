/**
 * Cake Sort — Кондитерская (люкс)
 * Точка входа Vite-версии игры-сортировки: подключает движок к index.html.
 * Прогресс (уровень) и монеты хранятся в localStorage.
 */

import { PuzzleEngine } from './engine';

const app = document.getElementById('app') as HTMLElement;
const levelEl = document.getElementById('level') as HTMLElement;
const movesEl = document.getElementById('moves') as HTMLElement;
const coinsEl = document.getElementById('coinsNum') as HTMLElement;
const dotsEl = document.getElementById('dots') as HTMLElement;
const restartBtn = document.getElementById('restart') as HTMLButtonElement;
const hintBtn = document.getElementById('hint') as HTMLButtonElement;
const toastEl = document.getElementById('toast') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;
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

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function renderDots(collected: number, cakes: number): void {
  dotsEl.innerHTML = '';
  for (let i = 0; i < cakes; i++) {
    const d = document.createElement('span');
    d.className = 'dot' + (i < collected ? ' on' : '');
    dotsEl.appendChild(d);
  }
}

function showOverlay(kind: 'level' | 'stuck', title: string, text: string, btn: string): void {
  endKind = kind;
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
      renderDots(s.collected, s.cakes);
    },
    onToast: showToast,
    onLevelDone(level, moves) {
      addCoins(LEVEL_REWARD);
      showOverlay(
        'level',
        'Восхитительно!',
        `Уровень ${level} пройден за ${moves} ${pluralMoves(moves)}\n+${LEVEL_REWARD} 🪙`,
        'Следующий уровень',
      );
    },
    onStuck(_moves, collected, cakes, reason) {
      const why =
        reason === 'full'
          ? 'Поле заполнено — свободных ячеек нет'
          : 'Очередь закончилась, но не все торты собраны';
      showOverlay('stuck', 'Ходов больше нет', `${why}\nСобрано тортов: ${collected}/${cakes}`, 'Заново');
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
    showToast(`Не хватает монет — подсказка стоит ${HINT_COST} 🪙`);
    return;
  }
  if (game.hint()) {
    addCoins(-HINT_COST);
  } else {
    showToast('Подсказка недоступна');
  }
});
