/**
 * Крошечный WebAudio-синтезатор звуковых эффектов игры.
 * Никаких внешних файлов: всё генерируется на лету.
 * Контекст создаётся лениво — только после жеста пользователя.
 */

export class Sfx {
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

  /** Бросок десерта */
  drop(): void {
    this.tone(190, 0.09, 'triangle', 0.7, 90);
  }

  /** Слияние: высота зависит от яруса */
  pop(tier: number): void {
    const f = 300 + tier * 55;
    this.tone(f, 0.14, 'sine', 0.9, f * 1.9);
    this.tone(f * 1.5, 0.1, 'triangle', 0.35, f * 2.2, 0.04);
  }

  /** Открыт новый десерт */
  discover(): void {
    this.tone(523, 0.12, 'sine', 0.7);
    this.tone(659, 0.14, 'sine', 0.7, undefined, 0.09);
  }

  /** Победа */
  win(): void {
    const seq = [523, 659, 784, 1047];
    seq.forEach((f, i) => this.tone(f, 0.22, 'sine', 0.8, undefined, i * 0.11));
  }

  /** Проигрыш */
  lose(): void {
    this.tone(330, 0.3, 'sawtooth', 0.35, 180);
    this.tone(220, 0.45, 'triangle', 0.4, 110, 0.18);
  }
}
