import type { Participant } from "./groups";

const FULL_CIRCLE = 360;
const POINTER_ANGLE = -90;

export function activeParticipants(participants: Participant[]): Participant[] {
  return participants.filter((participant) => participant.active);
}

export function anglePerSegment(count: number): number {
  return FULL_CIRCLE / Math.max(count, 1);
}

export function winnerIndexFromRotation(rotationDeg: number, count: number): number {
  if (count <= 0) {
    return -1;
  }

  const normalized = ((rotationDeg % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
  const pointerOnWheel = (FULL_CIRCLE - normalized + POINTER_ANGLE + FULL_CIRCLE) % FULL_CIRCLE;
  const index = Math.floor(pointerOnWheel / anglePerSegment(count));

  return Math.max(0, Math.min(count - 1, index));
}

export function pickSpinTarget(currentRotation: number, count: number): {
  targetRotation: number;
  winnerIndex: number;
  durationMs: number;
} {
  const winnerIndex = Math.floor(Math.random() * count);
  const segmentAngle = anglePerSegment(count);
  const targetWithinCircle =
    FULL_CIRCLE - POINTER_ANGLE - (winnerIndex + 0.5) * segmentAngle;
  const currentMod = ((currentRotation % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
  const offset = ((targetWithinCircle - currentMod) % FULL_CIRCLE + FULL_CIRCLE) % FULL_CIRCLE;
  const extraTurns = 6 + Math.floor(Math.random() * 3);
  const targetRotation = currentRotation + extraTurns * FULL_CIRCLE + offset;
  const durationMs = 4000 + Math.floor(Math.random() * 2000);

  return {
    targetRotation,
    winnerIndex,
    durationMs,
  };
}

export function rotationForWinner(
  currentRotation: number,
  count: number,
  winnerIndex: number,
  extraTurns: number,
): number {
  if (count <= 0) {
    return currentRotation;
  }

  const clampedIndex = Math.max(0, Math.min(count - 1, winnerIndex));
  const segmentAngle = anglePerSegment(count);
  const targetWithinCircle =
    FULL_CIRCLE - POINTER_ANGLE - (clampedIndex + 0.5) * segmentAngle;
  const currentMod = ((currentRotation % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
  const offset = ((targetWithinCircle - currentMod) % FULL_CIRCLE + FULL_CIRCLE) % FULL_CIRCLE;

  return currentRotation + Math.max(extraTurns, 0) * FULL_CIRCLE + offset;
}

export function segmentColor(index: number): string {
  const colors = [
    "#00f5ff",
    "#00d19f",
    "#ffcc55",
    "#4df7ff",
    "#26d9ff",
    "#63ffbe",
    "#ffd578",
    "#31c0ff",
  ];

  return colors[index % colors.length] ?? colors[0] ?? "#26deff";
}
