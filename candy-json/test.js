// Тесты движка по боевым данным Candy. Запуск: node test.js
// 1. Регресс: все JSON-фильтры из candidates_presets + примеры из «Подборки база Candy»
//    прогоняются через validateFilter (поля, операторы, enum, nested-структура).
// 2. Голдены: движок собирает фильтры по спекам, результат сравнивается
//    с реальным боевым фильтром подборки (канонизированное сравнение:
//    схлопывание одиночных $and/$or, сортировка веток).
'use strict';
const fs = require('fs');
const path = require('path');
const { validateFilter } = require('./builder');
const { buildQuery } = require('./engine');

const KB = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', p), 'utf-8'));
const presets = KB('presets.json');
const examples = KB('query_examples.json');

// Известный дрейф: оператор был в старых пресетах, но отсутствует в актуальном filter.json
const KNOWN_DRIFT = ['text_phrase_any_of'];

let pass = 0, fail = 0, warn = 0;
const failures = [];

function report(name, errors){
  const drift = errors.filter(e => KNOWN_DRIFT.some(op => e.includes(op)));
  const real = errors.filter(e => !KNOWN_DRIFT.some(op => e.includes(op)));
  if (!errors.length){ pass++; console.log('  ✓', name); }
  else if (!real.length){ warn++; console.log('  ⚠', name, '— только известный дрейф схемы:', drift[0]); }
  else { fail++; failures.push({ name, errors: real }); console.log('  ✗', name); real.slice(0, 3).forEach(e => console.log('     ', e)); }
}

/* ── 1. Регресс по боевым фильтрам ── */
console.log('\n[1] Валидация боевых фильтров из candidates_presets:');
for (const p of presets){
  if (!p.filter || p.filter._parse_error) continue;
  report(p.name, validateFilter(p.filter));
}
console.log('\n[2] Валидация примеров из «Подборки база Candy»:');
examples.forEach((ex, i) => {
  if (!ex.filter || ex.filter._parse_error) return;
  report(`пример ${i + 1}: ${(ex.explanation || '').slice(0, 60)}`, validateFilter(ex.filter));
});

/* ── 2. Голдены: спека → движок → сравнение с боевым фильтром ── */
function canon(f){
  if (Array.isArray(f)) return f.map(canon);
  if (f && typeof f === 'object'){
    const keys = Object.keys(f);
    if (keys.length === 1 && (keys[0] === '$and' || keys[0] === '$or') && f[keys[0]].length === 1)
      return canon(f[keys[0]][0]); // {$and:[x]} → x
    const out = {};
    for (const k of keys.sort()){
      let v = canon(f[k]);
      if ((k === '$and' || k === '$or') && Array.isArray(v))
        v = v.slice().sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      out[k] = v;
    }
    return out;
  }
  return f;
}
const eq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const byName = n => presets.find(p => p.name === n);

function golden(name, spec){
  const target = byName(name);
  if (!target || !target.filter){ console.log('  ? нет эталона:', name); return; }
  const res = buildQuery(spec);
  if (res.status !== 'ok'){
    fail++; failures.push({ name: 'golden ' + name, errors: [JSON.stringify(res.errors || res.questions)] });
    console.log('  ✗', name, '— движок не собрал:', res.status, JSON.stringify(res.errors || (res.questions || []).map(q => q.question)).slice(0, 200));
    return;
  }
  if (eq(res.filter, target.filter)){ pass++; console.log('  ✓', name, '— совпал с боевым фильтром'); }
  else {
    fail++; failures.push({ name: 'golden ' + name, errors: ['фильтры различаются'] });
    console.log('  ✗', name, '— отличается от эталона');
    fs.writeFileSync(path.join(__dirname, `.golden-diff-${name.replace(/\W+/g, '_')}.json`),
      JSON.stringify({ engine: canon(res.filter), preset: canon(target.filter) }, null, 2));
    console.log('     diff → .golden-diff-*.json');
  }
}

