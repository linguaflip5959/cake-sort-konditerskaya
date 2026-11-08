/**
 * Cake Sort — Auto Merge Mechanic
 * Точка входа Vite-версии: подключает движок к разметке из index.html.
 */

import { CakeSortEngine } from './engine';

const app = document.getElementById('app') as HTMLElement;
const movesEl = document.getElementById('moves') as HTMLElement;
const completedEl = document.getElementById('completed') as HTMLElement;
const restartBtn = document.getElementById('restart') as HTMLButtonElement;
const toSortBtn = document.getElementById('toSort') as HTMLButtonElement | null;
const toastEl = document.getElementById('toast') as HTMLElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const overlayText = document.getElementById('overlayText') as HTMLElement;
const overlayBtn = document.getElementById('overlayBtn') as HTMLButtonElement;

let game: CakeSortEngine | null = null;
let toastTimer: number | undefined;

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2000);
}

function hideOverlay(): void {
  overlay.classList.remove('show');
}

void CakeSortEngine.create(app, {
  onStats(moves, collected) {
    movesEl.textContent = String(moves);
    completedEl.textContent = String(collected);
  },
  onToast: showToast,
  onEnd(win, moves, collected) {
    overlayText.textContent = win
      ? `Победа! 🎂\nТорт собран за ${moves} ходов`
      : `Игра окончена!\nСобрано: ${collected}/9`;
    overlayBtn.textContent = win ? 'Продолжить' : 'Заново';
    overlayBtn.dataset.win = win ? '1' : '0';
    overlay.classList.add('show');
  },
}).then((g) => {
  game = g;
  g.start();
});

overlayBtn.addEventListener('click', () => {
  hideOverlay();
  if (!game) return;
  if (overlayBtn.dataset.win === '1') {
    game.continueAfterWin();
  } else {
    game.restart();
  }
});

restartBtn.addEventListener('click', () => {
  hideOverlay();
  game?.restart();
});

// Переключение на сортировку «Кондитерская»
toSortBtn?.addEventListener('click', () => {
  window.location.href = './index.html';
});
