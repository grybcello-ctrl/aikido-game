import type { Beat, Grade, PhaseInput, Range, TimingWindow } from '../types/technique';

const inRange = (d: number, [from, to]: Range): boolean => d >= from && d < to;

/**
 * 입력 오차(ms, 입력시점 - targetMs)를 등급으로 판정.
 * 모든 구간 밖이면 null (판정 구간 밖 입력 → 엔진이 무시).
 */
export const gradeOffset = (w: TimingWindow, offsetMs: number): Exclude<Grade, 'miss'> | null => {
  if (inRange(offsetMs, w.perfect)) return 'perfect';
  if (inRange(offsetMs, w.early)) return 'early';
  if (inRange(offsetMs, w.late)) return 'late';
  return null;
};

/** 페이즈 기준 판정 구간 [open, close) */
export const windowBounds = (b: Beat): { open: number; close: number } => ({
  open: b.targetMs + b.window.early[0],
  close: b.targetMs + b.window.late[1],
});

/** 입력 정의 → 비트 목록. none=0개, 단일=1개, sequence=n개 */
export const beatsOf = (input: PhaseInput): Beat[] =>
  input.type === 'none' ? [] : input.type === 'sequence' ? input.beats : [input];
