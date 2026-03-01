import { getAudioMuted, setAudioMuted } from "./storage";

class AudioEngine {
  private context: AudioContext | null = null;
  private muted = getAudioMuted();

  isMuted() {
    return this.muted;
  }

  setMuted(nextMuted: boolean) {
    this.muted = nextMuted;
    setAudioMuted(nextMuted);
  }

  private async getContext() {
    if (this.muted || typeof window === "undefined") {
      return null;
    }

    if (!this.context) {
      const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        return null;
      }
      this.context = new Ctx();
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    return this.context;
  }

  private async tone(freq: number, durationSec: number, type: OscillatorType, volume = 0.08) {
    const ctx = await this.getContext();
    if (!ctx) {
      return;
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + durationSec + 0.02);
  }

  async playClick() {
    await this.tone(620, 0.08, "triangle", 0.05);
  }

  async playTick() {
    await this.tone(920, 0.04, "square", 0.025);
  }

  async playWin() {
    const notes: Array<{ freq: number; durationSec: number; offsetMs: number; volume: number }> = [
      { freq: 523.25, durationSec: 0.1, offsetMs: 0, volume: 0.05 }, // C5
      { freq: 659.25, durationSec: 0.12, offsetMs: 90, volume: 0.055 }, // E5
      { freq: 783.99, durationSec: 0.14, offsetMs: 180, volume: 0.06 }, // G5
      { freq: 1046.5, durationSec: 0.2, offsetMs: 280, volume: 0.065 }, // C6
      { freq: 1318.51, durationSec: 0.24, offsetMs: 400, volume: 0.06 }, // E6
      { freq: 1567.98, durationSec: 0.28, offsetMs: 520, volume: 0.055 }, // G6
    ];

    for (const note of notes) {
      setTimeout(() => {
        void this.tone(note.freq, note.durationSec, "triangle", note.volume);
      }, note.offsetMs);
    }
  }
}

export const audioEngine = new AudioEngine();
