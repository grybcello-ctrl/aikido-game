import Phaser from 'phaser';
import commonJson from '../data/animations/common.json';
import techJson from '../data/techniques/shomenuchi_iriminage_ura.json';
import { ANIM_FPS } from '../config/animation';
import { FLOOR_Y, GAME_HEIGHT, GAME_WIDTH } from '../config/gameConfig';
import { beatsOf } from '../engine/judge';
import { bindKeyboard } from '../engine/phaserBridge';
import { TimingEngine, type EngineEvent, type EngineState } from '../engine/TimingEngine';
import { GameClock } from '../render/clock';
import { PoseTracker, frameAt, type ActorPose, type EaseFn, type Pose } from '../render/poseTracker';
import type {
  AnimationDef, AnimationRegistry, Beat, Direction, Grade, Phase, Stage, TechniqueData, UkemiGrade,
} from '../types/technique';
import { FONT_FAMILY } from './fonts';
import { StateOverlay, type OverlayLine } from './StateOverlay';
import { FRAME_MS, GRADE_COLOR, TimingDebugger, fmtMs, hex } from './TimingDebugger';

type Ev<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;
type Mode = 'ready' | 'approach' | 'technique' | 'result';

const TECH = techJson as unknown as TechniqueData;
const ANIMS: Record<string, AnimationDef> = {
  ...(commonJson as unknown as AnimationRegistry).animations,
  ...TECH.animations.exclusive,
};

