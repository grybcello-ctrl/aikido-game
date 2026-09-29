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
const validateRegistry = ajv.getSchema('https://aikido-engine.local/schema/animation.schema.json');
const validateTechnique = ajv.getSchema('https://aikido-engine.local/schema/technique.schema.json');

let errors = 0;
const fail = (file, msg) => { errors++; console.error(`  ✗ [${file}] ${msg}`); };

// ── 공통 레지스트리 ──
const common = load('animations/common.json');
if (!validateRegistry(common)) validateRegistry.errors.forEach((e) => fail('common.json', `${e.instancePath} ${e.message}`));

/** 이벤트가 발생하는 시점(ms, 애니 시작 기준) — holds 반영 */
const eventTimeMs = (def, name) => {
  const ev = def.events?.find((e) => e.name === name);
  if (!ev) return null;
  const tick = 1000 / def.frameRate;
  let t = 0;
  for (let i = 0; i < ev.frame; i++) t += tick * (def.holds?.[String(i)] ?? 1);
  return t;
};
const animLengthMs = (def) => {
  const tick = 1000 / def.frameRate;
  let t = 0;
  for (let i = 0; i <= def.end - def.start; i++) t += tick * (def.holds?.[String(i)] ?? 1);
  return t;
};

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
  for (const k of Object.keys(t.animations.exclusive))
    if (!k.startsWith(`tech.${t.id}.`)) fail(fname, `전용 애니 '${k}' 는 'tech.${t.id}.' 로 시작해야 함`);

  const resolve = (key, where) => {
    if (key.startsWith('common.')) {
      if (!required.has(key)) fail(fname, `${where}: '${key}' 가 animations.common 목록에 없음`);
      return common.animations[key];
    }
    const def = t.animations.exclusive[key];
    if (!def) fail(fname, `${where}: 전용 애니 '${key}' 정의 없음`);
    return def;
  };

  for (const [k, d] of Object.entries({ ...t.animations.exclusive }))
    if (d.end < d.start) fail(fname, `${k}: end < start`);

  const phaseIds = new Set(t.phases.map((p) => p.id));
  const branchIds = new Set(Object.keys(t.branches));
  if (phaseIds.size !== t.phases.length) fail(fname, 'phase id 중복');
  const checkGoto = (g, where) => {
    const [kind, id] = g.split(':');
    if (kind === 'phase' && !phaseIds.has(id)) fail(fname, `${where}: 없는 phase '${id}'`);
    if (kind === 'branch' && !branchIds.has(id)) fail(fname, `${where}: 없는 branch '${id}'`);
  };

  const checkSeq = (seq, where) => {
    for (const actor of ['nage', 'uke']) {
      const slot = seq.actors[actor];
      const def = resolve(slot.anim, `${where}.actors.${actor}`);
      if (def && def.actor !== actor) fail(fname, `${where}: '${slot.anim}' 는 ${def.actor}용인데 ${actor} 슬롯에 배치됨`);
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
  for (const p of t.phases) {
    const where = `phase:${p.id}`;
    checkSeq(p, where);
    const { input: inp } = p;

    if (inp.type === 'none') {
      if (!p.outcomes.auto) fail(fname, `${where}: input none → outcomes.auto 필요`);
    } else {
      for (const g of ['perfect', 'early', 'late', 'miss'])
        if (!p.outcomes[g]) fail(fname, `${where}: outcomes.${g} 누락`);
      const { early, perfect, late } = inp.window;
      if (!(early[0] < early[1] && perfect[0] < perfect[1] && late[0] < late[1])) fail(fname, `${where}: 구간 from < to 위반`);
      if (early[1] !== perfect[0] || perfect[1] !== late[0]) fail(fname, `${where}: early|perfect|late 구간이 연속적이지 않음`);
      if (!(perfect[0] <= 0 && perfect[1] > 0)) fail(fname, `${where}: perfect 구간이 targetMs(0)를 포함하지 않음`);
      const open = inp.targetMs + early[0];
      const close = inp.targetMs + late[1];
      if (open < 0 || close > p.durationMs) fail(fname, `${where}: 판정 구간 [${open}, ${close}) 가 페이즈 [0, ${p.durationMs}) 밖`);
      if (inp.type === 'hold_release' && inp.holdStartMaxMs >= open) fail(fname, `${where}: holdStartMaxMs 는 판정 구간 시작(${open}) 이전이어야 함`);

      if (inp.sync) {
        const slot = p.actors[inp.sync.actor];
        const def = resolve(slot.anim, where);
        const evT = def && eventTimeMs(def, inp.sync.event);
        if (evT === null || evT === undefined) fail(fname, `${where}: sync 이벤트 '${inp.sync.event}' 가 '${slot.anim}' 에 없음`);
        else if (Math.round((slot.startAtMs ?? 0) + evT) !== inp.targetMs)
          fail(fname, `${where}: targetMs(${inp.targetMs}) ≠ '${inp.sync.event}' 프레임 시점(${(slot.startAtMs ?? 0) + evT}ms)`);
      }
      rows.push({
        phase: p.id, start: clock, dur: p.durationMs, input: inp.type,
        target: clock + inp.targetMs,
        early: `${clock + inp.targetMs + early[0]}~${clock + inp.targetMs + early[1]}`,
        perfect: `${clock + inp.targetMs + perfect[0]}~${clock + inp.targetMs + perfect[1]}`,
        late: `${clock + inp.targetMs + late[0]}~${clock + inp.targetMs + late[1]}`,
      });
    }
    if (inp.type === 'none') rows.push({ phase: p.id, start: clock, dur: p.durationMs, input: 'none' });

    for (const [g, o] of Object.entries(p.outcomes)) {
      checkGoto(o.goto, `${where}.outcomes.${g}`);
      if (o.fx) resolve(o.fx, `${where}.outcomes.${g}.fx`);
    }
    for (const a of ['nage', 'uke']) {
      const def = resolve(p.actors[a].anim, where);
      if (def && def.repeat !== -1 && animLengthMs(def) + (p.actors[a].startAtMs ?? 0) > p.durationMs + 1)
        console.warn(`  ⚠ ${where}: ${a} 애니(${animLengthMs(def)}ms)가 페이즈(${p.durationMs}ms)보다 김 → 잘림`);
    }
    clock += p.durationMs;
  }

  for (const [id, b] of Object.entries(t.branches)) {
    checkSeq(b, `branch:${id}`);
    checkGoto(b.result.goto, `branch:${id}.result`);
  }

  // 도달성: 모든 phase/branch 가 참조되는지
  const reached = new Set([`phase:${t.phases[0].id}`]);
  t.phases.forEach((p) => Object.values(p.outcomes).forEach((o) => reached.add(o.goto)));
  [...phaseIds].forEach((id) => !reached.has(`phase:${id}`) && console.warn(`  ⚠ phase:${id} 도달 불가`));
  [...branchIds].forEach((id) => !reached.has(`branch:${id}`) && console.warn(`  ⚠ branch:${id} 미사용`));

  console.table(rows);
  console.log(`  성공 루트 총 길이: ${clock}ms`);
}

console.log(errors ? `\n✗ ${errors}개 오류` : '\n✓ 모든 데이터 유효');
process.exit(errors ? 1 : 0);
