import { describe, expect, it } from "vitest";

import type { Participant } from "./group";
import {
  participantWeight,
  randomTargetAngleForSegment,
  resolveEdgePaddingDegrees,
  weightedSpinSegments,
} from "./spin";

function participant(id: string, spinsSinceLastWon: number): Participant {
  return {
    id,
    name: id,
    active: true,
    emailId: null,
    manager: false,
    spinsSinceLastWon,
  };
}

describe("weightedSpinSegments", () => {
  it("preserves the existing weighted winner odds inputs", () => {
    const participants = [participant("a", 0), participant("b", 2), participant("c", 5)];

    expect(participants.map((entry) => participantWeight(entry))).toEqual([1, 3, 6]);

    const segments = weightedSpinSegments(participants);
    expect(segments.map((segment) => segment.weight)).toEqual([1, 3, 6]);
    expect(segments.reduce((sum, segment) => sum + segment.sweep, 0)).toBeCloseTo(360, 8);
  });
});

describe("randomTargetAngleForSegment", () => {
  it("always lands inside the winner segment", () => {
    const segment = weightedSpinSegments([participant("winner", 9)])[0]!;

    const low = randomTargetAngleForSegment(segment, 0);
    const high = randomTargetAngleForSegment(segment, 1);
    const middle = randomTargetAngleForSegment(segment, 0.37);

    expect(low).toBeGreaterThanOrEqual(segment.startAngle);
    expect(high).toBeLessThanOrEqual(segment.endAngle);
    expect(middle).toBeGreaterThan(segment.startAngle);
    expect(middle).toBeLessThan(segment.endAngle);
  });

  it("respects edge padding for narrow and wide slices", () => {
    const segments = weightedSpinSegments([participant("a", 0), participant("b", 5)]);
    const narrowSegment = segments[0]!;
    const wideSegment = segments[1]!;

    const narrowPadding = resolveEdgePaddingDegrees(narrowSegment.sweep);
    const widePadding = resolveEdgePaddingDegrees(wideSegment.sweep);

    expect(randomTargetAngleForSegment(narrowSegment, 0)).toBeCloseTo(
      narrowSegment.startAngle + narrowPadding,
      8,
    );
    expect(randomTargetAngleForSegment(narrowSegment, 1)).toBeCloseTo(
      narrowSegment.endAngle - narrowPadding,
      8,
    );
    expect(randomTargetAngleForSegment(wideSegment, 0)).toBeCloseTo(wideSegment.startAngle + widePadding, 8);
    expect(randomTargetAngleForSegment(wideSegment, 1)).toBeCloseTo(wideSegment.endAngle - widePadding, 8);
  });
});
