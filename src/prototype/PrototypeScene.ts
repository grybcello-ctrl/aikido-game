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
  AnimationDef, AnimationRegistry, Beat, Direction, Grade, Phase, TechniqueData, UkemiGrade,
} from '../types/technique';
import { GRADE_COLOR, TimingDebugger, fmtMs, hex } from './TimingDebugger';

type Ev<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;
type Mode = 'ready' | 'approach' | 'technique' | 'result';

const TECH = techJson as unknown as TechniqueData;
const ANIMS: Record<string, AnimationDef> = {
  ...(commonJson as unknown as AnimationRegistry).animations,
  ...TECH.animations.exclusive,
};

const C = {
  bg: 0x18181b, floor: 0x52525b, mat: 0x27272a,
  nage: 0x3b82f6, nageLight: 0x93c5fd,
  uke: 0xef4444, ukeLight: 0xfca5a5,
};
const UKEMI_COLOR: Record<UkemiGrade, number> = { perfect: 0x22c55e, sloppy: 0xfacc15, crash: 0xef4444 };
const GRADE_TEXT: Record<Grade, string> = { perfect: 'PERFECT', early: 'EARLY', late: 'LATE', miss: 'MISS' };
const REACTION_TEXT = { whiff: '헛스윙!', hit: '피격!', clash: '충돌!', pushback: '밀려남' } as const;
const SPEEDS = [1, 0.5, 0.25];
const BODY_W = 16;
const BODY_H = 40;
/** 우케 접근 시작 거리(기술 공간 px). 첫 페이즈 uke x(마아이)에 도달하면 엔진 시작 */
const APPROACH_FROM = 260;
const SNAP_MS = 1000 / ANIM_FPS.DEFAULT;
const MAAI_X = TECH.phases[0].tracks.uke[0].x ?? 80;

interface Fx { kind: 'ring' | 'spark' | 'ghost'; x: number; y: number; start: number; dur: number; color: number; dir: number }
interface Anchor { x: number; top: number; chest: number }

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
const bodyPose = (p: ActorPose): 'stand' | 'lying' => {
  if (/(ukemi_back|ukemi_sloppy|crash|down)$/.test(p.anim) && p.frame >= 2) return 'lying';
  if (/thrown$/.test(p.anim) && p.frame >= 3) return 'lying';
  return 'stand';
};
const armPose = (p: ActorPose): 'rest' | 'up' | 'strike' => {
  if (/windup$/.test(p.anim)) return p.frame >= 1 ? 'up' : 'rest';
  if (/shomenuchi_strike$/.test(p.anim)) return p.frame <= 1 ? 'up' : 'strike';
  if (/(irimi_awase|throw_cut|lead_shoulder|whiff_hit)$/.test(p.anim) && p.frame >= 1) return 'strike';
  return 'rest';
};
const shortAnim = (key: string) => key.split('.').pop() ?? key;

/**
 * 더미 프로토타입 씬
 * ready → approach(우케가 다가옴) → technique(TimingEngine) → result
 * - 파랑 사각형 = nage(플레이어), 빨강 사각형 = uke
 * - Perfect: 데이터의 hitstopMs(100~150ms) 동안 엔진 시계 정지 + 월드 카메라 셰이크 + 플래시
 * - 하단: TimingDebugger (구간 막대 + 입력 마커 + ms 오차)
 */
export class PrototypeScene extends Phaser.Scene {
  private clock!: GameClock;
  private engine: TimingEngine | null = null;
  private tracker!: PoseTracker;
  private dbg!: TimingDebugger;
  private state: EngineState | null = null;

  private mode: Mode = 'ready';
  private mirror = false;
  private snappy = true;
  private labels = true;
  private speedIdx = 0;
  private round = 0;
  private approach = { start: 0, speed: 0.15 };
  private fx: Fx[] = [];
  private push: { px: number; start: number; dur: number } | null = null;
  private branchLabel: string | null = null;

  private worldLayer!: Phaser.GameObjects.Layer;
  private uiLayer!: Phaser.GameObjects.Layer;
  private world!: Phaser.GameObjects.Graphics;
  private fxG!: Phaser.GameObjects.Graphics;
  private hudG!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Rectangle;
  private popup!: Phaser.GameObjects.Text;
  private nageLabel!: Phaser.GameObjects.Text;
  private ukeLabel!: Phaser.GameObjects.Text;
  private maaiText!: Phaser.GameObjects.Text;
  private hudLeft!: Phaser.GameObjects.Text;
  private hudRight!: Phaser.GameObjects.Text;
  private stageTexts: Phaser.GameObjects.Text[] = [];
  private phaseText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private panel!: Phaser.GameObjects.Rectangle;
  private centerText!: Phaser.GameObjects.Text;

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

