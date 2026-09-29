/**
 * Limited Animation (Snappy) 정책.
 * - 게임 루프는 60fps, 스프라이트 애니메이션은 8~12fps로 "뚝뚝 끊기는" 키포즈 연출.
 * - 키포즈 강조는 보간이 아니라 frame hold(같은 프레임을 N틱 유지)로 표현.
 */
export const ANIM_FPS = {
  MIN: 8,
  MAX: 12,
  /** 기본값: 100ms/frame → 타이밍 윈도우를 100ms 그리드로 설계하기 쉬움 */
  DEFAULT: 10,
  /** 무거운 예비동작(후리카부리 등) */
  HEAVY: 8,
  /** 빠른 전환(텐칸, 우케미 등) */
  QUICK: 12,
} as const;

export const clampAnimFps = (fps: number): number =>
  Math.min(ANIM_FPS.MAX, Math.max(ANIM_FPS.MIN, Math.round(fps)));

export const msPerFrame = (fps: number): number => 1000 / clampAnimFps(fps);
