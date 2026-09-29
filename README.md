# aikido-game

아이키도 원리(마아이·무스비)를 담은 Phaser 3 타이밍 액션 게임의 데이터 주도 코어.

- `src/config/` — Phaser 설정(640×360, pixelArt), 리미티드 애니메이션(8~12fps) 정책
- `src/data/schema/` — 기술·애니메이션 JSON Schema (draft 2020-12)
- `src/data/animations/common.json` — 공통 애니메이션 레지스트리
- `src/data/techniques/` — 기술 데이터 (샘플: 정면타 입신던지기 우라)
- `scripts/validate-data.mjs` — 스키마 + 의미 규칙 검증, 타이밍표 출력

```bash
npm install
npm run validate:data
npm run typecheck
```
