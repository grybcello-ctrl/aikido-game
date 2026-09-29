import Phaser from 'phaser';
import type { EngineEvent } from '../engine/TimingEngine';
import { FONT_FAMILY } from './fonts';
import { fmtMs, hex } from './TimingDebugger';

export interface OverlayLine { text: string; color?: number }

const MAX_LINES = 7;
const MAX_LOG = 6;
const LINE_H = 10;

/**
 * 좌측 상단 상태 머신 오버레이
 * - 위: [STATE] [ACTION] [HP] 등 현재 내부 상태 (매 프레임 갱신)
 * - 아래: 상태 머신 이벤트 로그 (@엔진ms ENTER / WINDOW / JUDGE / RESOLVE / HITSTOP / UKEMI / END)
 */
export class StateOverlay {
  private readonly g: Phaser.GameObjects.Graphics;
  private readonly lines: Phaser.GameObjects.Text[] = [];
  private readonly logTexts: Phaser.GameObjects.Text[] = [];
  private readonly header: Phaser.GameObjects.Text;
  private log: string[] = [];

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Layer, private readonly x = 6, private readonly y = 6) {
    const f = (color: string) => ({ fontFamily: FONT_FAMILY, fontSize: '9px', color });
    this.g = scene.add.graphics();
    for (let i = 0; i < MAX_LINES; i++) this.lines.push(scene.add.text(x + 4, y + 3 + i * LINE_H, '', f('#e4e4e7')));
    const logY = y + 5 + MAX_LINES * LINE_H;
    this.header = scene.add.text(x + 4, logY, '── STATE MACHINE LOG ──', f('#52525b'));
    for (let i = 0; i < MAX_LOG; i++) this.logTexts.push(scene.add.text(x + 4, logY + (i + 1) * LINE_H, '', f('#a1a1aa')));
    layer.add([this.g, ...this.lines, this.header, ...this.logTexts]);
  }

  reset(): void {
    this.log = [];
  }

  pushEvent(e: EngineEvent): void {
    const t = `@${String(Math.round(e.atMs)).padStart(4, ' ')}`;
    let s: string | null = null;
    switch (e.type) {
      case 'enter': s = `ENTER ${e.kind}:${e.id}`; break;
      case 'windowOpen': s = `WINDOW ${e.phaseId}${e.beats > 1 ? `#${e.beat + 1}` : ''} open`; break;
      case 'holdStart': s = `HOLD ${e.phaseId}`; break;
      case 'judged': s = `JUDGE ${e.grade.toUpperCase()} ${e.offsetMs === null ? 'no-input' : fmtMs(e.offsetMs)}`; break;
      case 'resolved': s = `RESOLVE ${e.result} → ${e.goto}`; break;
      case 'hitstop': s = `HITSTOP ${e.durationMs}ms`; break;
      case 'ukemi': s = `UKEMI ${e.result.toUpperCase()} (${e.successes}/${e.checks})`; break;
      case 'end': s = `END ${e.result.toUpperCase()}`; break;
      case 'inputIgnored': s = e.reason === 'repeat' ? null : `IGNORED input (${e.reason})`; break;
      default: break;
    }
    if (!s) return;
    this.log.push(`${t} ${s}`);
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  draw(lines: OverlayLine[]): void {
    let maxW = 150;
    this.lines.forEach((t, i) => {
      const l = lines[i];
      t.setText(l?.text ?? '').setColor(hex(l?.color ?? 0xe4e4e7));
      maxW = Math.max(maxW, t.width);
    });
    this.logTexts.forEach((t, i) => {
      t.setText(this.log[i] ?? '');
      maxW = Math.max(maxW, t.width);
    });
    const h = 8 + (MAX_LINES + 1 + MAX_LOG) * LINE_H;
    this.g.clear();
    this.g.fillStyle(0x09090b, 0.78).fillRect(this.x, this.y, maxW + 10, h);
    this.g.fillStyle(0x3f3f46).fillRect(this.x, this.y, 2, h);
  }
}
