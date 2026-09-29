import Phaser from 'phaser';
import { createGameConfig } from '../config/gameConfig';
import techJson from '../data/techniques/shomenuchi_iriminage_ura.json';
import { glyphsIn, loadFonts } from './fonts';
import { PrototypeScene } from './PrototypeScene';

// 단일 HTML: 인라인 번들에 UI 문자열·데이터가 모두 들어 있으므로 스크립트 본문에서 쓰이는 비 ASCII 글자를 수집
const glyphs = glyphsIn(
  ...Array.from(document.scripts, (s) => s.text),
  JSON.stringify(techJson),
);

void loadFonts(glyphs).then(() => new Phaser.Game(createGameConfig([PrototypeScene], 'game')));
