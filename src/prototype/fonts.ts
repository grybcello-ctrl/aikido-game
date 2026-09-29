/** 한글 표시용 폰트 스택. 웹폰트(Nanum Gothic Coding)를 먼저 로드하고, 실패 시 시스템 한글 폰트로 폴백 */
export const FONT_FAMILY = '"Nanum Gothic Coding", D2Coding, "Malgun Gothic", "Apple SD Gothic Neo", monospace';
export const WEBFONT_URL = 'https://fonts.googleapis.com/css2?family=Nanum+Gothic+Coding:wght@400;700&display=swap';

/** Phaser Text 는 생성 시점 폰트로 래스터화되므로 게임 시작 전에 로드를 기다린다 (최대 timeoutMs) */
export const loadFonts = async (timeoutMs = 2500): Promise<void> => {
  if (!document.fonts) return;
  const load = Promise.all([
    document.fonts.load('10px "Nanum Gothic Coding"', '가나다'),
    document.fonts.load('bold 10px "Nanum Gothic Coding"', '가나다'),
  ]).then(() => undefined);
  await Promise.race([load, new Promise<void>((r) => setTimeout(r, timeoutMs))]).catch(() => undefined);
};