const C = {
  bg: 0x18181b, floor: 0x52525b, mat: 0x27272a,
  tori: 0x3b82f6, toriLight: 0x93c5fd,
  uke: 0xef4444, ukeLight: 0xfca5a5,
  origin: 0xffffff, offset: 0xfde047, dist: 0x22d3ee,
};
const UKEMI_COLOR: Record<UkemiGrade, number> = { perfect: 0x22c55e, sloppy: 0xfacc15, crash: 0xef4444 };
/** 판정 시 토리 머리 위 플로팅 텍스트 */
const JUDGE_FLOAT: Record<Grade, string> = {
  perfect: 'PERFECT!',
  early: 'TOO EARLY (연결 실패)',
  late: 'TOO LATE (거리 붕괴)',
  miss: 'MISS (무반응)',
};
const STAGE_NUM: Record<Stage, number> = { recognition: 1, entry: 2, throw: 3 };
const HP_MAX = 100;
const SPEEDS = [1, 0.5, 0.25];
const BODY_W = 16;
const BODY_H = 40;
/** 우케 접근 시작 거리(기술 공간 px). 첫 페이즈 uke x(마아이)에 도달하면 엔진 시작 */
const APPROACH_FROM = 260;
const SNAP_MS = 1000 / ANIM_FPS.DEFAULT;
const MAAI_X = TECH.phases[0].tracks.uke[0].x ?? 80;
const ACTION_NAME = `${cap(TECH.attack)} › ${cap(TECH.technique)} ${cap(TECH.variant)}`;

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const signed = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}`;

interface Fx { kind: 'ring' | 'spark' | 'ghost'; x: number; y: number; start: number; dur: number; color: number; dir: number }
/**
 * 화면 좌표 앵커
 * root = 트랙이 지정한 기준점(Origin Point, 발 중심) / x,y = 프레임 오프셋·밀려남 적용 후 실제 그리는 기준점
 */
interface Anchor { rootX: number; rootY: number; x: number; y: number; top: number; chest: number }

const easeCache = new Map<string, EaseFn>();
const ease = (name: string): EaseFn => {
  let f = easeCache.get(name);
  if (!f) {
    f = Phaser.Tweens.Builders.GetEaseFunction(name) as unknown as EaseFn;
    easeCache.set(name, f);
  }
  return f;
};

/** 더미 사각형 포즈 추정 (스프라이트 대신) */
const isLying = (p: ActorPose): boolean =>
  (/(ukemi_back|ukemi_sloppy|crash|down)$/.test(p.anim) && p.frame >= 2) || (/thrown$/.test(p.anim) && p.frame >= 3);
const armPose = (p: ActorPose): 'rest' | 'up' | 'strike' => {
  if (/windup$/.test(p.anim)) return p.frame >= 1 ? 'up' : 'rest';
  if (/shomenuchi_strike$/.test(p.anim)) return p.frame <= 1 ? 'up' : 'strike';
  if (/(irimi_awase|throw_cut|lead_shoulder|whiff_hit)$/.test(p.anim) && p.frame >= 1) return 'strike';
  return 'rest';
};
const shortAnim = (key: string) => key.split('.').pop() ?? key;

/**
 * 시각 디버깅 프로토타입 씬 — 도형은 전부 Phaser Graphics 로 그린다 (글자만 Text)
 *   ready → approach(우케 접근) → technique(TimingEngine) → result
 * 1) 공간: 토리(파랑)/우케(빨강) Origin Point 십자선(+), 프레임 오프셋 Δ 표시, 두 기준점 사이 거리선 + px
 * 2) 시간: 하단 프레임 미터 타임라인(E 노랑 / P 초록 / L 빨강), 입력 ▼ 마커 + "오차: +15ms" 팝업
 * 3) 상태: 좌상단 [STATE]/[ACTION]/[HP] 오버레이 + 상태 머신 로그, 판정 시 머리 위 플로팅 텍스트
 */
export class PrototypeScene extends Phaser.Scene {
  private clock!: GameClock;
  private engine: TimingEngine | null = null;
  private tracker!: PoseTracker;
  private timeline!: TimingDebugger;
  private overlay!: StateOverlay;
  private state: EngineState | null = null;

  private mode: Mode = 'ready';
  private mirror = false;
  private snappy = true;
  private labels = true;
  private speedIdx = 0;
  private round = 0;
  private hp = HP_MAX;
  private approach = { start: 0, speed: 0.15 };
  private fx: Fx[] = [];
  private push: { px: number; start: number; dur: number } | null = null;
  private branchLabel: string | null = null;
  private lastJudge: OverlayLine = { text: '[LAST: —]', color: 0x71717a };
  private panel: { lines: string[]; color: number } | null = null;
  /** 머리 위 플로팅 텍스트 (최신이 아래, 이전 것은 한 칸씩 위로 밀려 겹치지 않음) */
  private floats: { t: Phaser.GameObjects.Text; x: number; y: number; born: number }[] = [];

  private worldLayer!: Phaser.GameObjects.Layer;
  private uiLayer!: Phaser.GameObjects.Layer;
  private world!: Phaser.GameObjects.Graphics;
  private debugG!: Phaser.GameObjects.Graphics;
  private fxG!: Phaser.GameObjects.Graphics;
  private uiG!: Phaser.GameObjects.Graphics;
  private flashG!: Phaser.GameObjects.Graphics;
  private toriLabel!: Phaser.GameObjects.Text;
  private ukeLabel!: Phaser.GameObjects.Text;
  private distText!: Phaser.GameObjects.Text;
  private hudRight!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private panelText!: Phaser.GameObjects.Text;

  constructor() {
    super('prototype');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(C.bg);
    this.clock = new GameClock(this.game.loop.now);

    // 월드(셰이크 대상)와 UI(고정) 카메라 분리
    this.worldLayer = this.add.layer();
    this.uiLayer = this.add.layer();
    const uiCam = this.cameras.add(0, 0, GAME_WIDTH, GAME_HEIGHT);
    uiCam.ignore(this.worldLayer);
    this.cameras.main.ignore(this.uiLayer);

    const font = (size: number, color = '#e4e4e7') => ({ fontFamily: FONT_FAMILY, fontSize: `${size}px`, color });
    const outlined = { stroke: '#000000', strokeThickness: 3 };

    this.world = this.add.graphics();
    this.debugG = this.add.graphics();
    this.fxG = this.add.graphics();
    this.toriLabel = this.add.text(0, 0, '', { ...font(8, '#93c5fd'), align: 'center', ...outlined }).setOrigin(0.5, 1);
    this.ukeLabel = this.add.text(0, 0, '', { ...font(8, '#fca5a5'), align: 'center', ...outlined }).setOrigin(0.5, 1);
    this.distText = this.add.text(0, 0, '', { ...font(9), fontStyle: 'bold', backgroundColor: 'rgba(0,0,0,0.65)', padding: { x: 2, y: 0 } }).setOrigin(0.5, 1);
    this.worldLayer.add([this.world, this.debugG, this.fxG, this.toriLabel, this.ukeLabel, this.distText]);

    this.uiG = this.add.graphics();
    this.hudRight = this.add.text(GAME_WIDTH - 8, 6, '', font(9, '#a1a1aa')).setOrigin(1, 0);
    const help = this.add.text(GAME_WIDTH - 8, 18, 'Space 입력 · ←→ 방향 · R 재시작 · M 반전 · T 배속 · Q 스냅 · D 라벨', font(8, '#71717a')).setOrigin(1, 0);
    const legend = this.add.text(GAME_WIDTH - 8, 29, '+ Origin(트랙)  × 프레임 오프셋 적용점  ── 거리', font(8, '#71717a')).setOrigin(1, 0);
    this.phaseText = this.add.text(GAME_WIDTH - 8, 44, '', { ...font(12), ...outlined }).setOrigin(1, 0);
    this.hintText = this.add.text(GAME_WIDTH - 8, 60, '', { ...font(10, '#a1a1aa'), ...outlined }).setOrigin(1, 0);
    this.panelText = this.add.text(GAME_WIDTH / 2, 196, '', { ...font(11), align: 'center', lineSpacing: 4 }).setOrigin(0.5);
    this.flashG = this.add.graphics().setAlpha(0);
    this.uiLayer.add([this.uiG, this.hudRight, help, legend, this.phaseText, this.hintText, this.panelText]);

    this.overlay = new StateOverlay(this, this.uiLayer);
    this.timeline = new TimingDebugger(this, TECH, this.uiLayer);
    this.uiLayer.add(this.flashG);
    this.tracker = new PoseTracker(TECH, ANIMS, ease);

    // 기술 입력(Space) → 엔진 (technique 모드에서만). 이벤트 타임스탬프를 가상시간으로 변환
    bindKeyboard(this, () => (this.mode === 'technique' ? this.engine : null), (t) => this.clock.toVirtual(t));

    const kb = this.input.keyboard!;
    kb.on('keydown-ENTER', () => { if (this.mode === 'ready' || this.mode === 'result') this.startRound(); });
    kb.on('keydown-SPACE', () => { if (this.mode === 'ready') this.startRound(); });
    kb.on('keydown-R', () => this.startRound());
    kb.on('keydown-M', () => { this.mirror = !this.mirror; if (this.mode !== 'ready') this.startRound(); });
    kb.on('keydown-T', () => {
      this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
      this.clock.setScale(SPEEDS[this.speedIdx], this.game.loop.now);
      this.tweens.timeScale = SPEEDS[this.speedIdx];
    });
    kb.on('keydown-Q', () => { this.snappy = !this.snappy; });
    kb.on('keydown-D', () => { this.labels = !this.labels; });

    // 탭 비활성화 동안 게임 시계 정지 (복귀 시 판정 구간이 한꺼번에 지나가는 것 방지)
    this.game.events.on(Phaser.Core.Events.HIDDEN, () => this.clock.pause(performance.now()));
    this.game.events.on(Phaser.Core.Events.VISIBLE, () => this.clock.resume(performance.now()));

    (window as unknown as { __aikido?: PrototypeScene }).__aikido = this;
    this.showReady();
  }

  /** 콘솔/자동화 테스트용 스냅샷 */
  debugSnapshot() {
    return { mode: this.mode, round: this.round, hp: this.hpNow(), mirror: this.mirror, speed: SPEEDS[this.speedIdx], state: this.state };
  }

  update(): void {
    const now = this.vNow();
    if (this.mode === 'approach' && this.engine) {
      const startAt = this.approach.start + (APPROACH_FROM - MAAI_X) / this.approach.speed;
      if (now >= startAt) {
        this.mode = 'technique';
        this.handle(this.engine.start(startAt));
      }
    }
    if (this.engine && (this.mode === 'technique' || this.mode === 'result')) {
      this.handle(this.engine.update(now));
      this.state = this.engine.getState(now);
    }
    this.render(now);
  }

  // ───────────────────────────── flow ─────────────────────────────

  private vNow(): number {
    return this.clock.toVirtual(this.game.loop.now);
  }

  private originX(): number {
    return this.mirror ? 420 : 220;
  }

  private hpNow(): number {
    return Math.max(0, this.hp - (this.mode === 'result' ? 0 : this.state?.stats.damage ?? 0));
  }

  private showReady(): void {
    this.mode = 'ready';
    this.panel = {
      color: 0xe4e4e7,
      lines: [
        'AIKIDO TIMING — VISUAL DEBUG PROTOTYPE',
        TECH.name.ko,
        '',
        'Space / Enter : 시작',
        'Space : 기술 입력   ← → : 방향 (텐칸 = 뒤쪽 + Space)',
        'R 재시작 · M 좌우반전 · T 배속 · Q 스냅 · D 라벨',
      ],
    };
    this.phaseText.setText('');
    this.hintText.setText('');
  }

  private startRound(): void {
    this.round++;
    if (this.hp <= 0) this.hp = HP_MAX;
    this.engine = new TimingEngine(TECH, { mirror: this.mirror });
    this.tracker.reset();
    this.timeline.reset();
    this.overlay.reset();
    this.state = null;
    this.fx = [];
    this.push = null;
    this.branchLabel = null;
    this.panel = null;
    this.floats.forEach((f) => f.t.destroy());
    this.floats = [];
    this.lastJudge = { text: '[LAST: —]', color: 0x71717a };
    this.mode = 'approach';
    this.approach = { start: this.vNow(), speed: Phaser.Math.FloatBetween(0.09, 0.2) };
    this.phaseText.setText('우케 접근 중 — 마아이를 읽어라').setColor('#a1a1aa');
    this.hintText.setText('');
  }

  // ───────────────────────────── engine events ─────────────────────────────

  private handle(events: EngineEvent[]): void {
    for (const e of events) {
      this.tracker.onEvent(e);
      this.timeline.onEvent(e);
      this.overlay.pushEvent(e);
      switch (e.type) {
        case 'enter': this.onEnter(e); break;
        case 'judged': this.onJudged(e); break;
        case 'reaction': this.onReaction(e); break;
        case 'hitstop': this.onHitstop(e.durationMs); break;
        case 'fx': this.onFx(e); break;
        case 'ukemi': {
          const pose = this.tracker.poseAt(e.atMs);
          if (pose) {
            const u = this.anchorOf(pose.uke);
            this.floatText(`UKEMI ${e.result.toUpperCase()}!`, u.x, u.top - 22, UKEMI_COLOR[e.result], 12);
          }
          break;
        }
        case 'end': this.onEnd(e); break;
        default: break;
      }
    }
  }

  private onEnter(e: Ev<'enter'>): void {
    if (e.kind === 'phase') {
      const p = TECH.phases.find((ph) => ph.id === e.id)!;
      this.phaseText.setText(p.label.ko).setColor('#e4e4e7');
    } else if (e.kind === 'branch') {
      const b = TECH.branches[e.id];
      this.branchLabel = b.label.ko;
      this.phaseText.setText(b.label.ko).setColor('#f87171');
      if (b.result.damage) {
        this.flash(0xef4444, 0.3, 160);
        this.cameras.main.shake(this.real(180), 0.012);
        const pose = this.tracker.poseAt(e.atMs);
        if (pose) {
          const n = this.anchorOf(pose.nage);
          this.floatText(`-${b.result.damage} HP`, n.x + 18, n.top - 4, 0xef4444, 10);
        }
      }
    } else {
      const u = TECH.ukemi!.results[e.id as UkemiGrade];
      this.phaseText.setText(u.label.ko).setColor(hex(UKEMI_COLOR[e.id as UkemiGrade]));
    }
  }

  private onJudged(e: Ev<'judged'>): void {
    const color = GRADE_COLOR[e.grade];
    const text = e.wrongDirection ? 'WRONG WAY (방향 오류)' : JUDGE_FLOAT[e.grade];
    const beat = e.beats > 1 ? ` ${e.beat + 1}/${e.beats}` : '';
    const pose = this.tracker.poseAt(e.atMs);
    if (pose) {
      const n = this.anchorOf(pose.nage);
      this.floatText(`${text}${beat}`, n.x, n.top - 22, color, e.grade === 'perfect' ? 13 : 11);
    }
    const err = e.offsetMs === null ? '무입력' : fmtMs(e.offsetMs);
    this.lastJudge = { text: `[LAST: ${e.phaseId}${e.beats > 1 ? `#${e.beat + 1}` : ''} ${e.grade.toUpperCase()} ${err}]`, color };
  }

  private onReaction(e: Ev<'reaction'>): void {
    const pose = this.tracker.poseAt(e.atMs);
    if (!pose) return;
    const n = this.anchorOf(pose.nage);
    const u = this.anchorOf(pose.uke);
    const { type, px } = e.reaction;
    const dir = pose.nage.facing * (this.mirror ? -1 : 1);
    if (type === 'whiff') this.fx.push({ kind: 'ghost', x: n.x, y: n.y, start: e.atMs, dur: 220, color: C.toriLight, dir });
    if (type === 'clash') {
      this.fx.push({ kind: 'spark', x: (n.x + u.x) / 2, y: n.chest, start: e.atMs, dur: 220, color: 0xf97316, dir });
      this.cameras.main.shake(this.real(90), 0.006);
    }
    if (type === 'hit') this.flash(0xef4444, 0.25, 120);
    if (px) this.push = { px, start: e.atMs, dur: 240 };
  }

  private onHitstop(ms: number): void {
    // Perfect 임팩트: 엔진 시계는 이미 ms 만큼 정지 → 월드 카메라 셰이크 + 화이트 플래시
    const intensity = 0.008 + Math.max(0, ms - 100) * 0.00008; // 100ms → 0.008, 150ms → 0.012
    this.cameras.main.shake(this.real(ms), intensity);
    this.flash(0xffffff, 0.35, ms);
  }

  private onFx(e: Ev<'fx'>): void {
    const pose = this.tracker.poseAt(e.atMs);
    if (!pose) return;
    const n = this.anchorOf(pose.nage);
    const u = this.anchorOf(pose.uke);
    const dir = pose.nage.facing * (this.mirror ? -1 : 1);
    if (e.anim.endsWith('hit_spark')) this.fx.push({ kind: 'spark', x: u.x, y: u.chest, start: e.atMs, dur: 260, color: 0xfde047, dir });
    else this.fx.push({ kind: 'ring', x: (n.x + u.x) / 2, y: n.chest, start: e.atMs, dur: 420, color: 0x22d3ee, dir });
  }

  private onEnd(e: Ev<'end'>): void {
    const s = e.stats;
    this.hp = Math.max(0, this.hp - s.damage);
    this.mode = 'result';
    const ok = e.result === 'success';
    const head = ok ? `기술 성공 — 낙법 ${e.ukemi?.toUpperCase() ?? ''}` : `실패 — ${this.branchLabel ?? ''}`;
    this.panel = {
      color: ok && e.ukemi ? UKEMI_COLOR[e.ukemi] : 0xf87171,
      lines: [
        head,
        '',
        `Perfect ${s.successes}/${s.checks}   Early ${s.grades.early}   Late ${s.grades.late}   Miss ${s.grades.miss}`,
        `SCORE ${s.score}   MUSUBI ${s.musubi}   HP ${this.hp}/${HP_MAX}${this.hp <= 0 ? '  (KO → 다음 라운드 회복)' : ''}`,
        '',
        'Enter / R : 다시   M : 좌우 반전   T : 배속',
      ],
    };
    this.hintText.setText('');
  }

  // ───────────────────────────── effects ─────────────────────────────

  /** 가상시간 ms → 실시간 ms (카메라 효과는 실시간으로 동작) */
  private real(ms: number): number {
    return ms / Math.max(0.05, this.clock.scale);
  }

  private flash(color: number, alpha: number, ms: number): void {
    this.tweens.killTweensOf(this.flashG);
    this.flashG.clear().fillStyle(color, 1).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT).setAlpha(alpha);
    this.tweens.add({ targets: this.flashG, alpha: 0, duration: ms });
  }

  /** 머리 위로 떠오르며 사라지는 텍스트 (위치·투명도는 updateFloats 에서 매 프레임 계산) */
  private floatText(text: string, x: number, y: number, color: number, size = 11): void {
    const labelTop = this.labels ? Math.min(this.toriLabel.y - this.toriLabel.height, this.ukeLabel.y - this.ukeLabel.height) - 2 : y;
    const t = this.add.text(x, y, text, {
      fontFamily: FONT_FAMILY, fontSize: `${size}px`, fontStyle: 'bold', color: hex(color), stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5, 1);
    this.worldLayer.add(t);
    this.floats.unshift({ t, x, y: Math.max(172, Math.min(y, labelTop)), born: this.vNow() });
  }

  private updateFloats(now: number): void {
    const LIFE = 1100;
    this.floats = this.floats.filter((f) => {
      const age = now - f.born;
      if (age < LIFE) return true;
      f.t.destroy();
      return false;
    });
    this.floats.forEach((f, i) => {
      const age = now - f.born;
      const k = Math.min(1, age / LIFE);
      const rise = (1 - (1 - k) ** 3) * 22;
      f.t.setPosition(f.x, Math.round(f.y - rise - i * 14))
        .setScale(age < 120 ? 1.3 - (age / 120) * 0.3 : 1)
        .setAlpha(age > 650 ? 1 - (age - 650) / (LIFE - 650) : 1);
    });
  }

  // ───────────────────────────── render ─────────────────────────────

  private idlePose(now: number): Pose {
    const elapsed = this.mode === 'approach' ? now - this.approach.start : 0;
    const q = this.snappy ? Math.floor(elapsed / SNAP_MS) * SNAP_MS : elapsed;
    const ukeX = this.mode === 'ready' ? APPROACH_FROM : Math.max(MAAI_X, APPROACH_FROM - q * this.approach.speed);
    const idle = (anim: 'common.nage.kamae' | 'common.uke.kamae', x: number, facing: 1 | -1): ActorPose => ({
      x, y: 0, facing, depth: 10, anim, frame: frameAt(ANIMS[anim], q), offX: 0, offY: 0,
    });
    return { nage: idle('common.nage.kamae', 0, 1), uke: idle('common.uke.kamae', ukeX, -1) };
  }

  /** 기술 공간 포즈 → 화면 앵커. 프레임 오프셋(+x = 바라보는 방향)과 밀려남은 그리는 기준점에만 적용 */
  private anchorOf(p: ActorPose, pushPx = 0): Anchor {
    const sign = this.mirror ? -1 : 1;
    const rootX = Math.round(this.originX() + sign * p.x);
    const rootY = Math.round(FLOOR_Y + p.y);
    const x = Math.round(this.originX() + sign * (p.x + p.offX * p.facing + pushPx));
    const y = Math.round(FLOOR_Y + p.y + p.offY);
    const h = isLying(p) ? 12 : BODY_H;
    return { rootX, rootY, x, y, top: y - h - 10, chest: y - Math.round(h * 0.6) };
  }

  /** 1px 십자선 (+) */
  private crosshair(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, color: number): void {
    g.fillStyle(0x000000, 0.8).fillRect(x - r - 1, y - 1, r * 2 + 3, 3).fillRect(x - 1, y - r - 1, 3, r * 2 + 3);
    g.fillStyle(color, 1).fillRect(x - r, y, r * 2 + 1, 1).fillRect(x, y - r, 1, r * 2 + 1);
  }

  private drawActor(p: ActorPose, body: number, light: number, hitstop: boolean, pushPx: number): Anchor {
    const g = this.world;
    const a = this.anchorOf(p, pushPx);
    const fw = p.facing * (this.mirror ? -1 : 1);
    g.fillStyle(0x000000, 0.35).fillEllipse(a.rootX, FLOOR_Y + 1, 24, 4);

    if (isLying(p)) {
      g.fillStyle(body).fillRect(a.x - 20, a.y - 12, 40, 12);
      g.fillStyle(light).fillRect(fw > 0 ? a.x - 30 : a.x + 20, a.y - 11, 10, 9);
      if (hitstop) g.lineStyle(1, 0xffffff, 1).strokeRect(a.x - 30.5, a.y - 12.5, 61, 13);
    } else {
      const bx = a.x - BODY_W / 2;
      const by = a.y - BODY_H;
      g.fillStyle(body).fillRect(bx, by, BODY_W, BODY_H);
      g.fillStyle(light).fillRect(a.x - 5, by - 10, 10, 9);
      const arm = armPose(p);
      if (arm === 'up') g.fillRect(a.x + fw * 4 - 2, by - 22, 4, 14);
      else if (arm === 'strike') g.fillRect(fw > 0 ? a.x + 8 : a.x - 26, by + 4, 18, 4);
      else g.fillRect(fw > 0 ? a.x + 8 : a.x - 14, by + 10, 6, 4);
      if (hitstop) g.lineStyle(1, 0xffffff, 1).strokeRect(bx - 0.5, by - 10.5, BODY_W + 1, BODY_H + 11);
    }
    return a;
  }

  /** Origin Point 십자선 + 프레임 오프셋 Δ (디버그 레이어: 캐릭터 위에 그림) */
  private drawOrigin(a: Anchor, tint: number): void {
    const g = this.debugG;
    const shifted = a.x !== a.rootX || a.y !== a.rootY;
    if (shifted) {
      g.lineStyle(1, C.offset, 0.9).lineBetween(a.rootX + 0.5, a.rootY + 0.5, a.x + 0.5, a.y + 0.5);
      g.fillStyle(C.offset).fillRect(a.x - 2, a.y - 2, 1, 1).fillRect(a.x + 2, a.y - 2, 1, 1)
        .fillRect(a.x - 1, a.y - 1, 3, 3).fillRect(a.x - 2, a.y + 2, 1, 1).fillRect(a.x + 2, a.y + 2, 1, 1);
    }
    this.crosshair(g, a.rootX, a.rootY, 6, C.origin);
    g.fillStyle(tint).fillRect(a.rootX - 1, a.rootY - 1, 3, 3);
  }

  /** 두 Origin Point 를 잇는 거리선 + 실시간 px (마아이 범위: 초록=진입 가능, 노랑=근접, 회색=원거리) */
  private drawDistance(pose: Pose, n: Anchor, u: Anchor): void {
    const g = this.debugG;
    const { minPx, maxPx } = TECH.requires.maai;
    const dx = pose.uke.x - pose.nage.x;
    const dy = pose.uke.y - pose.nage.y;
    const d = Math.abs(dx);
    const color = d < minPx ? 0xfacc15 : d <= maxPx ? 0x22c55e : 0x94a3b8;
    const ly = Math.min(n.rootY, u.rootY) - 20; // 발 기준점 20px 위에 평행 치수선
    g.lineStyle(1, color, 0.5).lineBetween(n.rootX + 0.5, n.rootY - 6, n.rootX + 0.5, ly).lineBetween(u.rootX + 0.5, u.rootY - 6, u.rootX + 0.5, ly);
    g.lineStyle(1, color, 1).lineBetween(n.rootX + 0.5, ly + 0.5, u.rootX + 0.5, ly + 0.5);
    g.lineStyle(1, C.dist, 0.55).lineBetween(n.rootX + 0.5, n.rootY + 0.5, u.rootX + 0.5, u.rootY + 0.5);
    const tag = d < minPx ? ' 근접' : d <= maxPx ? ' 마아이' : '';
    this.distText
      .setPosition((n.rootX + u.rootX) / 2, ly - 1)
      .setColor(hex(color))
      .setText(`${Math.round(d)}px${dy ? ` Δy${signed(dy)}` : ''}${tag}`);
  }

  private render(now: number): void {
    const g = this.world;
    g.clear();
    this.debugG.clear();
    g.fillStyle(C.mat).fillRect(0, FLOOR_Y + 1, GAME_WIDTH, 3);
    g.fillStyle(C.floor).fillRect(0, FLOOR_Y, GAME_WIDTH, 1);

    const inTech = this.mode === 'technique' || this.mode === 'result';
    const local = this.state?.nowMs ?? 0;
    const pose = (inTech && this.tracker.poseAt(local, this.snappy ? SNAP_MS : 0)) || this.idlePose(now);
    const hs = this.state?.hitstop ?? false;

    let pushPx = 0;
    if (this.push && inTech) {
      const k = (local - this.push.start) / this.push.dur;
      if (k >= 1) this.push = null;
      else pushPx = -this.push.px * (1 - Math.max(0, k)) * pose.nage.facing;
    }

    this.drawMaaiBand(pose, inTech);
    const drawOrder = (pose.nage.depth <= pose.uke.depth ? ['nage', 'uke'] : ['uke', 'nage']) as ('nage' | 'uke')[];
    const anchors = {} as Record<'nage' | 'uke', Anchor>;
    for (const who of drawOrder) {
      anchors[who] = who === 'nage'
        ? this.drawActor(pose.nage, C.tori, C.toriLight, hs, pushPx)
        : this.drawActor(pose.uke, C.uke, C.ukeLight, hs, 0);
    }
    this.drawOrigin(anchors.nage, C.tori);
    this.drawOrigin(anchors.uke, C.uke);
    this.drawDistance(pose, anchors.nage, anchors.uke);

    const label = (t: Phaser.GameObjects.Text, name: string, p: ActorPose, a: Anchor, lift: number) => {
      const off = p.offX || p.offY || (name === 'TORI' && pushPx) ? `  Δ(${signed(p.offX + (name === 'TORI' ? pushPx * p.facing : 0))},${signed(p.offY)})` : '';
      t.setVisible(this.labels).setPosition(a.x, a.top - 2 - lift)
        .setText(`${name} ${shortAnim(p.anim)}[${p.frame}]\n(${Math.round(p.x)},${Math.round(p.y)})${off}`);
    };
    label(this.toriLabel, 'TORI', pose.nage, anchors.nage, 0);
    const close = Math.abs(anchors.nage.x - anchors.uke.x) < 110;
    label(this.ukeLabel, 'UKE', pose.uke, anchors.uke, close ? Math.max(0, anchors.uke.top - anchors.nage.top) + 22 : 0);

    this.drawFx(inTech ? local : 0);
    this.updateFloats(now);
    this.drawUi();
    this.timeline.draw(inTech ? this.state : null);
  }

  /** 접근 중 · 마아이 페이즈: 바닥에 진입 가능 범위(min~max)와 이상 거리 표시 */
  private drawMaaiBand(pose: Pose, inTech: boolean): void {
    const show = this.mode === 'ready' || this.mode === 'approach' || (inTech && this.state?.id === 'maai');
    if (!show) return;
    const g = this.world;
    const sign = this.mirror ? -1 : 1;
    const { minPx, idealPx, maxPx } = TECH.requires.maai;
    const nx = this.originX() + sign * pose.nage.x;
    const d = Math.abs(pose.uke.x - pose.nage.x);
    const ok = d >= minPx && d <= maxPx;
    const a = nx + sign * minPx;
    const b = nx + sign * maxPx;
    g.fillStyle(0x22c55e, ok ? 0.35 : 0.15).fillRect(Math.min(a, b), FLOOR_Y - 2, Math.abs(b - a), 2);
    g.fillStyle(0x22c55e, 0.7).fillRect(nx + sign * idealPx, FLOOR_Y - 5, 1, 5);
  }

  private drawFx(t: number): void {
    const g = this.fxG;
    g.clear();
    this.fx = this.fx.filter((f) => t - f.start < f.dur);
    for (const f of this.fx) {
      const k = Phaser.Math.Clamp((t - f.start) / f.dur, 0, 1);
      if (f.kind === 'ring') {
        g.lineStyle(2, f.color, 1 - k).strokeCircle(f.x, f.y, 6 + k * 30);
      } else if (f.kind === 'spark') {
        g.lineStyle(2, f.color, 1 - k);
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2;
          const r1 = 3 + k * 10;
          const r2 = 8 + k * 20;
          g.lineBetween(f.x + Math.cos(ang) * r1, f.y + Math.sin(ang) * r1, f.x + Math.cos(ang) * r2, f.y + Math.sin(ang) * r2);
        }
      } else {
        g.fillStyle(f.color, 0.45 * (1 - k)).fillRect(f.x - 8 + f.dir * (6 + k * 14), f.y - BODY_H, BODY_W, BODY_H);
      }
    }
  }

  // ───────────────────────────── UI ─────────────────────────────

  private stateLine(): OverlayLine {
    const st = this.state;
    switch (this.mode) {
      case 'ready': return { text: '[STATE: Ready — Space 로 시작]', color: 0xa1a1aa };
      case 'approach': return { text: '[STATE: Approach — 우케 접근 중]', color: 0xa1a1aa };
      case 'result': return { text: `[STATE: Result — ${(st?.ended ?? '').toUpperCase()}]`, color: st?.ended === 'success' ? 0x22c55e : 0xef4444 };
      default: break;
    }
    if (!st?.kind) return { text: '[STATE: —]' };
    const hs = st.hitstop ? ' · HITSTOP' : '';
    if (st.kind === 'branch') return { text: `[STATE: Branch ${st.id}${hs}]`, color: 0xef4444 };
    if (st.kind === 'ukemi') return { text: `[STATE: Phase 3 Ukemi (${st.id})${hs}]`, color: UKEMI_COLOR[st.id as UkemiGrade] };
    const b = st.beat;
    const sub = !b || b.count === 0 ? 'Observing'
      : b.resolved ? 'Judged → Next'
      : b.holding ? 'Holding'
      : b.windowOpen ? 'Window Open'
      : 'Waiting';
    const color = sub === 'Window Open' || sub === 'Holding' ? 0x22c55e : sub === 'Judged → Next' ? 0x22d3ee : 0xfafafa;
    return { text: `[STATE: Phase ${STAGE_NUM[st.stage as Stage]} ${sub}${hs}]`, color: st.hitstop ? 0xffffff : color };
  }

  private drawUi(): void {
    const st = this.state;
    const s = st?.stats;
    const hp = this.hpNow();
    const phase = st?.kind === 'phase' ? TECH.phases.find((p) => p.id === st.id) : undefined;
    const b = st?.beat;
    const beat = b && b.count ? `${Math.min(b.index + 1, b.count)}/${b.count}` : '—';
    const t = st?.kind ? `${Math.round(st.seqMs)} / ${st.durationMs}ms  F${Math.floor(st.seqMs / FRAME_MS)}` : '—';
    const pose = this.tracker.active && st ? this.tracker.poseAt(st.nowMs) : null;
    const dist = pose ? Math.abs(pose.uke.x - pose.nage.x) : this.mode === 'approach' || this.mode === 'ready' ? Math.abs(this.idlePose(this.vNow()).uke.x) : 0;
    const { minPx, idealPx, maxPx } = TECH.requires.maai;

    this.overlay.draw([
      this.stateLine(),
      { text: `[ACTION: ${ACTION_NAME}${st?.id ? ` › ${st.id}` : ''}]` },
      { text: `[HP: ${hp} / ${HP_MAX}]  [MUSUBI: ${s?.musubi ?? 50}]  [SCORE: ${s?.score ?? 0}]`, color: hp <= 30 ? 0xef4444 : 0xe4e4e7 },
      { text: `[BEAT: ${beat}]  [T: ${t}]` },
      { text: `[MAAI: ${Math.round(dist)}px · ideal ${idealPx} (${minPx}~${maxPx})]`, color: dist >= minPx && dist <= maxPx ? 0x22c55e : 0xa1a1aa },
      this.lastJudge,
      { text: `[ROUND ${this.round}]  [INPUT: ${phase ? this.inputLabel(phase) : '—'}]`, color: 0x71717a },
    ]);

    this.hudRight.setText(`x${SPEEDS[this.speedIdx]}  ${this.mirror ? 'MIRROR' : 'NORMAL'}  ${this.snappy ? 'SNAP 10fps' : 'SMOOTH'}`);
    if (this.mode === 'technique' && phase) this.hintText.setText(this.hintFor(phase, st!.nageFacing));
    else if (this.mode === 'technique') this.hintText.setText('');

    const g = this.uiG;
    g.clear();
    this.panelText.setVisible(!!this.panel);
    this.phaseText.setVisible(!this.panel);
    this.hintText.setVisible(!this.panel);
    if (this.panel) {
      g.fillStyle(0x09090b, 0.9).fillRect(GAME_WIDTH / 2 - 215, 142, 430, 108);
      g.lineStyle(1, 0x3f3f46, 1).strokeRect(GAME_WIDTH / 2 - 214.5, 142.5, 429, 107);
      this.panelText.setText(this.panel.lines.join('\n')).setColor(hex(this.panel.color));
    }
  }

  private inputLabel(p: Phase): string {
    const i = p.input;
    if (i.type === 'none') return 'none';
    if (i.type === 'sequence') return `sequence ×${i.beats.length}`;
    return i.type;
  }

  private hintFor(p: Phase, facing: 1 | -1): string {
    const beats = beatsOf(p.input);
    if (!beats.length) return p.id === 'maai' ? '공격을 읽어라 — 정면타 예비동작' : '';
    const key = (b: Beat) => (b.button === 'ACTION' ? 'Space' : 'X');
    const one = (b: Beat) =>
      b.type === 'direction_press' ? `${this.arrow(b.direction!, facing)} + ${key(b)}`
      : b.type === 'hold_release' ? `${key(b)} 누르고 … 떼기`
      : key(b);
    const cue = beats[0].sync ? `   (${beats[0].sync.actor}:${beats[0].sync.event})` : '';
    return p.input.type === 'sequence' ? `${one(beats[0])} ×${beats.length}  (리듬에 맞춰)` : `${one(beats[0])}${cue}`;
  }

  private arrow(dir: Direction, facing: 1 | -1): string {
    if (dir === 'UP') return '↑';
    if (dir === 'DOWN') return '↓';
    const world = (dir === 'FORWARD' ? facing : -facing) * (this.mirror ? -1 : 1);
    return world > 0 ? '→' : '←';
  }
}
