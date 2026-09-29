/** technique.schema.json / animation.schema.json 과 1:1 대응하는 런타임 타입 */

export type Actor = 'nage' | 'uke' | 'fx';
export type Principle = 'maai' | 'musubi' | 'irimi' | 'tenkan' | 'kuzushi' | 'zanshin';
/** recognition(인지) → entry(기울이기/진입) → throw(던지기·우케미) */
export type Stage = 'recognition' | 'entry' | 'throw';
export type Grade = 'perfect' | 'early' | 'late' | 'miss';
export type UkemiGrade = 'perfect' | 'sloppy' | 'crash';
/** 페이즈 결과 키. auto: 입력 없음 / clear: 시퀀스 완주(Perfect 아닌 비트 포함) */
export type OutcomeKey = Grade | 'auto' | 'clear';
export type Button = 'ACTION' | 'GUARD';
export type Direction = 'FORWARD' | 'BACK' | 'UP' | 'DOWN';
export type CommonAnimKey = `common.${Actor}.${string}`;
export type ExclusiveAnimKey = `tech.${string}.${Actor}.${string}`;
export type AnimKey = CommonAnimKey | ExclusiveAnimKey;
export type Goto = `phase:${string}` | `branch:${string}` | 'ukemi' | 'end:success' | 'end:fail';

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

/** 단일 타이밍 체크 1회 */
export interface Beat {
  type: 'press' | 'direction_press' | 'hold_release';
  button: Button;
  direction?: Direction;
  targetMs: number;
  holdStartMaxMs?: number;
  sync?: { actor: 'nage' | 'uke'; event: string };
  window: TimingWindow;
}

export interface Reaction { type: 'whiff' | 'hit' | 'clash' | 'pushback'; px?: number }

export interface Effect {
  score?: number;
  musubi?: number;
  hitstopMs?: number;
  fx?: AnimKey;
  reaction?: Reaction;
}

export interface SequenceInput {
  type: 'sequence';
  beats: Beat[];
  /** 기본 ['miss'] */
  breakOn?: ('early' | 'late' | 'miss')[];
  beatEffects?: Partial<Record<'perfect' | 'early' | 'late', Effect>>;
}

export type PhaseInput = { type: 'none' } | Beat | SequenceInput;

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
export interface Actors { nage: ActorSlot; uke: ActorSlot }

export interface Outcome extends Effect {
  goto: Goto;
  /** 기본: branch/end:fail → true */
  interrupt?: boolean;
}

export interface Phase {
  id: string;
  stage: Stage;
  label: I18n;
  principle?: Principle;
  durationMs: number;
  actors: Actors;
  tracks: Tracks;
  input: PhaseInput;
  outcomes: Partial<Record<OutcomeKey, Outcome>>;
}

/** 입력 없는 연출 시퀀스(분기 / 낙법 결과) */
export interface Script {
  label: I18n;
  durationMs: number;
  actors: Actors;
  tracks: Tracks;
  result: { goto: Goto; damage?: number; musubi?: number; score?: number };
}

export interface UkemiRule {
  result: UkemiGrade;
  minSuccess?: number;
  minSuccessRatio?: number;
  minStreak?: number;
  minMusubi?: number;
  throwGrades?: Grade[];
}

export interface UkemiConfig {
  countStages?: Stage[];
  rules: UkemiRule[];
  results: Record<UkemiGrade, Script>;
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
  branches: Record<string, Script>;
  ukemi?: UkemiConfig;
}
