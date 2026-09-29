import type {
  Actors,
  AnimKey,
  Beat,
  Button,
  Direction,
  Effect,
  Goto,
  Grade,
  OutcomeKey,
  Phase,
  Reaction,
  Script,
  Stage,
  TechniqueData,
  TrackKey,
  Tracks,
  UkemiGrade,
} from '../types/technique';
import { beatsOf, gradeOffset } from './judge';
import { cloneStats, createStats, recordGrade, type TimingStats } from './stats';
import { deriveUkemi, summarizeForUkemi } from './ukemi';

/**
 * Universal Timing State Machine
 *
 * 기술 JSON(TechniqueData)만으로 동작하는 프레임워크 독립(Phaser 비의존) 타이밍 판정기.
 *
 *   Stage 1 recognition ─▶ Stage 2 entry (n-beat sequence) ─▶ Stage 3 throw ─▶ ukemi(perfect|sloppy|crash)
 *          │ early: 헛스윙/피격     │ late: 충돌/밀려남        │ miss: 이탈 ...  ─▶ branch ─▶ end:fail
 *
 * 시간 모델
 * - 입력은 자체 타임스탬프(KeyboardEvent.timeStamp 등)로 큐잉되고 update(now) 에서 시간순으로 처리된다.
 *   → 판정 정밀도가 렌더 프레임(16.7ms)에 묶이지 않는다.
 * - 모든 판정은 "엔진 로컬 시간"(start 기준, 히트스톱 동안 정지)으로 이뤄진다.
 * - 구간은 [from, to) 반열림. 판정 구간 밖 입력은 무시(연타 방지 로직은 window 설계로 해결).
 */

export type Stick = 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
export type RunKind = 'phase' | 'branch' | 'ukemi';

export interface TimingEngineOptions {
  /** 무스비 게이지 시작값 (기본 50) */
  initialMusubi?: number;
  /** 무스비 게이지 최대값 (기본 100) */
  musubiMax?: number;
  /** true: nage 가 화면 오른쪽 (기술 공간 +x = 화면 왼쪽) */
  mirror?: boolean;
}

export type EngineEvent =
  | { type: 'enter'; kind: RunKind; id: string; stage: Stage | null; atMs: number }
  | { type: 'windowOpen'; phaseId: string; beat: number; beats: number; targetAtMs: number; atMs: number }
  | { type: 'holdStart'; phaseId: string; beat: number; atMs: number }
  | {
      type: 'judged';
      phaseId: string;
      stage: Stage;
      beat: number;
      beats: number;
      grade: Grade;
      /** 입력시점 - targetMs. 무입력 miss 는 null */
      offsetMs: number | null;
      wrongDirection: boolean;
      atMs: number;
    }
  | {
      type: 'inputIgnored';
      button: Button;
      /** idle: 판정할 비트 없음 / button: 다른 버튼 / outside_window: 구간 밖 / repeat: 키 리피트 / hold_late: 홀드 시작 마감 이후 */
      reason: 'idle' | 'button' | 'outside_window' | 'repeat' | 'hold_late';
      phaseId: string | null;
      /** 현재 시퀀스 시작 기준 ms */
      seqMs: number;
      atMs: number;
    }
  | { type: 'resolved'; phaseId: string; stage: Stage; result: OutcomeKey; goto: Goto; atMs: number }
  | { type: 'reaction'; phaseId: string; reaction: Reaction; atMs: number }
  | { type: 'fx'; anim: AnimKey; atMs: number }
  | { type: 'hitstop'; durationMs: number; atMs: number }
  | { type: 'ukemi'; result: UkemiGrade; successes: number; checks: number; atMs: number }
  | { type: 'end'; result: 'success' | 'fail'; ukemi: UkemiGrade | null; stats: TimingStats; atMs: number };

export type EngineListener = (e: EngineEvent) => void;

/** 현재 페이즈의 비트 진행 상태 (디버그 오버레이용) */
export interface BeatState {
  /** 다음에 판정할 비트 인덱스 (count 와 같으면 모두 판정됨) */
  index: number;
  count: number;
  /** 현재 비트 판정 구간이 열려 있음 */
  windowOpen: boolean;
  /** 페이즈 결과 확정 (전환 대기) */
  resolved: boolean;
  /** hold_release 누르고 있는 중 */
  holding: boolean;
}

