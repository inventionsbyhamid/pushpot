import { describe, expect, it } from "vitest";
import { angleAt, isInFrame, median, offsetFromLine, toPixels } from "./geometry";

describe("angleAt", () => {
  it("measures interior angles in degrees", () => {
    expect(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90);
    expect(angleAt({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(180);
    expect(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(45);
    expect(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });

  it("is only meaningful in pixel space on non-square frames", () => {
    const px = (p: { x: number; y: number }) => toPixels(p, 640, 480);
    const shoulder = { x: 0.6, y: 0.4 };
    const elbow = { x: 0.5, y: 0.5 };
    const wrist = { x: 0.75, y: 0.5 };
    expect(angleAt(shoulder, elbow, wrist)).toBeCloseTo(45);
    expect(angleAt(px(shoulder), px(elbow), px(wrist))).toBeCloseTo(36.87, 1);
  });
});

describe("offsetFromLine", () => {
  it("is positive below the line whichever way the line runs", () => {
    const left = { x: 0, y: 0 };
    const right = { x: 10, y: 0 };
    expect(offsetFromLine({ x: 5, y: 3 }, left, right)).toBeCloseTo(3);
    expect(offsetFromLine({ x: 5, y: 3 }, right, left)).toBeCloseTo(3);
    expect(offsetFromLine({ x: 5, y: -2 }, right, left)).toBeCloseTo(-2);
  });
});

describe("isInFrame", () => {
  it("respects the margin", () => {
    expect(isInFrame({ x: 0.5, y: 0.5 }, 0.02)).toBe(true);
    expect(isInFrame({ x: 0.01, y: 0.5 }, 0.02)).toBe(false);
    expect(isInFrame({ x: 0.5, y: 0.99 }, 0.02)).toBe(false);
  });
});

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
