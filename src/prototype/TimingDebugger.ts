import Phaser from 'phaser';
import type { EngineEvent, EngineState } from '../engine/TimingEngine';
import { beatsOf, windowBounds } from '../engine/judge';
import type { Beat, Grade, Phase, Range, TechniqueData } from '../types/technique';
import { FONT_FAMILY } from './fonts';

/** Early = 노랑, Perfect = 초록, Late = 빨강, Miss = 보라 */
export const GRADE_COLOR: Record<Grade, number> = {
  perfect: 0x22c55e,
  early: 0xfacc15,
  late: 0xef4444,
  miss: 0xa855f7,
};
export const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
export const fmtMs = (ms: number): string => `${ms >= 0 ? '+' : ''}${Math.round(ms)}ms`;
/** 프레임 미터 1칸 = 로직 1프레임 (60Hz) */
export const FRAME_MS = 1000 / 60;

const NONE = 0x3f3f46;
const IGNORED = 0x9ca3af;
const MAX_MARKS = 12;
const MAX_LOG = 5;
const font = (size: number, color = '#e4e4e7') => ({ fontFamily: FONT_FAMILY, fontSize: `${size}px`, color });

type Zone = 'early' | 'perfect' | 'late';
interface Mark { ms: number; color: number; label: string; ignored: boolean }

const inRange = (d: number, [a, b]: Range) => d >= a && d < b;
const zoneOf = (beats: Beat[], t: number): { zone: Zone; beat: number } | null => {
  for (let i = 0; i < beats.length; i++) {
    const d = t - beats[i].targetMs;
    const w = beats[i].window;
    if (inRange(d, w.early)) return { zone: 'early', beat: i };
    if (inRange(d, w.perfect)) return { zone: 'perfect', beat: i };
    if (inRange(d, w.late)) return { zone: 'late', beat: i };
  }
  return null;
};

/**
 * 하단 타이밍 타임라인 (격투 게임 프레임 미터 스타일)
 * - 칸 1개 = 16.7ms(60Hz 1프레임). 판정 구간 색: Early 노랑 / Perfect 초록 / Late 빨강. 지나간 칸은 진하게
 * - 칸 아래 얇은 띠 = ms 단위 정확한 구간 경계, 흰 세로선 = targetMs
 * - 입력 순간 ▼ 마커 + "오차: +15ms" 팝업. 구간 밖 입력은 회색 ▼
 */
export class TimingDebugger {
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly title: Phaser.GameObjects.Text;
  private readonly info: Phaser.GameObjects.Text;
  private readonly markTexts: Phaser.GameObjects.Text[] = [];
  private readonly logTexts: Phaser.GameObjects.Text[] = [];

