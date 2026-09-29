import type { Grade, Stage } from '../types/technique';

export interface StageTally { checks: number; successes: number }

/** 누적 판정 기록. success = Perfect 판정 */
export interface TimingStats {
  checks: number;
  successes: number;
  streak: number;
  maxStreak: number;
  grades: Record<Grade, number>;
  byStage: Record<Stage, StageTally>;
  /** throw stage 마지막 판정 등급 */
  throwGrade: Grade | null;
  score: number;
  musubi: number;
  damage: number;
}

export const createStats = (musubi: number): TimingStats => ({
  checks: 0,
  successes: 0,
  streak: 0,
  maxStreak: 0,
  grades: { perfect: 0, early: 0, late: 0, miss: 0 },
  byStage: {
    recognition: { checks: 0, successes: 0 },
    entry: { checks: 0, successes: 0 },
    throw: { checks: 0, successes: 0 },
  },
  throwGrade: null,
  score: 0,
  musubi,
  damage: 0,
});

export const recordGrade = (s: TimingStats, stage: Stage, grade: Grade): void => {
  const ok = grade === 'perfect';
  s.checks++;
  s.grades[grade]++;
  s.byStage[stage].checks++;
  if (ok) {
    s.successes++;
    s.byStage[stage].successes++;
    s.streak++;
    s.maxStreak = Math.max(s.maxStreak, s.streak);
  } else {
    s.streak = 0;
  }
  if (stage === 'throw') s.throwGrade = grade;
};

export const cloneStats = (s: TimingStats): TimingStats => ({
  ...s,
  grades: { ...s.grades },
  byStage: {
    recognition: { ...s.byStage.recognition },
    entry: { ...s.byStage.entry },
    throw: { ...s.byStage.throw },
  },
});