    const font = (size: number, color = '#e4e4e7') => ({ fontFamily: 'monospace', fontSize: `${size}px`, color });

    this.world = this.add.graphics();
    this.fxG = this.add.graphics();
    this.nageLabel = this.add.text(0, 0, '', font(8, '#93c5fd')).setOrigin(0.5, 1);
    this.ukeLabel = this.add.text(0, 0, '', font(8, '#fca5a5')).setOrigin(0.5, 1);
    this.maaiText = this.add.text(0, 0, '', font(9)).setOrigin(0.5, 1);
    this.popup = this.add.text(GAME_WIDTH / 2, 118, '', {
      ...font(22), fontStyle: 'bold', align: 'center', stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setAlpha(0);
    this.worldLayer.add([this.world, this.fxG, this.nageLabel, this.ukeLabel, this.maaiText, this.popup]);

    this.hudG = this.add.graphics();
    this.hudLeft = this.add.text(8, 6, '', font(10));
    this.hudRight = this.add.text(GAME_WIDTH - 8, 6, '', font(9, '#a1a1aa')).setOrigin(1, 0);
    const help = this.add.text(GAME_WIDTH - 8, 19, 'Z 입력 · ←→ 방향 · R 재시작 · M 반전 · T 배속 · Q 스냅 · D 라벨', font(8, '#71717a')).setOrigin(1, 0);
    this.stageTexts = ['① 인지', '② 진입', '③ 던지기'].map((s, i) =>
      this.add.text(GAME_WIDTH / 2 + (i - 1) * 64, 34, s, font(10, '#52525b')).setOrigin(0.5, 0));
    this.phaseText = this.add.text(GAME_WIDTH / 2, 50, '', font(12)).setOrigin(0.5, 0);
    this.hintText = this.add.text(GAME_WIDTH / 2, 66, '', font(10, '#a1a1aa')).setOrigin(0.5, 0);
    this.panel = this.add.rectangle(GAME_WIDTH / 2, 160, 420, 118, 0x09090b, 0.88).setStrokeStyle(1, 0x3f3f46);
    this.centerText = this.add.text(GAME_WIDTH / 2, 160, '', { ...font(11), align: 'center', lineSpacing: 4 }).setOrigin(0.5);
    this.overlay = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0xffffff, 1).setOrigin(0).setAlpha(0);
    this.uiLayer.add([this.hudG, this.hudLeft, this.hudRight, help, ...this.stageTexts, this.phaseText, this.hintText, this.panel, this.centerText, this.overlay]);

    this.dbg = new TimingDebugger(this, TECH, this.uiLayer);
    this.tracker = new PoseTracker(TECH, ANIMS, ease);

    // 기술 입력 → 엔진 (technique 모드에서만). 이벤트 타임스탬프를 가상시간으로 변환
    bindKeyboard(this, () => (this.mode === 'technique' ? this.engine : null), (t) => this.clock.toVirtual(t));

    const kb = this.input.keyboard!;
    kb.on('keydown-ENTER', () => { if (this.mode === 'ready' || this.mode === 'result') this.startRound(); });
    kb.on('keydown-Z', () => { if (this.mode === 'ready') this.startRound(); });
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
    return { mode: this.mode, round: this.round, mirror: this.mirror, speed: SPEEDS[this.speedIdx], state: this.state };
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

  private showReady(): void {
    this.mode = 'ready';
    this.panel.setVisible(true);
    this.centerText.setVisible(true).setColor('#e4e4e7').setText([
      '合気 TIMING PROTOTYPE',
      `${TECH.name.ko}`,
      '',
      'Enter / Z : 시작',
      'Z : 기술 입력   ← → : 방향 (텐칸 = 뒤쪽 + Z)',
      'R 재시작 · M 좌우반전 · T 배속 · Q 스냅 · D 라벨',
    ].join('\n'));
    this.phaseText.setText('');
    this.hintText.setText('');
  }

  private startRound(): void {
    this.round++;
    this.engine = new TimingEngine(TECH, { mirror: this.mirror });
    this.tracker.reset();
    this.dbg.reset();
    this.state = null;
    this.fx = [];
    this.push = null;
    this.branchLabel = null;
    this.mode = 'approach';
    this.approach = { start: this.vNow(), speed: Phaser.Math.FloatBetween(0.09, 0.2) };
    this.panel.setVisible(false);
    this.centerText.setVisible(false);
    this.tweens.killTweensOf(this.popup);
    this.popup.setAlpha(0);
    this.phaseText.setText('우케 접근 중 — 마아이를 읽어라').setColor('#a1a1aa');
    this.hintText.setText('');
  }

  // ───────────────────────────── engine events ─────────────────────────────

  private handle(events: EngineEvent[]): void {
    for (const e of events) {
      this.tracker.onEvent(e);
      this.dbg.onEvent(e);
      switch (e.type) {
        case 'enter': this.onEnter(e); break;
        case 'judged': this.onJudged(e); break;
        case 'reaction': this.onReaction(e); break;
        case 'hitstop': this.onHitstop(e.durationMs); break;
        case 'fx': this.onFx(e); break;
        case 'ukemi':
          this.showPopup(`受け身 ${e.result.toUpperCase()}`, UKEMI_COLOR[e.result], `Perfect ${e.successes}/${e.checks}`);
          break;
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
      }
    } else {
      const u = TECH.ukemi!.results[e.id as UkemiGrade];
      this.phaseText.setText(u.label.ko).setColor(hex(UKEMI_COLOR[e.id as UkemiGrade]));
    }
  }

  private onJudged(e: Ev<'judged'>): void {
    const title = GRADE_TEXT[e.grade] + (e.beats > 1 ? ` ${e.beat + 1}/${e.beats}` : '');
    const sub = e.wrongDirection ? '방향 틀림' : e.offsetMs === null ? '무입력' : fmtMs(e.offsetMs);
    this.showPopup(title, GRADE_COLOR[e.grade], sub);
  }

  private onReaction(e: Ev<'reaction'>): void {
    const pose = this.tracker.poseAt(e.atMs);
    if (!pose) return;
    const n = this.anchorOf(pose.nage);
    const u = this.anchorOf(pose.uke);
    const { type, px } = e.reaction;
    this.floatText(`${REACTION_TEXT[type]}${px ? ` ${px}px` : ''}`, n.x, n.top - 14, type === 'whiff' ? 0xfacc15 : 0xf97316);
    const dir = pose.nage.facing * (this.mirror ? -1 : 1);
    if (type === 'whiff') this.fx.push({ kind: 'ghost', x: n.x, y: n.top, start: e.atMs, dur: 220, color: C.nageLight, dir });
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
    this.mode = 'result';
    const s = e.stats;
    const ok = e.result === 'success';
    const head = ok ? `기술 성공 — 낙법 ${e.ukemi?.toUpperCase() ?? ''}` : `실패 — ${this.branchLabel ?? ''}`;
    this.panel.setVisible(true);
    this.centerText.setVisible(true)
      .setColor(ok && e.ukemi ? hex(UKEMI_COLOR[e.ukemi]) : '#f87171')
      .setText([
        head,
        '',
        `Perfect ${s.successes}/${s.checks}   Early ${s.grades.early}   Late ${s.grades.late}   Miss ${s.grades.miss}`,
        `SCORE ${s.score}   MUSUBI ${s.musubi}   DMG ${s.damage}   최대 연속 ${s.maxStreak}`,
        '',
        'Enter / R : 다시   M : 좌우 반전   T : 배속',
      ].join('\n'));
    this.hintText.setText('');
  }

  // ───────────────────────────── effects ─────────────────────────────

  /** 가상시간 ms → 실시간 ms (카메라 효과는 실시간으로 동작) */
  private real(ms: number): number {
    return ms / Math.max(0.05, this.clock.scale);
  }

  private flash(color: number, alpha: number, ms: number): void {
    this.tweens.killTweensOf(this.overlay);
    this.overlay.setFillStyle(color, 1).setAlpha(alpha);
    this.tweens.add({ targets: this.overlay, alpha: 0, duration: ms });
  }

  private showPopup(text: string, color: number, sub = ''): void {
    this.tweens.killTweensOf(this.popup);
    this.popup.setText(sub ? `${text}\n${sub}` : text).setColor(hex(color)).setAlpha(1).setScale(1.5);
    this.tweens.add({ targets: this.popup, scale: 1, duration: 120, ease: 'Back.easeOut' });
    this.tweens.add({ targets: this.popup, alpha: 0, delay: 650, duration: 250 });
  }

  private floatText(text: string, x: number, y: number, color: number): void {
    const t = this.add.text(x, y, text, {
      fontFamily: 'monospace', fontSize: '10px', color: hex(color), stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5, 1);
    this.worldLayer.add(t);
    this.tweens.add({ targets: t, y: y - 14, alpha: 0, duration: 650, onComplete: () => t.destroy() });
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

  private anchorOf(p: ActorPose, pushPx = 0): Anchor {
    const sign = this.mirror ? -1 : 1;
    const x = Math.round(this.originX() + sign * (p.x + p.offX * p.facing + pushPx));
    const feet = Math.round(FLOOR_Y + p.y);
    const h = bodyPose(p) === 'lying' ? 12 : BODY_H - Phaser.Math.Clamp(p.offY * 2, 0, 16);
    return { x, top: feet - h - 10, chest: feet - Math.round(h * 0.65) };
  }

  private drawActor(p: ActorPose, body: number, light: number, hitstop: boolean, pushPx: number): Anchor {
    const g = this.world;
    const a = this.anchorOf(p, pushPx);
    const feet = Math.round(FLOOR_Y + p.y);
    const fw = p.facing * (this.mirror ? -1 : 1);
    g.fillStyle(0x000000, 0.35).fillEllipse(a.x, FLOOR_Y + 1, 24, 4);

    if (bodyPose(p) === 'lying') {
      g.fillStyle(body).fillRect(a.x - 20, feet - 12, 40, 12);
      g.fillStyle(light).fillRect(fw > 0 ? a.x - 30 : a.x + 20, feet - 11, 10, 9);
      if (hitstop) g.lineStyle(1, 0xffffff, 1).strokeRect(a.x - 31, feet - 13, 62, 14);
      return a;
    }
    const h = feet - a.top - 10; // anchorOf 와 동일한 몸 높이(웅크림 반영)
    const bx = a.x - BODY_W / 2;
    const by = feet - h;
    g.fillStyle(body).fillRect(bx, by, BODY_W, h);
    g.fillStyle(light).fillRect(a.x - 5, by - 10, 10, 9);
    const arm = armPose(p);
    if (arm === 'up') g.fillRect(a.x + fw * 4 - 2, by - 22, 4, 14);
    else if (arm === 'strike') g.fillRect(fw > 0 ? a.x + 8 : a.x - 26, by + 4, 18, 4);
    else g.fillRect(fw > 0 ? a.x + 8 : a.x - 14, by + 10, 6, 4);
    if (hitstop) g.lineStyle(1, 0xffffff, 1).strokeRect(bx - 1, by - 11, BODY_W + 2, h + 12);
    return a;
  }

  private render(now: number): void {
    const g = this.world;
    g.clear();
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

    this.drawMaai(pose, inTech);
    const order = (pose.nage.depth <= pose.uke.depth ? ['nage', 'uke'] : ['uke', 'nage']) as ('nage' | 'uke')[];
    const anchors = {} as Record<'nage' | 'uke', Anchor>;
    for (const who of order) {
      anchors[who] = who === 'nage'
        ? this.drawActor(pose.nage, C.nage, C.nageLight, hs, pushPx)
        : this.drawActor(pose.uke, C.uke, C.ukeLight, hs, 0);
    }
    const label = (t: Phaser.GameObjects.Text, p: ActorPose, a: Anchor) =>
      t.setVisible(this.labels).setPosition(a.x, a.top - 2).setText(`${shortAnim(p.anim)}[${p.frame}]`);
    label(this.nageLabel, pose.nage, anchors.nage);
    label(this.ukeLabel, pose.uke, anchors.uke);

    this.drawFx(inTech ? local : 0);
    this.drawHud();
    this.dbg.draw(inTech ? this.state : null);
  }

  /** 마아이 자: 접근 중 · 마아이 페이즈에서 거리와 진입 가능 범위 표시 */
  private drawMaai(pose: Pose, inTech: boolean): void {
    const show = this.mode === 'ready' || this.mode === 'approach' || (inTech && this.state?.id === 'maai');
    this.maaiText.setVisible(show);
    if (!show) return;
    const g = this.world;
    const sign = this.mirror ? -1 : 1;
    const { minPx, idealPx, maxPx } = TECH.requires.maai;
    const nx = this.originX() + sign * pose.nage.x;
    const ux = this.originX() + sign * pose.uke.x;
    const d = Math.abs(pose.uke.x - pose.nage.x);
    const ok = d >= minPx && d <= maxPx;
    const bandA = nx + sign * minPx;
    const bandB = nx + sign * maxPx;
    g.fillStyle(0x22c55e, ok ? 0.28 : 0.12).fillRect(Math.min(bandA, bandB), FLOOR_Y - 2, Math.abs(bandB - bandA), 2);
    g.fillStyle(0x22c55e, 0.6).fillRect(nx + sign * idealPx, FLOOR_Y - 4, 1, 4);
    const y = FLOOR_Y - 62;
    const col = ok ? 0x22c55e : 0x71717a;
    g.fillStyle(col).fillRect(Math.min(nx, ux), y, Math.abs(ux - nx), 1);
    g.fillRect(nx, y - 3, 1, 7).fillRect(ux, y - 3, 1, 7);
    this.maaiText.setPosition((nx + ux) / 2, y - 2).setColor(hex(col)).setText(`間合い ${Math.round(d)}px${ok ? ' ✓' : ''}`);
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
        g.fillStyle(f.color, 0.45 * (1 - k)).fillRect(f.x - 8 + f.dir * (6 + k * 14), f.y + 10, BODY_W, BODY_H);
      }
    }
  }

  private drawHud(): void {
    const s = this.state?.stats;
    this.hudLeft.setText(`ROUND ${this.round}   SCORE ${s?.score ?? 0}   DMG ${s?.damage ?? 0}`);
    this.hudRight.setText(`x${SPEEDS[this.speedIdx]}  ${this.mirror ? 'MIRROR' : 'NORMAL'}  ${this.snappy ? 'SNAP 10fps' : 'SMOOTH'}`);

    const g = this.hudG;
    g.clear();
    const musubi = s?.musubi ?? 50;
    g.fillStyle(0x27272a).fillRect(8, 22, 110, 6);
    g.fillStyle(0x22d3ee).fillRect(8, 22, Math.round(1.1 * musubi), 6);
    g.fillStyle(0x52525b).fillRect(8 + 55, 21, 1, 8);

    const stage = this.mode === 'technique' || this.mode === 'result' ? this.state?.stage ?? null : null;
    const order = ['recognition', 'entry', 'throw'];
    this.stageTexts.forEach((t, i) => t.setColor(stage === order[i] ? '#fafafa' : stage && order.indexOf(stage) > i ? '#71717a' : '#3f3f46'));

    const st = this.state;
    if (this.mode === 'technique' && st?.kind === 'phase') {
      const p = TECH.phases.find((ph) => ph.id === st.id)!;
      this.hintText.setText(this.hintFor(p, st.nageFacing));
    } else if (this.mode === 'technique') {
      this.hintText.setText('');
    }
  }

  private hintFor(p: Phase, facing: 1 | -1): string {
    const beats = beatsOf(p.input);
    if (!beats.length) return p.id === 'maai' ? '공격을 읽어라 — 정면타 예비동작' : '';
    const key = (b: Beat) => (b.button === 'ACTION' ? 'Z' : 'X');
    const one = (b: Beat) =>
      b.type === 'direction_press' ? `${this.arrow(b.direction!, facing)} + ${key(b)}`
      : b.type === 'hold_release' ? `${key(b)} 누르고 … 떼기`
      : key(b);
    const cue = beats[0].sync ? `  @ ${beats[0].sync.actor}:${beats[0].sync.event}` : '';
    return p.input.type === 'sequence' ? `${one(beats[0])} ×${beats.length}  (리듬에 맞춰)` : `${one(beats[0])}${cue}`;
  }

  private arrow(dir: Direction, facing: 1 | -1): string {
    if (dir === 'UP') return '↑';
    if (dir === 'DOWN') return '↓';
    const world = (dir === 'FORWARD' ? facing : -facing) * (this.mirror ? -1 : 1);
    return world > 0 ? '→' : '←';
  }
}
