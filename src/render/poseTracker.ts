import type { EngineEvent } from '../engine/TimingEngine';
import type { Actors, AnimationDef, AnimKey, TechniqueData, TrackKey, Tracks } from '../types/technique';

/**
 * 엔진 이벤트 + 기술 데이터 → 캐릭터 포즈(기술 공간). Phaser 비의존 (ease 함수만 주입).
 * - phase: nage 는 기술 공간 절대좌표, uke 는 nage 기준 상대좌표
 * - branch/ukemi: nage 는 진입 시점 nage 위치 기준 델타
 */

export type EaseFn = (v: number) => number;
export type EaseResolver = (name: string) => EaseFn;

export interface TrackSample { x: number; y: number; facing?: 1 | -1; depth?: number }

/**
 * 구간 (k[i-1], k[i]] 의 보간은 k[i].ease 를 사용.
 * 'Stepped' = k[i].atMs 까지 이전 값 유지 후 스냅 (리미티드 애니메이션의 키포즈 전환).
 */
export const sampleTrack = (keys: TrackKey[], t: number, ease: EaseResolver): TrackSample => {
  const prop = (p: 'x' | 'y'): number => {
    let prev: TrackKey | undefined;
    for (const k of keys) {
      const v = k[p];
      if (v === undefined) continue;
      if (k.atMs <= t) { prev = k; continue; }
      if (!prev) return v;
      const name = k.ease ?? 'Linear';
      const pv = prev[p] as number;
      if (name === 'Stepped') return pv;
      const span = k.atMs - prev.atMs;
      return pv + (v - pv) * ease(name)(span > 0 ? (t - prev.atMs) / span : 1);
    }
    return (prev?.[p] as number | undefined) ?? 0;
  };
  let facing: 1 | -1 | undefined;
  let depth: number | undefined;
  for (const k of keys) {
    if (k.atMs > t) break;
    if (k.facing !== undefined) facing = k.facing;
    if (k.depth !== undefined) depth = k.depth;
  }
  return { x: prop('x'), y: prop('y'), facing, depth };
};

/** 애니 시작 기준 경과 ms → 프레임 인덱스 (holds, repeat 반영) */
export const frameAt = (def: AnimationDef, elapsedMs: number): number => {
  const n = def.end - def.start + 1;
  const tick = 1000 / def.frameRate;
  const dur = (i: number) => tick * (def.holds?.[String(i)] ?? 1);
  let total = 0;
  for (let i = 0; i < n; i++) total += dur(i);
  let t = Math.max(0, elapsedMs);
  const repeat = def.repeat ?? 0;
  if (repeat === -1) t %= total;
  else if (t >= total * (repeat + 1)) return n - 1;
  else t %= total;
  for (let i = 0; i < n; i++) {
    const d = dur(i);
    if (t < d) return i;
    t -= d;
  }
  return n - 1;
};

export const frameOffset = (def: AnimationDef | undefined, frame: number): { x: number; y: number } =>
  def?.frameOffsets?.find((f) => f.frame === frame) ?? { x: 0, y: 0 };

export interface ActorPose {
  /** 기술 공간 발 기준점 */
  x: number;
  y: number;
  facing: 1 | -1;
  depth: number;
  anim: AnimKey;
  frame: number;
  /** 프레임 기준점 보정(캐릭터 로컬: +x = 바라보는 방향) */
  offX: number;
  offY: number;
}

export interface Pose { nage: ActorPose; uke: ActorPose }

interface ActiveRun { tracks: Tracks; actors: Actors; start: number; script: boolean }

export class PoseTracker {
  private run: ActiveRun | null = null;
  private entry = { x: 0, y: 0 };
  private carry = { nage: { facing: 1 as 1 | -1, depth: 10 }, uke: { facing: -1 as 1 | -1, depth: 10 } };
  private endAt: number | null = null;

  constructor(
    private readonly data: TechniqueData,
    private readonly anims: Record<string, AnimationDef>,
    private readonly ease: EaseResolver,
  ) {}

  reset(): void {
    this.run = null;
    this.entry = { x: 0, y: 0 };
    this.carry = { nage: { facing: 1, depth: 10 }, uke: { facing: -1, depth: 10 } };
    this.endAt = null;
  }

  onEvent(e: EngineEvent): void {
    if (e.type === 'enter') this.enter(e.kind, e.id, e.atMs);
    else if (e.type === 'end') this.endAt = e.atMs;
  }

  get active(): boolean {
    return this.run !== null;
  }

  /** localMs: 엔진 로컬 시간(EngineState.nowMs). quantizeMs>0 이면 시퀀스 시간을 격자로 끊어 스내피하게 */
  poseAt(localMs: number, quantizeMs = 0): Pose | null {
    const r = this.run;
    if (!r) return null;
    let t = Math.max(0, Math.min(localMs, this.endAt ?? Infinity) - r.start);
    if (quantizeMs > 0) t = Math.floor(t / quantizeMs) * quantizeMs;

    const ns = sampleTrack(r.tracks.nage, t, this.ease);
    const us = sampleTrack(r.tracks.uke, t, this.ease);
    const nx = r.script ? this.entry.x + ns.x : ns.x;
    const ny = r.script ? this.entry.y + ns.y : ns.y;
    return {
      nage: this.actor('nage', r, t, nx, ny, ns),
      uke: this.actor('uke', r, t, nx + us.x, ny + us.y, us),
    };
  }

  private actor(a: 'nage' | 'uke', r: ActiveRun, t: number, x: number, y: number, s: TrackSample): ActorPose {
    const slot = r.actors[a];
    const def = this.anims[slot.anim];
    const frame = def ? frameAt(def, t - (slot.startAtMs ?? 0)) : 0;
    const off = frameOffset(def, frame);
    return {
      x, y,
      facing: s.facing ?? this.carry[a].facing,
      depth: s.depth ?? this.carry[a].depth,
      anim: slot.anim, frame, offX: off.x, offY: off.y,
    };
  }

  private lookup(kind: 'phase' | 'branch' | 'ukemi', id: string): Omit<ActiveRun, 'start'> {
    if (kind === 'phase') {
      const p = this.data.phases.find((ph) => ph.id === id);
      if (!p) throw new Error(`unknown phase ${id}`);
      return { tracks: p.tracks, actors: p.actors, script: false };
    }
    const s = kind === 'branch' ? this.data.branches[id] : this.data.ukemi?.results[id as 'perfect' | 'sloppy' | 'crash'];
    if (!s) throw new Error(`unknown ${kind} ${id}`);
    return { tracks: s.tracks, actors: s.actors, script: true };
  }

  private enter(kind: 'phase' | 'branch' | 'ukemi', id: string, at: number): void {
    const prev = this.run;
    if (prev) {
      // 이전 시퀀스 이탈 시점 포즈 → 다음 스크립트의 진입점 / facing·depth 이월
      const t = at - prev.start;
      const ns = sampleTrack(prev.tracks.nage, t, this.ease);
      this.entry = prev.script ? { x: this.entry.x + ns.x, y: this.entry.y + ns.y } : { x: ns.x, y: ns.y };
      for (const a of ['nage', 'uke'] as const) {
        const s = a === 'nage' ? ns : sampleTrack(prev.tracks.uke, t, this.ease);
        if (s.facing !== undefined) this.carry[a].facing = s.facing;
        if (s.depth !== undefined) this.carry[a].depth = s.depth;
      }
    }
    this.run = { ...this.lookup(kind, id), start: at };
    this.endAt = null;
  }
}
