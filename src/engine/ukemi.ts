import type { Grade, Stage, UkemiGrade, UkemiRule } from '../types/technique';
import type { TimingStats } from './stats';

/** 낙법 도출 입력 (집계 대상 stage 만 반영된 요약) */
export interface UkemiSummary {
  successes: number;
  checks: number;
  maxStreak: number;
  musubi: number;
  throwGrade: Grade | null;
}

const ALL_STAGES: Stage[] = ['recognition', 'entry', 'throw'];

export const summarizeForUkemi = (s: TimingStats, countStages: Stage[] = ALL_STAGES): UkemiSummary => {
  let successes = 0;
  let checks = 0;
  for (const st of countStages) {
    successes += s.byStage[st].successes;
    checks += s.byStage[st].checks;
  }
  return { successes, checks, maxStreak: s.maxStreak, musubi: s.musubi, throwGrade: s.throwGrade };
};

const matches = (r: UkemiRule, u: UkemiSummary): boolean => {
  if (r.minSuccess !== undefined && u.successes < r.minSuccess) return false;
  if (r.minSuccessRatio !== undefined && (u.checks ? u.successes / u.checks : 0) < r.minSuccessRatio) return false;
  if (r.minStreak !== undefined && u.maxStreak < r.minStreak) return false;
  if (r.minMusubi !== undefined && u.musubi < r.minMusubi) return false;
  if (r.throwGrades && (u.throwGrade === null || !r.throwGrades.includes(u.throwGrade))) return false;
  return true;
};

/**
 * 누적 성공 기록 → Phase 3 다이내믹 낙법 등급.
 * rules 를 위에서부터 검사해 첫 일치 규칙의 result. 일치 없으면 'crash'.
 */
export const deriveUkemi = (u: UkemiSummary, rules: UkemiRule[]): UkemiGrade =>
  rules.find((r) => matches(r, u))?.result ?? 'crash';