console.log('\n[3] Голдены (спека движка ↔ боевой фильтр подборки):');

// «ПА с английским»: специализация ПА + свежая должность в опыте + полный блок исключений
golden('ПА с английским', {
  conditions: { all: [
    { field: 'hiringProcesses.specializationId', op: 'string_eq', value: '8d663323-b98e-4b47-8b7d-91581dd6896f' },
    { same: 'resumes.workExperience', children: [
      { field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Продуктовый аналитик' },
      { field: 'resumes.workExperience.startDate', op: 'date_gt', value: '2023-01-01' },
    ] },
  ] },
  exclusions: true,
});

// «Бывшие TLPA»: единственный $not по критичным причинам увольнения в фактах
golden('Бывшие TLPA', {
  conditions: { not: { same: 'facts', children: [
    { field: 'facts.employeeDismissalReasonId', op: 'int_one_of', value: [3, 4] },
  ] } },
  exclusions: false,
});

// «Scala»: специализация + свежесть опыта + скиллы + ручной набор исключений (в этом
// пресете исключения нестандартные: +Dismissed, без facts) — собираем not-узлами
golden('Scala', {
  conditions: { all: [
    { field: 'hiringProcesses.specializationId', op: 'string_eq', value: '8a7ce8be-c092-4e34-8e29-bf48e782f0e2' },
    { same: 'resumes', children: [
      { same: 'resumes.workExperience', children: [
        { field: 'resumes.workExperience.startDate', op: 'date_lt', value: '2022-08-01' },
      ] },
      { field: 'resumes.declaredSkills', op: 'text_list_matches_any_of', value: ['cats', 'zio'] },
    ] },
    { not: { field: 'tags', op: 'text_list_matches_any_of', value: ['читер'] } },
    { not: { field: 'employeeStatus', op: 'string_eq', value: 'Employed' } },
    { not: { field: 'employeeStatus', op: 'string_eq', value: 'Dismissed' } },
    { not: { field: 'employeeDismissalReasonIsNegative', op: 'bool_eq', value: true } },
  ] },
  exclusions: false,
});

// «Риск-менеджеры»: same-группа по одному месту работы (isCurrent + дата + 4 варианта должности)
golden('Риск-менеджеры', {
  conditions: { all: [
    { field: 'hiringProcesses.specializationId', op: 'string_eq', value: 'da838c2c-cc7b-44e3-9dd7-0e288d47ec08' },
    { same: 'resumes.workExperience', children: [
      { field: 'resumes.workExperience.isCurrent', op: 'bool_eq', value: true },
      { field: 'resumes.workExperience.startDate', op: 'date_lt', value: '2025-01-28' },
      { any: [
        { field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Risk Manager' },
        { field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Риск-менеджер' },
        { field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Team Lead Risk Analyst' },
        { field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Тимлид риск-аналитиков' },
      ] },
    ] },
    { not: { field: 'tags', op: 'text_list_matches_any_of', value: ['читер'] } },
    { not: { field: 'employeeStatus', op: 'string_eq', value: 'Employed' } },
    { not: { field: 'employeeDismissalReasonIsNegative', op: 'bool_eq', value: true } },
  ] },
  exclusions: false,
});

// «БА с секциями»: nested второго уровня + связка специализация+этап в ОДНОМ процессе
golden('БА с секциями', {
  conditions: { all: [
    { same: 'hiringProcesses', children: [
      { field: 'hiringProcesses.specializationId', op: 'string_eq', value: '5df4a0e3-dea7-4ef0-bffd-c8170231d38f' },
      { same: 'hiringProcesses.events', children: [
        { field: 'hiringProcesses.events.plainEventState', op: 'int_eq', value: 77 },
        { field: 'hiringProcesses.events.createdUtc', op: 'date_gt', value: '2023-12-31' },
      ] },
    ] },
    { not: { field: 'employeeStatus', op: 'string_eq', value: 'Employed' } },
    { same: 'resumes', children: [
      { any: [
        { field: 'resumes.declaredSpecialization', op: 'text_phrase', value: 'бизнес-аналитик' },
        { field: 'resumes.declaredSpecialization', op: 'text_phrase', value: 'business analyst' },
      ] },
      { same: 'resumes.workExperience', mode: 'any', children: [
        { field: 'resumes.workExperience.position', op: 'text_phrase', value: 'бизнес-аналитик' },
        { field: 'resumes.workExperience.position', op: 'text_phrase', value: 'business analyst' },
      ] },
    ] },
    { not: { field: 'tags', op: 'text_list_matches_any_of', value: ['читер'] } },
    { not: { field: 'employeeDismissalReasonIsNegative', op: 'bool_eq', value: true } },
    { not: { same: 'facts', children: [{ field: 'facts.employeeDismissalReasonId', op: 'int_one_of', value: [3, 4] }] } },
    { not: { same: 'facts', children: [{ field: 'facts.location', op: 'text_phrase', value: 'Москва' }] } },
  ] },
  exclusions: false,
});

/* ── 3. Fail-closed: движок обязан ОТКАЗАТЬ на мусоре ── */
console.log('\n[4] Fail-closed (движок должен отказать):');
const bad = [
  { name: 'придуманное поле', spec: { conditions: { all: [{ field: 'salary', op: 'int_gt', value: 100 }] }, exclusions: false } },
  { name: 'придуманный оператор', spec: { conditions: { all: [{ field: 'tags', op: 'contains', value: ['x'] }] }, exclusions: false } },
  { name: 'значение вне enum', spec: { conditions: { all: [{ field: 'employeeStatus', op: 'string_eq', value: 'Работает' }] }, exclusions: false } },
  { name: 'нет ответа про исключения', spec: { conditions: { all: [{ field: 'tags', op: 'text_list_matches_any_of', value: ['x'] }] }, exclusions: null } },
  { name: 'неоднозначная специализация', spec: { conditions: { all: [{ field: 'hiringProcesses.specializationId', op: 'string_eq', ref: { kind: 'specialization', query: 'аналитик' } }] }, exclusions: false } },
];
for (const b of bad){
  const r = buildQuery(b.spec);
  if (r.status === 'ok'){ fail++; failures.push({ name: 'fail-closed: ' + b.name, errors: ['движок выдал фильтр, а должен был отказать'] }); console.log('  ✗', b.name); }
  else { pass++; console.log('  ✓', b.name, '→', r.status); }
}

/* ── 4. Разрешение справочников ── */
console.log('\n[5] Разрешение ref по справочникам:');
const refTests = [
  { name: 'этап «техническое интервью пройдено» → int-коды', spec: { conditions: { all: [
      { field: 'hiringProcesses.events.plainEventState', op: 'int_one_of', ref: { kind: 'stage', query: 'Техническое интервью Пройдено' } },
    ] }, exclusions: false }, check: r => r.status === 'ok' },
  { name: 'причина «не подходит по софтам» → код 2', spec: { conditions: { all: [
      { field: 'hiringProcesses.closingReasonsIds', op: 'int_list_contains_any_of', ref: { kind: 'closingReason', query: 'софтам' } },
    ] }, exclusions: false }, check: r => r.status === 'ok' && JSON.stringify(r.filter).includes('[2]') },
  { name: 'enum Dismissed → строка "Dismissed"', spec: { conditions: { all: [
      { field: 'employeeStatus', op: 'string_eq', ref: { kind: 'enum', enum: 'employeeStatus', query: 'Dismissed' } },
    ] }, exclusions: false }, check: r => r.status === 'ok' && JSON.stringify(r.filter).includes('"Dismissed"') },
];
for (const t of refTests){
  const r = buildQuery(t.spec);
  if (t.check(r)){ pass++; console.log('  ✓', t.name); }
  else { fail++; failures.push({ name: t.name, errors: [JSON.stringify(r).slice(0, 300)] }); console.log('  ✗', t.name, '→', r.status, JSON.stringify(r.errors || r.questions || '').slice(0, 200)); }
}

console.log(`\nИтого: ✓ ${pass}  ⚠ ${warn}  ✗ ${fail}`);
if (failures.length){ console.log('\nПровалы:'); failures.forEach(f => console.log('-', f.name, '::', f.errors[0])); process.exitCode = 1; }

/* ── 5. Диалоговый цикл (CJM V1): clarify → ответ рекрутера → ok, без LLM ── */
console.log('\n[6] Диалог: доуточнение без LLM:');
const { applyAnswer, parseChoice, parseYesNo } = require('./dialog');
{
  // неоднозначная специализация + не задан ответ про исключения
  const spec = { conditions: { all: [
    { intent: 'специализация «продуктовый аналитик»', field: 'hiringProcesses.specializationId', op: 'string_eq', ref: { kind: 'specialization', query: 'продуктовый аналитик' } },
  ] }, exclusions: null };
  const r1 = buildQuery(spec);
  const choice = (r1.questions || []).find(q => q.type === 'choice');
  if (r1.status !== 'clarify' || !choice){ fail++; console.log('  ✗ первый круг не дал выбор варианта'); }
  else {
    pass++; console.log('  ✓ первый круг →', r1.questions.length, 'вопроса(ов), вариантов:', choice.options.length);
    const session = { pending: { spec: r1.spec, questions: r1.questions } };
    const ok = applyAnswer(session, 'первый вариант, исключения нужны');
    const r2 = buildQuery(session.pending.spec);
    if (ok && r2.status === 'ok' && JSON.stringify(r2.filter).includes('"читер"')){
      pass++; console.log('  ✓ ответ «первый вариант, исключения нужны» → фильтр собран с блоком исключений');
    } else { fail++; failures.push({name:'диалог: применение ответа',errors:[JSON.stringify(r2.errors||r2.questions||'').slice(0,200)]}); console.log('  ✗ ответ не применился:', r2.status); }
  }
  // множественный выбор переключает оператор на string_one_of
  const spec2 = { conditions: { all: [
    { intent: 'аналитики', field: 'hiringProcesses.specializationId', op: 'string_eq', ref: { kind: 'specialization', query: 'продуктовый аналитик' } },
  ] }, exclusions: false };
  const r3 = buildQuery(spec2);
  const s2 = { pending: { spec: r3.spec, questions: r3.questions } };
  if (r3.status === 'clarify' && (r3.questions[0].options || []).length > 1 && applyAnswer(s2, '1 и 2')){
    const r4 = buildQuery(s2.pending.spec);
    if (r4.status === 'ok' && JSON.stringify(r4.filter).includes('string_one_of')){ pass++; console.log('  ✓ «1 и 2» → оператор переключён на string_one_of'); }
    else { fail++; failures.push({name:'диалог: множественный выбор',errors:[r4.status]}); console.log('  ✗ множественный выбор:', r4.status); }
  } else { warn++; console.log('  ⚠ множественный выбор: вариантов меньше двух, кейс пропущен'); }
  // парсеры
  const pOk = parseYesNo('да, исключи') === true && parseYesNo('нет, не нужно') === false
    && JSON.stringify(parseChoice('вариант 2', [{label:'a',value:1},{label:'b',value:2}])) === '[1]';
  if (pOk){ pass++; console.log('  ✓ парсеры ответов (да/нет, номер варианта)'); }
  else { fail++; failures.push({name:'парсеры ответов',errors:['неверный разбор']}); console.log('  ✗ парсеры ответов'); }
}

console.log(`\nИтого с диалогом: ✓ ${pass}  ⚠ ${warn}  ✗ ${fail}`);
