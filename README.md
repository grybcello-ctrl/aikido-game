# aikido-game

아이키도 원리(마아이·무스비)를 담은 Phaser 3 타이밍 액션 게임의 데이터 주도 코어.

- `src/config/` — Phaser 설정(640×360, pixelArt), 리미티드 애니메이션(8~12fps) 정책
- `src/data/schema/` — 기술·애니메이션 JSON Schema (draft 2020-12)
- `src/data/animations/common.json` — 공통 애니메이션 레지스트리
- `src/data/techniques/` — 기술 데이터 (샘플: 정면타 입신던지기 우라)
- `src/engine/TimingEngine.ts` — 범용 타이밍 상태머신 (인지 → 진입(n-beat) → 던지기 → 낙법), Phaser 비의존
- `src/engine/ukemi.ts` — 누적 성공 기록 → 낙법(perfect / sloppy / crash) 도출
- `src/engine/phaserBridge.ts` — Phaser 키보드(←→↑↓, Z=ACTION, X=GUARD) → 엔진 연결
- `src/render/` — 트랙/애니 프레임 샘플링(`PoseTracker`), 슬로모션 가능한 게임 시계(`GameClock`)
- `src/prototype/` — 더미 사각형 프로토타입 씬 + 하단 타이밍 디버거
- `prototype/aikido-prototype.html` — **단일 HTML 프로토타입** (빌드 산출물, Phaser 는 CDN)
- `scripts/validate-data.mjs` — 스키마 + 의미 규칙 검증, 타이밍표 출력

## 프로토타입 실행

- 바로 플레이: `prototype/aikido-prototype.html` 파일을 받아 브라우저로 열기 (더블클릭, 인터넷 연결 필요: Phaser·폰트 CDN)
  - 또는 [raw.githack 링크](https://raw.githack.com/grybcello-ctrl/aikido-game/main/prototype/aikido-prototype.html) — 첫 방문 시 githack 안내 페이지를 한 번 통과해야 함
- 개발 서버: `npm run dev` → http://localhost:5173
- 단일 HTML 재생성: `npm run build:prototype`

조작: `Enter`/`Z` 시작 · `Z` 입력 · `←` `→` 방향(텐칸 = 뒤쪽 + Z) · `R` 재시작 · `M` 좌우 반전 · `T` 배속(1 / 0.5 / 0.25) · `Q` 스냅(10fps) 토글 · `D` 라벨

```ts
const engine = new TimingEngine(technique, { mirror: false });
const bridge = bindKeyboard(scene, engine);
engine.on((e) => { /* judged, reaction, hitstop, ukemi, end ... */ });
engine.start(bridge.now());
// Scene.update(): bridge.tick(); const s = engine.getState(bridge.now());
```

```bash
npm install
npm run validate:data
npm run typecheck
```
