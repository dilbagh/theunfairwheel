import { describe, expect, it } from "vitest";

import { rotationForWinner, weightedSegments } from "./wheel";

const participants = [
  { id: "a", name: "A", active: true, spinsSinceLastWon: 0 },
  { id: "b", name: "B", active: true, spinsSinceLastWon: 2 },
  { id: "c", name: "C", active: true, spinsSinceLastWon: 1 },
];

describe("rotationForWinner", () => {
  it("uses the provided target angle when it is inside the winner segment", () => {
    const segments = weightedSegments(participants);
    const winnerSegment = segments.find((segment) => segment.participantId === "b")!;

    const targetAngle = winnerSegment.startAngle + 5;
    const rotation = rotationForWinner(25, segments, "b", targetAngle, 2);
    const expected = 25 + 720 + (((270 - targetAngle) - 25) % 360 + 360) % 360;

    expect(rotation).toBeCloseTo(expected, 8);
  });

  it("falls back to the segment midpoint when target angle is absent", () => {
    const segments = weightedSegments(participants);
    const winnerSegment = segments.find((segment) => segment.participantId === "b")!;

    const rotation = rotationForWinner(25, segments, "b", null, 2);
    const expected = 25 + 720 + (((270 - winnerSegment.midAngle) - 25) % 360 + 360) % 360;

    expect(rotation).toBeCloseTo(expected, 8);
  });
});
