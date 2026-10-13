import { describe, expect, it } from "vitest";
import { angleAt, distance } from "../../pose/geometry";
import { intersectCircles, solvePose, type Skeleton } from "./kinematics";

const bones = (s: Skeleton) => [
  distance(s.ankle, s.hip),
  distance(s.hip, s.shoulder),
  distance(s.shoulder, s.elbow),
  distance(s.elbow, s.wrist),
];

describe("intersectCircles", () => {
  it("returns the point left of the centre line first", () => {
    const [left, right] = intersectCircles({ x: 0, y: 0 }, 5, { x: 8, y: 0 }, 5);
    expect(left.x).toBeCloseTo(4);
    expect(left.y).toBeCloseTo(3);
    expect(right.y).toBeCloseTo(-3);
  });

  it("returns one point twice when the circles miss", () => {
    const [a, b] = intersectCircles({ x: 0, y: 0 }, 1, { x: 10, y: 0 }, 1);
    expect(a).toEqual(b);
  });
});

describe("solvePose", () => {
  const top = solvePose({ elbow: 180 });

  it("puts the shoulder over the wrist with straight arms and body", () => {
    expect(top.shoulder.x).toBeCloseTo(top.wrist.x);
    expect(top.shoulder.y).toBeGreaterThan(top.wrist.y);
  });

  it.each([
    { elbow: 172 },
    { elbow: 82 },
    { elbow: 125 },
    { elbow: 86, hipBend: 50 },
    { elbow: 165, hipBend: -50 },
    { elbow: 160, headDrop: 55 },
  ])("keeps hands, feet and bone lengths fixed for %o", (params) => {
    const pose = solvePose(params);
    expect(pose.ankle).toEqual(top.ankle);
    expect(pose.toe).toEqual(top.toe);
    expect(pose.wrist).toEqual(top.wrist);
    bones(pose).forEach((length, i) => expect(length).toBeCloseTo(bones(top)[i]!, 6));
  });

  it("bends the elbow to the requested angle, back towards the feet", () => {
    for (const elbow of [80, 100, 125, 150, 172]) {
      const pose = solvePose({ elbow });
      expect(angleAt(pose.shoulder, pose.elbow, pose.wrist)).toBeCloseTo(elbow, 6);
      expect(pose.elbow.x).toBeLessThan(pose.wrist.x);
    }
  });

  it("lowers the shoulder as the elbow bends", () => {
    expect(solvePose({ elbow: 82 }).shoulder.y).toBeLessThan(solvePose({ elbow: 125 }).shoulder.y);
    expect(solvePose({ elbow: 125 }).shoulder.y).toBeLessThan(top.shoulder.y);
  });

  it("sags the hips below the body line and pikes them above it", () => {
    const lineHeightAt = (pose: Skeleton, x: number) =>
      pose.ankle.y + ((pose.shoulder.y - pose.ankle.y) * (x - pose.ankle.x)) / (pose.shoulder.x - pose.ankle.x);

    const sag = solvePose({ elbow: 172, hipBend: 50 });
    expect(angleAt(sag.shoulder, sag.hip, sag.ankle)).toBeCloseTo(130, 6);
    expect(sag.hip.y).toBeLessThan(lineHeightAt(sag, sag.hip.x));

    const pike = solvePose({ elbow: 172, hipBend: -50 });
    expect(angleAt(pike.shoulder, pike.hip, pike.ankle)).toBeCloseTo(130, 6);
    expect(pike.hip.y).toBeGreaterThan(lineHeightAt(pike, pike.hip.x));
  });

  it("drops the head towards the floor", () => {
    expect(solvePose({ elbow: 172, headDrop: 55 }).head.y).toBeLessThan(solvePose({ elbow: 172 }).head.y);
  });
});
