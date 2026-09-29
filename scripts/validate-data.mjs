// 데이터 검증: (1) JSON Schema 구조 검증 (2) 스키마로 표현 불가한 의미 규칙 검증
// 사용: node scripts/validate-data.mjs
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(load('schema/animation.schema.json'));
ajv.addSchema(load('schema/technique.schema.json'));
const validateRegistry = ajv.getSchema('https://aikido-game.local/schema/animation.schema.json');
const validateTechnique = ajv.getSchema('https://aikido-game.local/schema/technique.schema.json');

const STAGES = ['recognition', 'entry', 'throw'];
const GRADES = ['perfect', 'early', 'late', 'miss'];

let errors = 0;
const fail = (file, msg) => { errors++; console.error(`  ✗ [${file}] ${msg}`); };
const warn = (msg) => console.warn(`  ⚠ ${msg}`);

// ── 공통 레지스트리 ──
const common = load('animations/common.json');
if (!validateRegistry(common)) validateRegistry.errors.forEach((e) => fail('common.json', `${e.instancePath} ${e.message}`));

const tickMs = (def) => 1000 / def.frameRate;
/** 이벤트 발생 시점(ms, 애니 시작 기준) — holds 반영 */
const eventTimeMs = (def, name) => {
  const ev = def.events?.find((e) => e.name === name);
  if (!ev) return null;
  let t = 0;
  for (let i = 0; i < ev.frame; i++) t += tickMs(def) * (def.holds?.[String(i)] ?? 1);
  return t;
};
const animLengthMs = (def) => {
  let t = 0;
  for (let i = 0; i <= def.end - def.start; i++) t += tickMs(def) * (def.holds?.[String(i)] ?? 1);
  return t;
};
const beatsOf = (inp) => (inp.type === 'none' ? [] : inp.type === 'sequence' ? inp.beats : [inp]);

