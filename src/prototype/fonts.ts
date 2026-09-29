/** 한글 표시용 폰트 스택. 웹폰트(Nanum Gothic Coding)를 먼저 로드하고, 실패 시 시스템 한글 폰트로 폴백 */
export const FONT_FAMILY = '"Nanum Gothic Coding", D2Coding, "Malgun Gothic", "Apple SD Gothic Neo", monospace';

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/g;

/** 문자열들에 등장하는 한글 글자 집합 (중복 제거) */
export const hangulIn = (...texts: string[]): string => [...new Set(texts.join('').match(HANGUL) ?? [])].join('');

/**
 * Google Fonts 한글 폰트는 unicode-range 조각으로 나뉘어 있어, 실제로 쓰는 글자를 넘겨야 해당 조각이 로드된다.
 * Phaser Text 는 생성 시점 폰트로 래스터화되므로 게임 시작 전에 로드를 기다린다 (최대 timeoutMs).
 */
export const loadFonts = async (glyphs: string, timeoutMs = 4000): Promise<void> => {
  if (!document.fonts || !glyphs) return;
  const sample = `${glyphs}ABC012`;
  const load = Promise.all(
    ['400', '700'].map((w) => document.fonts.load(`${w} 10px "Nanum Gothic Coding"`, sample)),
  ).then(() => undefined);
  await Promise.race([load, new Promise<void>((r) => setTimeout(r, timeoutMs))]).catch(() => undefined);
};
