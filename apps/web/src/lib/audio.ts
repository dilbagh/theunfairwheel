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
    await this.tone(523.25, 0.18, "sine", 0.06);
    setTimeout(() => {
      void this.tone(659.25, 0.2, "sine", 0.06);
    }, 90);
    setTimeout(() => {
      void this.tone(783.99, 0.24, "sine", 0.07);
    }, 180);
  }
}

export const audioEngine = new AudioEngine();