// ── 기술 파일 ──
for (const fname of readdirSync(join(root, 'techniques')).filter((f) => f.endsWith('.json'))) {
  const t = load(`techniques/${fname}`);
  console.log(`\n▶ ${fname}`);
  if (!validateTechnique(t)) {
    validateTechnique.errors.forEach((e) => fail(fname, `schema ${e.instancePath} ${e.message}`));
    continue;
  }

  // 애니메이션 키 해석
  const required = new Set(t.animations.common);
  for (const k of required) if (!common.animations[k]) fail(fname, `공통 애니 '${k}' 가 common.json 에 없음`);
  for (const [k, d] of Object.entries(t.animations.exclusive)) {
    if (!k.startsWith(`tech.${t.id}.`)) fail(fname, `전용 애니 '${k}' 는 'tech.${t.id}.' 로 시작해야 함`);
    if (d.end < d.start) fail(fname, `${k}: end < start`);
  }
  const used = new Set();
  const resolve = (key, where) => {
    used.add(key);
    if (key.startsWith('common.')) {
      if (!required.has(key)) fail(fname, `${where}: '${key}' 가 animations.common 목록에 없음`);
      return common.animations[key];
    }
    const def = t.animations.exclusive[key];
    if (!def) fail(fname, `${where}: 전용 애니 '${key}' 정의 없음`);
    return def;
  };

  const phaseIds = new Set(t.phases.map((p) => p.id));
  const branchIds = new Set(Object.keys(t.branches));
  if (phaseIds.size !== t.phases.length) fail(fname, 'phase id 중복');
  const checkGoto = (g, where) => {
    const [kind, id] = g.split(':');
    if (kind === 'phase' && !phaseIds.has(id)) fail(fname, `${where}: 없는 phase '${id}'`);
    if (kind === 'branch' && !branchIds.has(id)) fail(fname, `${where}: 없는 branch '${id}'`);
    if (kind === 'ukemi' && !t.ukemi) fail(fname, `${where}: goto 'ukemi' 인데 ukemi 정의 없음`);
  };
  const checkEffect = (e, where) => { if (e?.fx) resolve(e.fx, `${where}.fx`); };

  /** actors / tracks / 애니 길이 공통 검사 (phase · branch · ukemi) */
  const checkSeq = (seq, where) => {
    for (const actor of ['nage', 'uke']) {
      const slot = seq.actors[actor];
      const def = resolve(slot.anim, `${where}.actors.${actor}`);
      if (def && def.actor !== actor) fail(fname, `${where}: '${slot.anim}' 는 ${def.actor}용인데 ${actor} 슬롯에 배치됨`);
      if (def && def.repeat !== -1 && animLengthMs(def) + (slot.startAtMs ?? 0) > seq.durationMs + 1)
        warn(`${where}: ${actor} 애니(${animLengthMs(def)}ms)가 시퀀스(${seq.durationMs}ms)보다 김 → 잘림`);
      const keys = seq.tracks[actor];
      if (keys[0].atMs !== 0) fail(fname, `${where}.tracks.${actor}: 첫 키는 atMs=0 이어야 함`);
      keys.forEach((k, i) => {
        if (i && k.atMs <= keys[i - 1].atMs) fail(fname, `${where}.tracks.${actor}[${i}]: atMs 오름차순 위반`);
        if (k.atMs > seq.durationMs) fail(fname, `${where}.tracks.${actor}[${i}]: durationMs 초과`);
      });
    }
  };

  // maai 진입 조건
  const { minPx, idealPx, maxPx } = t.requires.maai;
  if (!(minPx <= idealPx && idealPx <= maxPx)) fail(fname, 'requires.maai: min <= ideal <= max 위반');
  const ukeStart = Math.abs(t.phases[0].tracks.uke[0].x ?? 0);
  if (ukeStart < minPx || ukeStart > maxPx) fail(fname, `첫 phase uke 거리 ${ukeStart}px 가 마아이 범위 밖`);

  const rows = [];
  let clock = 0;
  let stageIdx = 0;
  let routeChecks = 0;
  const reached = new Set([`phase:${t.phases[0].id}`]);

  for (const p of t.phases) {
    const where = `phase:${p.id}`;
    checkSeq(p, where);

    // stage 순서: recognition → entry → throw (비감소)
    const si = STAGES.indexOf(p.stage);
    if (si < stageIdx) fail(fname, `${where}: stage '${p.stage}' 가 이전 stage '${STAGES[stageIdx]}' 보다 앞섬`);
    stageIdx = Math.max(stageIdx, si);

    const inp = p.input;
    const beats = beatsOf(inp);
    routeChecks += beats.length;

    // 필요한 outcome 키
    const need =
      inp.type === 'none' ? ['auto']
      : inp.type === 'sequence' ? ['perfect', 'clear', ...(inp.breakOn ?? ['miss'])]
      : GRADES;
    for (const k of need) if (!p.outcomes[k]) fail(fname, `${where}: outcomes.${k} 누락`);
    for (const k of Object.keys(p.outcomes)) if (!need.includes(k)) warn(`${where}: outcomes.${k} 는 도달 불가 (입력 타입 ${inp.type})`);

    let prevClose = -Infinity;
    beats.forEach((b, bi) => {
      const bw = beats.length > 1 ? `${where}#${bi + 1}` : where;
      const { early, perfect, late } = b.window;
      if (!(early[0] < early[1] && perfect[0] < perfect[1] && late[0] < late[1])) fail(fname, `${bw}: 구간 from < to 위반`);
      if (early[1] !== perfect[0] || perfect[1] !== late[0]) fail(fname, `${bw}: early|perfect|late 구간이 연속적이지 않음`);
      if (!(perfect[0] <= 0 && perfect[1] > 0)) fail(fname, `${bw}: perfect 구간이 targetMs(0)를 포함하지 않음`);
      const open = b.targetMs + early[0];
      const close = b.targetMs + late[1];
      if (open < 0 || close > p.durationMs) fail(fname, `${bw}: 판정 구간 [${open}, ${close}) 가 페이즈 [0, ${p.durationMs}) 밖`);
      if (open < prevClose) fail(fname, `${bw}: 이전 비트 구간(~${prevClose})과 겹침`);
      prevClose = close;
      if (b.type === 'hold_release' && b.holdStartMaxMs >= open) fail(fname, `${bw}: holdStartMaxMs 는 판정 구간 시작(${open}) 이전이어야 함`);

      if (b.sync) {
        const slot = p.actors[b.sync.actor];
        const def = resolve(slot.anim, bw);
        const evT = def && eventTimeMs(def, b.sync.event);
        if (evT === null || evT === undefined) fail(fname, `${bw}: sync 이벤트 '${b.sync.event}' 가 '${slot.anim}' 에 없음`);
        else if (Math.round((slot.startAtMs ?? 0) + evT) !== b.targetMs)
          fail(fname, `${bw}: targetMs(${b.targetMs}) ≠ '${b.sync.event}' 프레임 시점(${(slot.startAtMs ?? 0) + evT}ms)`);
      }
      const at = (r) => `${clock + b.targetMs + r[0]}~${clock + b.targetMs + r[1]}`;
      rows.push({
        phase: beats.length > 1 ? `${p.id}#${bi + 1}` : p.id, stage: p.stage, start: clock, dur: p.durationMs,
        input: b.type, target: clock + b.targetMs, early: at(early), perfect: at(perfect), late: at(late),
      });
    });
    if (!beats.length) rows.push({ phase: p.id, stage: p.stage, start: clock, dur: p.durationMs, input: 'none' });

    if (inp.type === 'sequence') for (const [g, e] of Object.entries(inp.beatEffects ?? {})) checkEffect(e, `${where}.beatEffects.${g}`);
    for (const [g, o] of Object.entries(p.outcomes)) {
      checkGoto(o.goto, `${where}.outcomes.${g}`);
      checkEffect(o, `${where}.outcomes.${g}`);
      if (need.includes(g)) reached.add(o.goto);
    }
    clock += p.durationMs;
  }
  for (const s of STAGES) if (!t.phases.some((p) => p.stage === s)) warn(`stage '${s}' 페이즈 없음`);

  for (const [id, b] of Object.entries(t.branches)) {
    checkSeq(b, `branch:${id}`);
    checkGoto(b.result.goto, `branch:${id}.result`);
    reached.add(b.result.goto);
  }

  // ukemi
  if (t.ukemi) {
    const { rules, results } = t.ukemi;
    const last = rules[rules.length - 1];
    if (Object.keys(last).some((k) => k !== 'result')) fail(fname, 'ukemi.rules: 마지막 규칙은 조건 없는 기본값이어야 함');
    const counted = t.phases
      .filter((p) => (t.ukemi.countStages ?? STAGES).includes(p.stage))
      .reduce((n, p) => n + beatsOf(p.input).length, 0);
    for (const r of rules) {
      if (r.minSuccess !== undefined && r.minSuccess > counted)
        fail(fname, `ukemi.rules(${r.result}): minSuccess ${r.minSuccess} > 집계 가능 체크 수 ${counted} → 도달 불가`);
    }
    for (const [g, s] of Object.entries(results)) {
      checkSeq(s, `ukemi:${g}`);
      checkGoto(s.result.goto, `ukemi:${g}.result`);
    }
    if (!reached.has('ukemi')) warn('ukemi 정의가 있지만 goto "ukemi" 가 없음');
    console.log(`  낙법 규칙: ${rules.map((r) => `${r.result}(${Object.entries(r).filter(([k]) => k !== 'result').map(([k, v]) => `${k}=${v}`).join(',') || '기본'})`).join(' → ')} / 집계 체크 ${counted}회`);
  }

  // 도달성
  [...phaseIds].forEach((id) => !reached.has(`phase:${id}`) && warn(`phase:${id} 도달 불가`));
  [...branchIds].forEach((id) => !reached.has(`branch:${id}`) && warn(`branch:${id} 미사용`));
  [...required].forEach((k) => !used.has(k) && warn(`공통 애니 '${k}' 선언됐지만 미사용`));

  console.table(rows);
  console.log(`  성공 루트: ${clock}ms (낙법 제외), 타이밍 체크 ${routeChecks}회`);
}

console.log(errors ? `\n✗ ${errors}개 오류` : '\n✓ 모든 데이터 유효');
process.exit(errors ? 1 : 0);