export interface EngineState {
  ended: 'success' | 'fail' | null;
  kind: RunKind | null;
  id: string | null;
  stage: Stage | null;
  /** 엔진 로컬 시간(start 기준, 히트스톱 동안 정지). 이벤트 atMs 와 같은 축 */
  nowMs: number;
  /** 현재 시퀀스 시작 기준 경과(ms, 히트스톱 제외) — 렌더러가 tracks/anim 샘플링에 사용 */
  seqMs: number;
  durationMs: number;
  actors: Actors | null;
  tracks: Tracks | null;
  /** 기술 공간 기준 nage facing (현재 시퀀스 시작 시점) */
  nageFacing: 1 | -1;
  hitstop: boolean;
  /** phase 실행 중일 때만 */
  beat: BeatState | null;
  ukemi: UkemiGrade | null;
  stats: TimingStats;
}

interface PhaseRun {
  kind: 'phase';
  id: string;
  phase: Phase;
  start: number;
  beats: Beat[];
  beatIdx: number;
  beatGrades: Grade[];
  windowOpened: boolean;
  /** hold_release: 누르기 시작 시점(로컬), 없으면 null */
  holdStart: number | null;
  /** 판정 완료(페이즈 결과 확정) */
  resolved: boolean;
  /** 페이즈 종료 시 적용할 goto (interrupt=false) */
  pending: Goto | null;
  inputFacing: 1 | -1;
}

interface ScriptRun {
  kind: 'branch' | 'ukemi';
  id: string;
  script: Script;
  start: number;
  inputFacing: 1 | -1;
}

type Run = PhaseRun | ScriptRun;

interface Queued { kind: 'press' | 'release'; button: Button; stick?: Stick; t: number; seq: number }
interface Scheduled { at: number; pri: number; fire: () => void }

const durationOf = (r: Run): number => (r.kind === 'phase' ? r.phase.durationMs : r.script.durationMs);
const tracksOf = (r: Run): Tracks => (r.kind === 'phase' ? r.phase.tracks : r.script.tracks);

/** atMs <= t 인 키 중 마지막 facing */
const facingUntil = (keys: TrackKey[], t: number): 1 | -1 | undefined => {
  let f: 1 | -1 | undefined;
  for (const k of keys) {
    if (k.atMs > t) break;
    if (k.facing !== undefined) f = k.facing;
  }
  return f;
};

const MAX_STEPS = 10_000;

export class TimingEngine {
  private readonly phaseIndex: Map<string, number>;
  private readonly opts: Required<TimingEngineOptions>;
  private readonly listeners = new Set<EngineListener>();

  private started = false;
  private origin = 0;
  /** 로컬 시간 기준 히트스톱 구간 (append-only, 시간순) */
  private freezes: { start: number; dur: number }[] = [];
  private now = 0;
  private run: Run | null = null;
  private ended: 'success' | 'fail' | null = null;
  private queue: Queued[] = [];
  private seq = 0;
  private held = new Set<Button>();
  private nageFacing: 1 | -1 = 1;
  private ukemi: UkemiGrade | null = null;
  private stats: TimingStats;
  private outbox: EngineEvent[] = [];

  constructor(private readonly data: TechniqueData, options: TimingEngineOptions = {}) {
    this.opts = { initialMusubi: 50, musubiMax: 100, mirror: false, ...options };
    this.phaseIndex = new Map(data.phases.map((p, i) => [p.id, i]));
    this.stats = createStats(this.opts.initialMusubi);
  }

  // ───────────────────────────── public API ─────────────────────────────

