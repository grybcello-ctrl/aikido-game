import Phaser from 'phaser';
import type { EngineEvent, Stick, TimingEngine } from './TimingEngine';

type EngineRef = TimingEngine | (() => TimingEngine | null);

/**
 * Phaser 키보드 → TimingEngine 연결.
 * - 입력 시각: KeyboardEvent.timeStamp (performance.now 계열)
 * - 엔진 시계: game.loop.now (rAF 타임스탬프, 같은 계열)
 *   ※ scene update 의 time 인자는 델타 누적값이라 이벤트 타임스탬프와 어긋날 수 있어 쓰지 않는다.
 * - toEngineTime: 실시간 → 엔진 시간 변환 (슬로모션 등). 기본은 그대로.
 * 사용: const bridge = bindKeyboard(scene, engine); engine.start(bridge.now()); update() { bridge.tick(); }
 */
export const bindKeyboard = (
  scene: Phaser.Scene,
  target: EngineRef,
  toEngineTime: (realMs: number) => number = (t) => t,
) => {
  const kb = scene.input.keyboard;
  if (!kb) throw new Error('keyboard input plugin is disabled');
  const K = Phaser.Input.Keyboard.KeyCodes;
  const keys = kb.addKeys(
    { left: K.LEFT, right: K.RIGHT, up: K.UP, down: K.DOWN, action: K.Z, guard: K.X },
    false,
  ) as Record<'left' | 'right' | 'up' | 'down' | 'action' | 'guard', Phaser.Input.Keyboard.Key>;

  const engine = (): TimingEngine | null => (typeof target === 'function' ? target() : target);
  const stick = (): Stick | undefined =>
    keys.left.isDown ? 'LEFT' : keys.right.isDown ? 'RIGHT' : keys.up.isDown ? 'UP' : keys.down.isDown ? 'DOWN' : undefined;

  const bind = (key: Phaser.Input.Keyboard.Key, button: 'ACTION' | 'GUARD') => {
    const down = (_k: Phaser.Input.Keyboard.Key, e: KeyboardEvent) =>
      engine()?.press(button, toEngineTime(e.timeStamp), stick());
    const up = (_k: Phaser.Input.Keyboard.Key, e: KeyboardEvent) =>
      engine()?.release(button, toEngineTime(e.timeStamp));
    key.on('down', down);
    key.on('up', up);
    return () => { key.off('down', down); key.off('up', up); };
  };
  const unbind = [bind(keys.action, 'ACTION'), bind(keys.guard, 'GUARD')];

  const now = () => toEngineTime(scene.game.loop.now);
  return {
    now,
    stick,
    tick: (): EngineEvent[] => engine()?.update(now()) ?? [],
    destroy: () => unbind.forEach((f) => f()),
  };
};
