import type { Participant } from "./groups";

const FULL_CIRCLE = 360;
const POINTER_ANGLE = 270;

export type WheelSegment = {
  participantId: string;
  startAngle: number;
  endAngle: number;
  midAngle: number;
  sweep: number;
  weight: number;
};

export function activeParticipants(participants: Participant[]): Participant[] {
  return participants.filter((participant) => participant.active);
}

export function participantWeight(participant: Participant): number {
  return Math.max(1, participant.spinsSinceLastWon + 1);
}

export function weightedSegments(participants: Participant[]): WheelSegment[] {
  if (participants.length === 0) {
    return [];
  }

  const weights = participants.map((participant) => participantWeight(participant));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return [];
  }

  let cursor = 0;
  return participants.map((participant, index) => {
    const weight = weights[index] ?? 1;
    const isLast = index === participants.length - 1;
    const sweep = isLast ? FULL_CIRCLE - cursor : (weight / totalWeight) * FULL_CIRCLE;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    const midAngle = startAngle + sweep / 2;
    cursor = endAngle;
    return {
      participantId: participant.id,
      startAngle,
      endAngle,
      midAngle,
      sweep,
      weight,
    };
  });
}

export function rotationForWinner(
  currentRotation: number,
  segments: WheelSegment[],
  winnerParticipantId: string,
  extraTurns: number,
): number {
  if (segments.length <= 0) {
    return currentRotation;
  }

  const winnerSegment = segments.find((segment) => segment.participantId === winnerParticipantId);
  if (!winnerSegment) {
    return currentRotation;
  }

  const targetWithinCircle =
    ((POINTER_ANGLE - winnerSegment.midAngle) % FULL_CIRCLE + FULL_CIRCLE) % FULL_CIRCLE;
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
