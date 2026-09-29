/** technique.schema.json / animation.schema.json 과 1:1 대응하는 런타임 타입 */

export type Actor = 'nage' | 'uke' | 'fx';
export type Principle = 'maai' | 'musubi' | 'irimi' | 'tenkan' | 'kuzushi' | 'zanshin';
export type Grade = 'perfect' | 'early' | 'late' | 'miss';
export type CommonAnimKey = `common.${Actor}.${string}`;
export type ExclusiveAnimKey = `tech.${string}.${Actor}.${string}`;
export type AnimKey = CommonAnimKey | ExclusiveAnimKey;
export type Goto = `phase:${string}` | `branch:${string}` | 'end:success' | 'end:fail';

export interface I18n { ko: string; ja?: string; en?: string }

export interface AnimationDef {
  actor: Actor;
  atlas: string;
  prefix: string;
  start: number;
  end: number;
  zeroPad?: number;
  /** 8~12 */
  frameRate: number;
  repeat?: number;
  /** { frameIndex: ticks } */
  holds?: Record<string, number>;
  origin?: { x: number; y: number };
  frameOffsets?: { frame: number; x: number; y: number }[];
  events?: { frame: number; name: string }[];
}

export interface AnimationRegistry { animations: Record<CommonAnimKey, AnimationDef> }

/** [fromMs, toMs) — targetMs 기준 상대값 */
export type Range = [number, number];

export interface TimingWindow { early: Range; perfect: Range; late: Range }

export interface PhaseInput {
  type: 'none' | 'press' | 'direction_press' | 'hold_release';
  button?: 'ACTION' | 'GUARD';
  direction?: 'FORWARD' | 'BACK' | 'UP' | 'DOWN';
  targetMs?: number;
  holdStartMaxMs?: number;
  sync?: { actor: 'nage' | 'uke'; event: string };
  window?: TimingWindow;
}

export interface TrackKey {
  atMs: number;
  x?: number;
  y?: number;
  facing?: 1 | -1;
  depth?: number;
  ease?: string;
}

export interface Tracks { nage: TrackKey[]; uke: TrackKey[] }

export interface ActorSlot { anim: AnimKey; startAtMs?: number }

export interface Outcome {
  goto: Goto;
  score?: number;
  musubi?: number;
  hitstopMs?: number;
  fx?: AnimKey;
}

export interface Phase {
  id: string;
  label: I18n;
  principle?: Principle;
  durationMs: number;
  actors: { nage: ActorSlot; uke: ActorSlot };
  tracks: Tracks;
  input: PhaseInput;
  outcomes: Partial<Record<Grade | 'auto', Outcome>>;
}

export interface Branch {
  label: I18n;
  durationMs: number;
  actors: { nage: ActorSlot; uke: ActorSlot };
  tracks: Tracks;
  result: { goto: Goto; damage?: number; musubi?: number };
}

export interface TechniqueData {
  id: string;
  version: number;
  name: I18n;
  attack: 'shomenuchi' | 'yokomenuchi' | 'tsuki' | 'katatedori' | 'ryotedori';
  technique: string;
  variant: 'omote' | 'ura';
  principles: Principle[];
  requires: { maai: { minPx: number; idealPx: number; maxPx: number } };
  animations: {
    common: CommonAnimKey[];
    exclusive: Record<ExclusiveAnimKey, AnimationDef>;
  };
  phases: Phase[];
  branches: Record<string, Branch>;
}

/** 입력 시점(페이즈 시작 기준 ms)을 등급으로 판정. 구간은 [from, to) */
export const judge = (input: PhaseInput, pressedAtMs: number | null): Grade => {
  if (pressedAtMs === null || !input.window || input.targetMs === undefined) return 'miss';
  const d = pressedAtMs - input.targetMs;
  const inRange = ([from, to]: Range) => d >= from && d < to;
  if (inRange(input.window.perfect)) return 'perfect';
  if (inRange(input.window.early)) return 'early';
  if (inRange(input.window.late)) return 'late';
  return 'miss';
};
