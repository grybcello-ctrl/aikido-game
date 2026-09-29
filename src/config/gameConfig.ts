import Phaser from 'phaser';

export const GAME_WIDTH = 640;
export const GAME_HEIGHT = 360;

/** 바닥선(캐릭터 발 기준점 y). 오프셋 데이터의 y=0 이 이 선에 대응. */
export const FLOOR_Y = 276;

export const createGameConfig = (
  scenes: Phaser.Types.Scenes.SceneType[] = [],
  parent = 'game',
): Phaser.Types.Core.GameConfig => ({
  type: Phaser.AUTO,
  parent,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#1b1b1f',

  // 픽셀아트: 최근접 필터링 + 정수 좌표 렌더링(서브픽셀 번짐 방지)
  pixelArt: true,
  roundPixels: true,
  antialias: false,

  scale: {
    mode: Phaser.Scale.FIT, // 비율 유지 확대
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },

  // 로직/입력 판정은 60Hz로 정밀하게, 애니메이션만 8~12fps(ANIM_FPS)로 구동
  fps: {
    target: 60,
    smoothStep: false, // 델타 보정 스무딩 끔 → 타이밍 판정(ms)의 예측 가능성 확보
  },

  input: {
    keyboard: true,
    gamepad: true,
  },

  physics: {
    default: 'arcade',
    arcade: { gravity: { x: 0, y: 0 }, debug: false },
  },

  scene: scenes,
});
