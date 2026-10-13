export interface OneEuroOptions {
  /** Cutoff frequency (Hz) when the signal is still; lower means smoother. */
  minCutoff?: number;
  /** How quickly the cutoff rises with speed; higher means less lag on fast motion. */
  beta?: number;
  /** Cutoff frequency (Hz) for the derivative estimate. */
  dCutoff?: number;
}

function smoothingFactor(dtSeconds: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * dtSeconds;
  return r / (r + 1);
}

/** One Euro filter (Casiez et al. 2012), driven by real timestamps in milliseconds. */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private value: number | null = null;
  private derivative = 0;
  private lastTime = 0;

  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 }: OneEuroOptions = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(x: number, timeMs: number): number {
    if (this.value === null) {
      this.value = x;
      this.derivative = 0;
      this.lastTime = timeMs;
      return x;
    }
    const dt = (timeMs - this.lastTime) / 1000;
    if (dt <= 0) return this.value;
    this.lastTime = timeMs;

    const rawDerivative = (x - this.value) / dt;
    this.derivative += smoothingFactor(dt, this.dCutoff) * (rawDerivative - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += smoothingFactor(dt, cutoff) * (x - this.value);
    return this.value;
  }

  reset(): void {
    this.value = null;
    this.derivative = 0;
  }
}

/** Running median of the last three samples; removes single-frame spikes. */
export class Median3 {
  private a = 0;
  private b = 0;
  private count = 0;

  push(x: number): number {
    const out = this.count < 2 ? x : Math.max(Math.min(this.a, this.b), Math.min(Math.max(this.a, this.b), x));
    this.a = this.b;
    this.b = x;
    this.count = Math.min(this.count + 1, 2);
    return out;
  }

  reset(): void {
    this.count = 0;
  }
}

/** Exponential moving average; `alpha` is the weight of each new sample. */
export class Ema {
  private readonly alpha: number;
  private current: number | null = null;

  constructor(alpha: number) {
    this.alpha = alpha;
  }

  get value(): number | null {
    return this.current;
  }

  push(x: number): number {
    this.current = this.current === null ? x : this.current + this.alpha * (x - this.current);
    return this.current;
  }

  reset(): void {
    this.current = null;
  }
}

/** Median-of-3 followed by a One Euro filter. */
export class SmoothedSignal {
  private readonly median = new Median3();
  private readonly euro: OneEuroFilter;

  constructor(options: OneEuroOptions) {
    this.euro = new OneEuroFilter(options);
  }

  push(x: number, timeMs: number): number {
    return this.euro.filter(this.median.push(x), timeMs);
  }

  reset(): void {
    this.median.reset();
    this.euro.reset();
  }
}