  private phase: Phase | null = null;
  private beats: Beat[] = [];
  private phaseStart = 0;
  /** 페이즈를 떠난 시점(페이즈 기준 ms). 진행 중이면 null */
  private leftAt: number | null = null;
  private marks: Mark[] = [];
  private log: { text: string; color: number }[] = [];
  private readonly barY: number;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly data: TechniqueData,
    private readonly layer: Phaser.GameObjects.Layer,
    private readonly x = 16,
    private readonly y = 303,
    private readonly w = 608,
  ) {
    this.barY = y + 21;
    this.g = scene.add.graphics();
    this.title = scene.add.text(x, y + 2, '', font(9));
    this.info = scene.add.text(x + w, y + 2, '', font(9, '#a1a1aa')).setOrigin(1, 0);
    for (let i = 0; i < MAX_MARKS; i++) this.markTexts.push(scene.add.text(0, 0, '', font(8)).setOrigin(0.5, 0).setVisible(false));
    for (let i = 0; i < MAX_LOG; i++) this.logTexts.push(scene.add.text(0, y + 47, '', font(9)));
    layer.add([this.g, this.title, this.info, ...this.markTexts, ...this.logTexts]);
  }

  reset(): void {
    this.phase = null;
    this.beats = [];
    this.leftAt = null;
    this.marks = [];
    this.log = [];
  }

  onEvent(e: EngineEvent): void {
    switch (e.type) {
      case 'enter':
        if (e.kind === 'phase') {
          this.phase = this.data.phases.find((p) => p.id === e.id) ?? null;
          this.beats = this.phase ? beatsOf(this.phase.input) : [];
          this.phaseStart = e.atMs;
          this.leftAt = null;
          this.marks = [];
        } else if (this.phase && this.leftAt === null) {
          this.leftAt = e.atMs - this.phaseStart; // 분기/낙법으로 넘어가도 마지막 페이즈 막대 유지
        }
        break;
      case 'judged': {
        const b = this.beats[e.beat];
        if (!b) break;
        const color = GRADE_COLOR[e.grade];
        const hasInput = e.offsetMs !== null;
        const ms = hasInput ? b.targetMs + (e.offsetMs as number) : windowBounds(b).close;
        const tag = e.beats > 1 ? `#${e.beat + 1} ` : '';
        const err = hasInput ? fmtMs(e.offsetMs as number) : '무입력';
        this.addMark({ ms, color, label: hasInput ? fmtMs(e.offsetMs as number) : 'MISS', ignored: false });
        this.popup(ms, e.wrongDirection ? `${tag}방향 오류 ${err}` : hasInput ? `${tag}오차: ${err}` : `${tag}MISS (무입력)`, color);
        this.log.push({ text: `${e.phaseId}${e.beats > 1 ? `#${e.beat + 1}` : ''} ${e.grade.toUpperCase()} ${err}`, color });
        if (this.log.length > MAX_LOG) this.log.shift();
        break;
      }
      case 'inputIgnored':
        if (this.phase && e.phaseId === this.phase.id && e.reason !== 'repeat') {
          this.addMark({ ms: e.seqMs, color: IGNORED, label: '', ignored: true });
          this.popup(e.seqMs, e.reason === 'outside_window' ? '판정 구간 밖' : `무시(${e.reason})`, IGNORED);
        }
        break;
      default:
        break;
    }
  }

  private addMark(m: Mark): void {
    this.marks.push(m);
    if (this.marks.length > MAX_MARKS) this.marks.shift();
  }

  private px(ms: number): number {
    const dur = this.phase?.durationMs ?? 1;
    return Math.round(this.x + (Phaser.Math.Clamp(ms, 0, dur) / dur) * this.w);
  }

  /** 입력 순간 마커 위로 떠오르는 오차 팝업 */
  private popup(ms: number, text: string, color: number): void {
    const t = this.scene.add.text(this.px(ms), this.barY - 10, text, {
      ...font(10, hex(color)), fontStyle: 'bold', stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5, 1);
    this.layer.add(t);
    this.scene.tweens.add({ targets: t, y: t.y - 18, duration: 900, ease: 'Cubic.easeOut' });
    this.scene.tweens.add({ targets: t, alpha: 0, delay: 500, duration: 400, onComplete: () => t.destroy() });
  }

  draw(state: EngineState | null): void {
    const { g, x, w, barY } = this;
    g.clear();
    g.fillStyle(0x09090b, 0.94).fillRect(0, this.y - 2, 640, 360 - this.y + 2);
    g.fillStyle(0x27272a).fillRect(0, this.y - 2, 640, 1);

    const p = this.phase;
    if (!p) {
      this.title.setText('TIMING TIMELINE — 우케 접근 대기');
      this.info.setText('칸 = 1프레임(16.7ms)  ■Early ■Perfect ■Late');
      this.markTexts.forEach((t) => t.setVisible(false));
      this.drawLog();
      return;
    }

    const dur = p.durationMs;
    const live = state?.kind === 'phase' && state.id === p.id;
    const cur = live ? (state as EngineState).nowMs - this.phaseStart : this.leftAt;
    const curBeat = live ? (state as EngineState).beat?.index ?? -1 : -1;

    // ── 프레임 미터 칸 ──
    const n = Math.ceil(dur / FRAME_MS);
    const cw = w / n;
    const gap = cw >= 4 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const z = zoneOf(this.beats, (i + 0.5) * FRAME_MS);
      const past = cur !== null && i * FRAME_MS < cur;
      const focus = !z || curBeat < 0 || z.beat === curBeat;
      const alpha = past ? 1 : focus ? 0.45 : 0.2;
      const cx = Math.round(x + i * cw);
      g.fillStyle(z ? GRADE_COLOR[z.zone] : NONE, alpha).fillRect(cx + gap, barY, Math.max(1, Math.round(x + (i + 1) * cw) - cx - gap), 12);
    }
    if (cur !== null) {
      const ci = Math.min(n - 1, Math.floor(cur / FRAME_MS));
      g.lineStyle(1, state?.hitstop && live ? 0xffffff : 0x22d3ee, 1).strokeRect(Math.round(x + ci * cw) + 0.5, barY - 1.5, Math.max(2, Math.round(cw)), 15);
    }

    // ── ms 정밀 띠 + targetMs ──
    g.fillStyle(0x18181b).fillRect(x, barY + 13, w, 2);
    this.beats.forEach((b) => {
      for (const zone of ['early', 'perfect', 'late'] as const) {
        const [a, c] = b.window[zone];
        g.fillStyle(GRADE_COLOR[zone]).fillRect(this.px(b.targetMs + a), barY + 13, Math.max(1, this.px(b.targetMs + c) - this.px(b.targetMs + a)), 2);
      }
      g.fillStyle(0xffffff).fillRect(this.px(b.targetMs), barY - 3, 1, 19);
      if (b.type === 'hold_release' && b.holdStartMaxMs !== undefined)
        g.fillStyle(0x22d3ee, 0.7).fillRect(this.px(0), barY + 5, this.px(b.holdStartMaxMs) - this.px(0), 2);
    });

    // ── 입력 마커 ▼ ──
    this.markTexts.forEach((t) => t.setVisible(false));
    let lastX = -Infinity;
    let row = 0;
    this.marks.forEach((m, i) => {
      const mx = this.px(m.ms);
      const s = m.ignored ? 3 : 4;
      g.fillStyle(m.color).fillTriangle(mx, barY - 1, mx - s, barY - 1 - s * 2, mx + s, barY - 1 - s * 2);
      if (m.ignored) return;
      row = mx - lastX < 40 ? 1 - row : 0; // 가까운 라벨은 줄 바꿈
      this.markTexts[i].setText(m.label).setColor(hex(m.color)).setPosition(mx, barY + 16 + row * 8).setVisible(true);
      lastX = mx;
    });

    // ── 제목 / 현재 구간 정보 ──
    const frame = cur === null ? '—' : String(Math.min(n, Math.floor(cur / FRAME_MS)));
    const kind = p.input.type === 'sequence' ? `연속 ×${this.beats.length}` : p.input.type;
    this.title.setText(`[F ${frame}/${n}]  ${p.id} · ${p.label.ko} · ${kind}`);
    const ib = this.beats[Math.max(0, Math.min(this.beats.length - 1, curBeat))];
    const width = (r: Range) => r[1] - r[0];
    const win = ib
      ? `E ${width(ib.window.early)} · P ${width(ib.window.perfect)} · L ${width(ib.window.late)}ms  @${ib.targetMs}ms`
      : '입력 없음';
    const tail = live ? (state?.hitstop ? '  HITSTOP' : '') : state?.kind ? `  → ${state.kind}:${state.id}` : '';
    this.info.setText(`${win}${tail}`);
    this.drawLog();
  }

  private drawLog(): void {
    let lx = this.x;
    this.logTexts.forEach((t, i) => {
      const entry = this.log[i];
      if (!entry) return t.setVisible(false);
      t.setText(entry.text).setColor(hex(entry.color)).setPosition(lx, this.y + 47).setVisible(true);
      lx += t.width + 12;
    });
  }
}
