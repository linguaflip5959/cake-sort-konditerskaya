/**
 * Cake Sort — Кондитерская
 * Крошечный WebAudio-синтезатор звуковых эффектов игры.
 * Никаких внешних файлов: всё генерируется на лету.
 * Контекст создаётся лениво — только после жеста пользователя.
 */

export class PuzzleSfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  /** Вызывается при первом взаимодействии игрока */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.16;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  protected tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain = 1,
    freqEnd?: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Поднимаем серию кусочков */
  select(): void {
    this.tone(540, 0.09, 'sine', 0.5, 720);
  }

  /** Кусочки легли на тарелку */
  place(): void {
    this.tone(200, 0.1, 'triangle', 0.8, 95);
  }

  /** Недопустимый ход */
  invalid(): void {
    this.tone(130, 0.13, 'sawtooth', 0.22, 100);
  }

  /** Собран торт */
  merge(): void {
    const seq = [660, 830, 990, 1320];
    seq.forEach((f, i) => this.tone(f, 0.18, 'sine', 0.5, undefined, i * 0.07));
  }

  /** Уровень пройден */
  levelWin(): void {
    const seq = [523, 659, 784, 1046, 1318];
    seq.forEach((f, i) => this.tone(f, 0.22, 'sine', 0.65, undefined, i * 0.1));
  }

  /** Подсказка: мягкий «блик» */
  hint(): void {
    this.tone(880, 0.12, 'sine', 0.4, 1240);
    this.tone(1320, 0.16, 'sine', 0.3, undefined, 0.08);
  }

  /** Тупик */
  stuck(): void {
    this.tone(280, 0.35, 'triangle', 0.4, 150);
    this.tone(180, 0.5, 'triangle', 0.35, 95, 0.2);
  }
}
