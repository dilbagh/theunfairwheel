import type { Participant } from "./group";

const FULL_CIRCLE = 360;
const DEFAULT_EDGE_PADDING_DEGREES = 6;

export type SpinSegment = {
  participantId: string;
  startAngle: number;
  endAngle: number;
  midAngle: number;
  sweep: number;
  weight: number;
};

export function participantWeight(participant: Participant): number {
  return Math.max(1, participant.spinsSinceLastWon + 1);
}

export function weightedSpinSegments(participants: Participant[]): SpinSegment[] {
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

export function resolveEdgePaddingDegrees(sweep: number): number {
  if (!Number.isFinite(sweep) || sweep <= 0) {
    return 0;
  }

  return Math.min(DEFAULT_EDGE_PADDING_DEGREES, sweep / 4);
}

export function randomTargetAngleForSegment(
  segment: Pick<SpinSegment, "startAngle" | "endAngle" | "midAngle" | "sweep">,
  randomValue: number,
): number {
  if (!Number.isFinite(segment.sweep) || segment.sweep <= 0) {
    return normalizeAngle(segment.midAngle);
  }

  const padding = resolveEdgePaddingDegrees(segment.sweep);
  const minAngle = segment.startAngle + padding;
  const maxAngle = segment.endAngle - padding;

  if (!(maxAngle > minAngle)) {
    return normalizeAngle(segment.midAngle);
  }

  const clampedRandom = Math.min(1, Math.max(0, randomValue));
  return normalizeAngle(minAngle + clampedRandom * (maxAngle - minAngle));
}

export function normalizeAngle(angle: number): number {
  return ((angle % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
}
