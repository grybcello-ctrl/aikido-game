import Phaser from 'phaser';
import type { EngineEvent, EngineState } from '../engine/TimingEngine';
import { beatsOf, windowBounds } from '../engine/judge';
import type { Beat, Grade, Phase, Range, Stage, TechniqueData } from '../types/technique';

export const GRADE_COLOR: Record<Grade, number> = {
  perfect: 0x22c55e,
  early: 0xfacc15,
  late: 0xf97316,
  miss: 0xef4444,
};
export const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
export const fmtMs = (ms: number): string => `${ms >= 0 ? '+' : ''}${Math.round(ms)}ms`;

const STAGE_LABEL: Record<Stage, string> = { recognition: '1 인지', entry: '2 진입', throw: '3 던지기' };
const IGNORED = 0x71717a;
const MAX_MARKS = 12;
const MAX_LOG = 5;
const FONT = { fontFamily: 'monospace', fontSize: '9px', color: '#e4e4e7' };

interface Mark { ms: number; color: number; label: string; ignored: boolean }

/**
 * 화면 하단 타이밍 디버거.
 * - 막대: 현재(또는 마지막) 페이즈 전체 [0, durationMs]. 비트마다 Early(노랑)/Perfect(초록)/Late(주황) 구간, 흰 선 = targetMs
 * - 회색 눈금 = 100ms (10fps 애니 프레임 격자), 청록 커서 = 현재 시점 (히트스톱 중 흰색)
 * - 마커: 입력 시점 ▲ + ms 오차, 판정 구간 밖 입력은 회색 ×
 * - 로그: 최근 판정 5개
 */
export class TimingDebugger {
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly title: Phaser.GameObjects.Text;
  private readonly clock: Phaser.GameObjects.Text;
  private readonly markTexts: Phaser.GameObjects.Text[] = [];
  private readonly logTexts: Phaser.GameObjects.Text[] = [];

  private phase: Phase | null = null;
  private beats: Beat[] = [];
  private phaseStart = 0;
  private marks: Mark[] = [];
  private log: { text: string; color: number }[] = [];

  private readonly barY: number;

  constructor(
    scene: Phaser.Scene,
    private readonly data: TechniqueData,
    layer: Phaser.GameObjects.Layer,
    private readonly x = 16,
    private readonly y = 304,
    private readonly w = 608,
  ) {
    this.barY = y + 14;
    this.g = scene.add.graphics();
    this.title = scene.add.text(x, y + 1, '', FONT);
    this.clock = scene.add.text(x + w, y + 1, '', FONT).setOrigin(1, 0);
    for (let i = 0; i < MAX_MARKS; i++) this.markTexts.push(scene.add.text(0, 0, '', FONT).setOrigin(0.5, 0).setVisible(false));
    for (let i = 0; i < MAX_LOG; i++) this.logTexts.push(scene.add.text(0, y + 45, '', FONT));
    layer.add([this.g, this.title, this.clock, ...this.markTexts, ...this.logTexts]);
  }

  reset(): void {
    this.phase = null;
    this.beats = [];
    this.marks = [];
    this.log = [];
  }

  onEvent(e: EngineEvent): void {
    switch (e.type) {
      case 'enter':
        if (e.kind === 'phase') {
          // 분기/낙법으로 넘어가도 마지막 페이즈 막대와 마커는 유지
          this.phase = this.data.phases.find((p) => p.id === e.id) ?? null;
          this.beats = this.phase ? beatsOf(this.phase.input) : [];
          this.phaseStart = e.atMs;
          this.marks = [];
        }
        break;
      case 'judged': {
        const b = this.beats[e.beat];
        if (!b) break;
        const color = GRADE_COLOR[e.grade];
        const hasInput = e.offsetMs !== null;
        let label = hasInput ? fmtMs(e.offsetMs as number) : 'MISS';
        if (e.wrongDirection) label = `방향✗ ${label}`;
        this.marks.push({ ms: hasInput ? b.targetMs + (e.offsetMs as number) : windowBounds(b).close, color, label, ignored: false });
        const tag = e.beats > 1 ? `${e.phaseId}#${e.beat + 1}` : e.phaseId;
        this.log.push({ text: `${tag} ${e.grade.toUpperCase()} ${label}`, color });
        if (this.log.length > MAX_LOG) this.log.shift();
        break;
      }
      case 'inputIgnored':
        if (this.phase && e.phaseId === this.phase.id && e.reason !== 'repeat')
          this.marks.push({ ms: e.seqMs, color: IGNORED, label: '×', ignored: true });
        break;
      default:
        break;
    }
    if (this.marks.length > MAX_MARKS) this.marks.splice(0, this.marks.length - MAX_MARKS);
  }