  on(fn: EngineListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 기술 시작. nowMs 는 이후 press/release/update 와 같은 시계(performance.now 계열) */
  start(nowMs: number): EngineEvent[] {
    this.started = true;
    this.origin = nowMs;
    this.freezes = [];
    this.now = 0;
    this.run = null;
    this.ended = null;
    this.queue = [];
    this.nageFacing = 1;
    this.ukemi = null;
    this.stats = createStats(this.opts.initialMusubi);
    this.enterPhase(0);
    return this.flush();
  }

  press(button: Button, atMs: number, stick?: Stick): void {
    this.queue.push({ kind: 'press', button, stick, t: atMs, seq: this.seq++ });
  }

  release(button: Button, atMs: number): void {
    this.queue.push({ kind: 'release', button, t: atMs, seq: this.seq++ });
  }

  /** 매 프레임 호출. 큐의 입력과 예약 이벤트(구간 열림/닫힘, 페이즈 종료)를 시간순으로 처리 */
  update(nowMs: number): EngineEvent[] {
    if (!this.started) return [];
    this.queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
    let i = 0;
    for (; i < this.queue.length && this.queue[i].t <= nowMs; i++) {
      const q = this.queue[i];
      this.advanceTo(q.t);
      this.applyInput(q);
    }
    this.queue.splice(0, i);
    this.advanceTo(nowMs);
    return this.flush();
  }

  getState(nowMs?: number): EngineState {
    const r = this.run;
    return {
      ended: this.ended,
      kind: r?.kind ?? null,
      id: r?.id ?? null,
      stage: r ? this.stageOf(r) : null,
      nowMs: this.now,
      seqMs: r ? this.now - r.start : 0,
      durationMs: r ? durationOf(r) : 0,
      actors: r ? (r.kind === 'phase' ? r.phase.actors : r.script.actors) : null,
      tracks: r ? tracksOf(r) : null,
      nageFacing: r?.inputFacing ?? this.nageFacing,
      hitstop: nowMs !== undefined && this.isFrozen(nowMs),
      beat: r?.kind === 'phase'
        ? {
            index: r.beatIdx, count: r.beats.length, windowOpen: r.windowOpened,
            resolved: r.resolved, holding: r.holdStart !== null,
          }
        : null,
      ukemi: this.ukemi,
      stats: cloneStats(this.stats),
    };
  }

  // ───────────────────────────── clock ─────────────────────────────

  /** 절대시간 → 로컬 시간 (히트스톱 구간 동안 정지) */
  private toLocal(abs: number): number {
    let off = this.origin;
    for (const f of this.freezes) {
      const fAbs = f.start + off;
      if (abs < fAbs) break;
      if (abs < fAbs + f.dur) return f.start;
      off += f.dur;
    }
    return abs - off;
  }

  private isFrozen(abs: number): boolean {
    let off = this.origin;
    for (const f of this.freezes) {
      const fAbs = f.start + off;
      if (abs >= fAbs && abs < fAbs + f.dur) return true;
      off += f.dur;
    }
    return false;
  }

  private advanceTo(abs: number): void {
    for (let step = 0; ; step++) {
      if (step > MAX_STEPS) throw new Error('[TimingEngine] scheduler did not converge');
      if (!this.run) break;
      const next = this.nextScheduled(this.run);
      if (next.at > this.toLocal(abs)) break;
      this.now = Math.max(this.now, next.at);
      next.fire();
    }
    this.now = Math.max(this.now, this.toLocal(abs));
  }

  private nextScheduled(r: Run): Scheduled {
    const end: Scheduled = {
      at: r.start + durationOf(r),
      pri: 3,
      fire: () => (r.kind === 'phase' ? this.finishPhase(r) : this.finishScript(r)),
    };
    if (r.kind !== 'phase' || r.resolved || r.beatIdx >= r.beats.length) return end;

    const b = r.beats[r.beatIdx];
    const cands: Scheduled[] = [end];
    if (b.type === 'hold_release' && r.holdStart === null) {
      // 누르기 시작 마감 → 무입력 miss
      cands.push({ at: r.start + (b.holdStartMaxMs ?? 0), pri: 0, fire: () => this.judge(r, 'miss', null) });
    }
    if (!r.windowOpened) {
      cands.push({
        at: r.start + b.targetMs + b.window.early[0],
        pri: 1,
        fire: () => {
          r.windowOpened = true;
          this.emit({
            type: 'windowOpen', phaseId: r.id, beat: r.beatIdx, beats: r.beats.length,
            targetAtMs: r.start + b.targetMs, atMs: this.now,
          });
        },
      });
    }
    cands.push({
      at: r.start + b.targetMs + b.window.late[1],
      pri: 2,
      fire: () => {
        // 구간 종료: 홀드 유지 중이면 과유지(late=충돌), 아니면 무입력 miss
        if (b.type === 'hold_release' && r.holdStart !== null) this.judge(r, 'late', b.window.late[1]);
        else this.judge(r, 'miss', null);
      },
    });
    return cands.reduce((a, c) => (c.at < a.at || (c.at === a.at && c.pri < a.pri) ? c : a));
  }

  // ───────────────────────────── input ─────────────────────────────

  private applyInput(q: Queued): void {
    if (q.kind === 'release') {
      this.held.delete(q.button);
      this.onRelease(q.button);
      return;
    }
    if (this.held.has(q.button)) {
      this.ignore(q.button, 'repeat'); // 키 리피트 무시
      return;
    }
    this.held.add(q.button);
    this.onPress(q.button, q.stick);
  }

  private ignore(button: Button, reason: Extract<EngineEvent, { type: 'inputIgnored' }>['reason']): void {
    const r = this.run;
    this.emit({
      type: 'inputIgnored', button, reason,
      phaseId: r?.kind === 'phase' ? r.id : null,
      seqMs: r ? this.now - r.start : 0,
      atMs: this.now,
    });
  }

  private currentBeat(): { r: PhaseRun; b: Beat } | null {
    const r = this.run;
    if (!r || r.kind !== 'phase' || r.resolved || r.beatIdx >= r.beats.length) return null;
    return { r, b: r.beats[r.beatIdx] };
  }

  private onPress(button: Button, stick: Stick | undefined): void {
    const cur = this.currentBeat();
    if (!cur) return this.ignore(button, 'idle');
    if (cur.b.button !== button) return this.ignore(button, 'button');
    const { r, b } = cur;
    const t = this.now - r.start;

    if (b.type === 'hold_release') {
      if (r.holdStart === null && t < (b.holdStartMaxMs ?? 0)) {
        r.holdStart = this.now;
        this.emit({ type: 'holdStart', phaseId: r.id, beat: r.beatIdx, atMs: this.now });
      } else {
        this.ignore(button, 'hold_late');
      }
      return;
    }

    const d = t - b.targetMs;
    const g = gradeOffset(b.window, d);
    if (g === null) return this.ignore(button, 'outside_window');

    if (b.type === 'direction_press' && this.relDirection(stick, r.inputFacing) !== b.direction) {
      this.judge(r, 'miss', d, true); // 틀린 방향 = 잘못된 기술 선택
      return;
    }
    this.judge(r, g, d);
  }

  private onRelease(button: Button): void {
    const cur = this.currentBeat();
    if (!cur) return;
    const { r, b } = cur;
    if (b.type !== 'hold_release' || b.button !== button || r.holdStart === null) return;
    const d = this.now - r.start - b.targetMs;
    // 구간 전 조기 해제 = early(헛스윙)
    const g = d < b.window.early[0] ? 'early' : (gradeOffset(b.window, d) ?? 'late');
    this.judge(r, g, d);
  }

  /** 화면 방향 입력 → nage facing 기준 상대 방향 */
  private relDirection(stick: Stick | undefined, facing: 1 | -1): Direction | undefined {
    if (!stick) return undefined;
    if (stick === 'UP' || stick === 'DOWN') return stick;
    const world = stick === 'RIGHT' ? 1 : -1;
    const tech = this.opts.mirror ? -world : world;
    return tech === facing ? 'FORWARD' : 'BACK';
  }

  // ───────────────────────────── judgement ─────────────────────────────

  private judge(r: PhaseRun, grade: Grade, offsetMs: number | null, wrongDirection = false): void {
    const beat = r.beatIdx;
    recordGrade(this.stats, r.phase.stage, grade);
    this.emit({
      type: 'judged', phaseId: r.id, stage: r.phase.stage, beat, beats: r.beats.length,
      grade, offsetMs, wrongDirection, atMs: this.now,
    });
    r.beatGrades.push(grade);
    r.beatIdx++;
    r.windowOpened = false;
    r.holdStart = null;

    const input = r.phase.input;
    if (input.type !== 'sequence') {
      this.resolve(r, grade);
      return;
    }

    // n-beat sequence
    if (grade !== 'perfect' && (input.breakOn ?? ['miss']).includes(grade)) {
      this.resolve(r, grade);
      return;
    }
    const eff = grade === 'miss' ? undefined : input.beatEffects?.[grade];
    if (eff) this.applyEffect(eff, r.id);

    if (r.beatIdx >= r.beats.length) {
      this.resolve(r, r.beatGrades.every((g) => g === 'perfect') ? 'perfect' : 'clear');
      return;
    }
    const next = r.beats[r.beatIdx];
    if (next.type === 'hold_release' && this.held.has(next.button)) r.holdStart = this.now;
  }

  private resolve(r: PhaseRun, key: OutcomeKey): void {
    const o = r.phase.outcomes[key];
    if (!o) throw new Error(`[TimingEngine] phase '${r.id}': outcomes.${key} 가 정의되지 않음`);
    r.resolved = true;
    this.applyEffect(o, r.id);
    this.emit({ type: 'resolved', phaseId: r.id, stage: r.phase.stage, result: key, goto: o.goto, atMs: this.now });
    const interrupt = o.interrupt ?? (o.goto.startsWith('branch:') || o.goto === 'end:fail');
    if (interrupt) this.goto(o.goto);
    else r.pending = o.goto;
  }

  private applyEffect(e: Effect, phaseId: string): void {
    if (e.score) this.stats.score += e.score;
    if (e.musubi) this.addMusubi(e.musubi);
    if (e.reaction) this.emit({ type: 'reaction', phaseId, reaction: e.reaction, atMs: this.now });
    if (e.fx) this.emit({ type: 'fx', anim: e.fx, atMs: this.now });
    if (e.hitstopMs) {
      this.freezes.push({ start: this.now, dur: e.hitstopMs });
      this.emit({ type: 'hitstop', durationMs: e.hitstopMs, atMs: this.now });
    }
  }

  private addMusubi(delta: number): void {
    this.stats.musubi = Math.min(this.opts.musubiMax, Math.max(0, this.stats.musubi + delta));
  }

  // ───────────────────────────── transitions ─────────────────────────────

  private finishPhase(r: PhaseRun): void {
    // 방어: 데이터 오류로 구간이 페이즈 밖에 남은 비트는 miss 처리
    while (this.run === r && !r.resolved && r.beatIdx < r.beats.length) this.judge(r, 'miss', null);
    if (this.run !== r) return;
    if (!r.resolved) {
      this.resolve(r, 'auto'); // input: none
      if (this.run !== r) return;
    }
    if (r.pending) this.goto(r.pending);
  }

  private finishScript(r: ScriptRun): void {
    this.goto(r.script.result.goto);
  }

  private goto(g: Goto): void {
    this.leaveRun();
    if (g.startsWith('phase:')) {
      const id = g.slice(6);
      const idx = this.phaseIndex.get(id);
      if (idx === undefined) throw new Error(`[TimingEngine] 없는 phase '${id}'`);
      this.enterPhase(idx);
    } else if (g.startsWith('branch:')) {
      const id = g.slice(7);
      const script = this.data.branches[id];
      if (!script) throw new Error(`[TimingEngine] 없는 branch '${id}'`);
      this.enterScript('branch', id, script);
    } else if (g === 'ukemi') {
      const cfg = this.data.ukemi;
      if (!cfg) throw new Error(`[TimingEngine] '${this.data.id}' 에 ukemi 정의가 없음`);
      const summary = summarizeForUkemi(this.stats, cfg.countStages);
      const result = deriveUkemi(summary, cfg.rules);
      this.ukemi = result;
      this.emit({ type: 'ukemi', result, successes: summary.successes, checks: summary.checks, atMs: this.now });
      this.enterScript('ukemi', result, cfg.results[result]);
    } else {
      this.run = null;
      this.ended = g === 'end:success' ? 'success' : 'fail';
      this.emit({ type: 'end', result: this.ended, ukemi: this.ukemi, stats: cloneStats(this.stats), atMs: this.now });
    }
  }

  private leaveRun(): void {
    const r = this.run;
    if (!r) return;
    const f = facingUntil(tracksOf(r).nage, this.now - r.start);
    if (f !== undefined) this.nageFacing = f;
  }

  private enterPhase(idx: number): void {
    const phase = this.data.phases[idx];
    const f0 = facingUntil(phase.tracks.nage, 0);
    if (f0 !== undefined) this.nageFacing = f0;
    const r: PhaseRun = {
      kind: 'phase', id: phase.id, phase, start: this.now,
      beats: beatsOf(phase.input), beatIdx: 0, beatGrades: [],
      windowOpened: false, holdStart: null, resolved: false, pending: null,
      inputFacing: this.nageFacing,
    };
    this.run = r;
    this.emit({ type: 'enter', kind: 'phase', id: phase.id, stage: phase.stage, atMs: this.now });
    const b0 = r.beats[0];
    if (b0?.type === 'hold_release' && this.held.has(b0.button)) r.holdStart = this.now;
  }

  private enterScript(kind: 'branch' | 'ukemi', id: string, script: Script): void {
    const f0 = facingUntil(script.tracks.nage, 0);
    if (f0 !== undefined) this.nageFacing = f0;
    this.run = { kind, id, script, start: this.now, inputFacing: this.nageFacing };
    this.emit({ type: 'enter', kind, id, stage: kind === 'ukemi' ? 'throw' : null, atMs: this.now });
    const { damage, musubi, score } = script.result;
    if (damage) this.stats.damage += damage;
    if (musubi) this.addMusubi(musubi);
    if (score) this.stats.score += score;
  }

  private stageOf(r: Run): Stage | null {
    if (r.kind === 'phase') return r.phase.stage;
    return r.kind === 'ukemi' ? 'throw' : null;
  }

  // ───────────────────────────── events ─────────────────────────────

  private emit(e: EngineEvent): void {
    this.outbox.push(e);
  }

  /** 리스너는 update() 종료 시점에 일괄 호출 → 리스너 안에서 press() 등을 불러도 재진입 안전 */
  private flush(): EngineEvent[] {
    const out = this.outbox;
    this.outbox = [];
    for (const e of out) for (const fn of this.listeners) fn(e);
    return out;
  }
}
