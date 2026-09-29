import Phaser from 'phaser';
import { clampAnimFps, msPerFrame } from '../config/animation';
import type { AnimationDef } from '../types/technique';

/**
 * JSON AnimationDef → Phaser 애니메이션 등록.
 * holds 는 Phaser AnimationFrame.duration(추가 ms)로 변환해 "키포즈 정지"를 구현한다.
 */
export const registerAnimations = (
  scene: Phaser.Scene,
  defs: Record<string, AnimationDef>,
): void => {
  for (const [key, def] of Object.entries(defs)) {
    if (scene.anims.exists(key)) continue;

    const fps = clampAnimFps(def.frameRate);
    const tick = msPerFrame(fps);
    const frames = scene.anims
      .generateFrameNames(def.atlas, {
        prefix: def.prefix,
        start: def.start,
        end: def.end,
        zeroPad: def.zeroPad ?? 2,
      })
      .map((frame, i) => {
        const hold = def.holds?.[String(i)];
        return hold ? { ...frame, duration: (hold - 1) * tick } : frame;
      });

    scene.anims.create({ key, frames, frameRate: fps, repeat: def.repeat ?? 0 });
  }
};