  draw(state: EngineState | null): void {
    const { g, x, w, barY } = this;
    g.clear();
    g.fillStyle(0x09090b, 0.94).fillRect(0, this.y - 2, 640, 360 - this.y + 2);
    g.fillStyle(0x27272a).fillRect(0, this.y - 2, 640, 1);

    const p = this.phase;
    if (!p) {
      this.title.setText('TIMING DEBUGGER — 우케 접근 대기');
      this.clock.setText('');
      this.markTexts.forEach((t) => t.setVisible(false));
      this.drawLog();
      return;
    }

    const dur = p.durationMs;
    const px = (ms: number) => Math.round(x + (Phaser.Math.Clamp(ms, 0, dur) / dur) * w);
    const seg = (T: number, [a, b]: Range, c: number) => g.fillStyle(c, 0.85).fillRect(px(T + a), barY, Math.max(1, px(T + b) - px(T + a)), 10);

    g.fillStyle(0x27272a).fillRect(x, barY, w, 10);
    for (let t = 100; t < dur; t += 100) g.fillStyle(0x3f3f46).fillRect(px(t), barY, 1, 10);

    for (const b of this.beats) {
      seg(b.targetMs, b.window.early, GRADE_COLOR.early);
      seg(b.targetMs, b.window.perfect, GRADE_COLOR.perfect);
      seg(b.targetMs, b.window.late, GRADE_COLOR.late);
      g.fillStyle(0xffffff).fillRect(px(b.targetMs), barY - 2, 1, 14);
      if (b.type === 'hold_release' && b.holdStartMaxMs !== undefined)
        g.fillStyle(0x22d3ee, 0.6).fillRect(px(0), barY + 4, px(b.holdStartMaxMs) - px(0), 2);
    }

    // 현재 시점 커서 (이 페이즈가 진행 중일 때만)
    const live = state?.kind === 'phase' && state.id === p.id;
    const cur = live ? state.nowMs - this.phaseStart : null;
    if (cur !== null) g.fillStyle(state?.hitstop ? 0xffffff : 0x22d3ee).fillRect(px(cur) - 1, barY - 3, 2, 16);

    // 입력 마커
    this.markTexts.forEach((t) => t.setVisible(false));
    let lastLabelX = -Infinity;
    this.marks.forEach((m, i) => {
      const mx = px(m.ms);
      if (m.ignored) {
        g.fillStyle(m.color).fillRect(mx, barY + 11, 1, 5);
      } else {
        g.fillStyle(m.color).fillTriangle(mx, barY + 11, mx - 3, barY + 17, mx + 3, barY + 17);
      }
      const t = this.markTexts[i];
      if (!m.ignored || mx - lastLabelX > 8) {
        // 라벨 겹침 방지: 가까우면 한 줄 아래
        const row = mx - lastLabelX < 44 && !m.ignored ? 1 : 0;
        t.setText(m.label).setColor(hex(m.color)).setPosition(mx, barY + 18 + row * 8).setVisible(true);
        lastLabelX = mx;
      }
    });

    const kind = input(p);
    this.title.setText(`[${STAGE_LABEL[p.stage]}] ${p.label.ko}  ·  ${kind}`);
    const shown = cur ?? (state?.kind === 'phase' ? 0 : null);
    const status = live ? '' : state?.kind ? `  → ${state.kind}:${state.id}` : '';
    this.clock.setText(`${shown === null ? '—' : Math.round(shown)} / ${dur}ms${state?.hitstop ? '  HITSTOP' : ''}${status}`);
    this.drawLog();
  }

  private drawLog(): void {
    let lx = this.x;
    this.logTexts.forEach((t, i) => {
      const entry = this.log[i];
      if (!entry) return t.setVisible(false);
      t.setText(entry.text).setColor(hex(entry.color)).setPosition(lx, this.y + 45).setVisible(true);
      lx += t.width + 12;
    });
  }
}

const input = (p: Phase): string => {
  const i = p.input;
  if (i.type === 'none') return '입력 없음';
  if (i.type === 'sequence') return `연속 입력 ×${i.beats.length}`;
  return i.type === 'direction_press' ? `방향(${i.direction}) + ${i.button}` : i.type === 'hold_release' ? `홀드→릴리즈 ${i.button}` : i.button;
};
