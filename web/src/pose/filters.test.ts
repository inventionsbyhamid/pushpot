import { describe, expect, it } from "vitest";
import { Ema, Median3, OneEuroFilter } from "./filters";

describe("OneEuroFilter", () => {
  it("converges to a constant input", () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0.02, dCutoff: 1 });
    filter.filter(0, 0);
    let value = 0;
    for (let i = 1; i <= 90; i++) value = filter.filter(120, i * 33);
    expect(value).toBeCloseTo(120, 1);
  });

  it("lags less on fast motion as beta grows", () => {
    const lagAfterRamp = (beta: number) => {
      const filter = new OneEuroFilter({ minCutoff: 1, beta });
      let value = 0;
      for (let i = 0; i <= 15; i++) value = filter.filter(i * 6, i * 33);
      return 90 - value;
    };
    expect(lagAfterRamp(0.02)).toBeLessThan(lagAfterRamp(0));
    expect(lagAfterRamp(0.02)).toBeGreaterThan(0);
  });

  it("ignores samples that don't advance time", () => {
    const filter = new OneEuroFilter();
    filter.filter(10, 100);
    expect(filter.filter(50, 100)).toBe(10);
  });
});

describe("Median3", () => {
  it("removes single-sample spikes", () => {
    const median = new Median3();
    const out = [10, 10, 90, 10, 10].map((x) => median.push(x));
    expect(out).toEqual([10, 10, 10, 10, 10]);
  });
});

describe("Ema", () => {
  it("moves a fraction of the way towards each sample", () => {
    const ema = new Ema(0.3);
    ema.push(0);
    expect(ema.push(10)).toBeCloseTo(3);
  });
});
