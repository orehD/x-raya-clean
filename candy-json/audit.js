// Аудит базы знаний: сверяет справочники между собой и с боевыми подборками.
// Ищет то, что сломает движок в проде: id/коды из реальных фильтров, которых нет
// в справочниках; дубли; расхождения enum между filter.json и «Справочными значениями».
// Запуск: node audit.js
'use strict';
const fs = require('fs');
const path = require('path');
const kb = require('./kb');
const { REG } = require('./operators');

const KB = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', p), 'utf-8'));
const presets = KB('presets.json');
const examples = KB('query_examples.json');
const specs = KB('specializations.json');
const stages = KB('stage_status_codes.json');
const reasons = KB('closing_reasons.json');
const refs = KB('reference_values.json');
const dismissals = KB('dismissal_reasons.json');

let problems = 0;
const say = (ok, msg, detail) => {
  if (!ok) problems++;
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail ? '\n      ' + detail : ''}`);
};

/* Собираем все значения, реально использованные в боевых фильтрах */
const used = { spec: new Set(), stage: new Set(), closing: new Set(), status: new Set(), eduLevel: new Set(), dismissal: new Set() };
function harvest(f, docPath = ''){
  if (!f || typeof f !== 'object') return;
  for (const [k, v] of Object.entries(f)){
    if (k.startsWith('#')) continue;
    if (k === '$and' || k === '$or'){ (v || []).forEach(x => harvest(x, docPath)); continue; }
    if (k === '$not'){ harvest(v, docPath); continue; }
    if (v && v.nested_any){ harvest(v.nested_any.filter, docPath ? docPath + '.' + k : k); continue; }
    const op = Object.keys(v || {})[0];
    if (!op) continue;
    const body = v[op] || {};
    const vals = 'values' in body ? body.values : ('value' in body ? [body.value] : []);
    const full = docPath ? docPath + '.' + k : k;
    for (const x of vals){
      if (k === 'specializationId' || k === 'specializationsIds') used.spec.add(x);
      else if (k === 'plainEventState') used.stage.add(x);
      else if (k === 'closingReasonsIds') used.closing.add(x);
      else if (k === 'employeeStatus') used.status.add(x);
      else if (k === 'educationLevel') used.eduLevel.add(x);
      else if (full.endsWith('employeeDismissalReasonId')) used.dismissal.add(x);
    }
  }
}
for (const src of [presets, examples]) for (const it of src){
  const f = it.filter;
  if (f && !f._parse_error) harvest(f);
}

console.log('\n[1] Ссылочная целостность: значения из боевых подборок ↔ справочники');
const specIds = new Set(specs.map(s => s.recruitment_stream_specialization_id));
const missSpec = [...used.spec].filter(x => !specIds.has(x));
say(!missSpec.length, `специализации: использовано ${used.spec.size}, найдено ${used.spec.size - missSpec.length}`,
  missSpec.length ? 'НЕТ в справочнике: ' + missSpec.join(', ') : '');

// Справочник этапов полон для целей движка: коды вне него — legacy из старых
// боевых подборок, для новых используются только коды из «Коды этапов и статусов».
const actualStages = new Set(stages.filter(s => !s.legacy).map(s => s.code));
const legacyStages = new Set(stages.filter(s => s.legacy).map(s => s.code));
const unknownStage = [...used.stage].filter(x => !actualStages.has(x) && !legacyStages.has(x));
const legacyUsed = [...used.stage].filter(x => legacyStages.has(x));
say(!unknownStage.length, `коды этапов: использовано ${used.stage.size}, из них актуальных ${used.stage.size - legacyUsed.length}, legacy ${legacyUsed.length}`,
  unknownStage.length ? 'неизвестные коды: ' + unknownStage.sort((a, b) => a - b).join(', ') : '');

const reasonCodes = new Set(reasons.map(r => r.code));
const missReason = [...used.closing].filter(x => !reasonCodes.has(x));
say(!missReason.length, `причины закрытия: использовано ${used.closing.size}, найдено ${used.closing.size - missReason.length}`,
  missReason.length ? 'НЕТ в справочнике: ' + missReason.join(', ') : '');

const dismissIds = new Set(dismissals.map(d => d.id));
const missDismiss = [...used.dismissal].filter(x => !dismissIds.has(x));
say(!missDismiss.length, `причины увольнения (people-hub): использовано ${used.dismissal.size}`,
  missDismiss.length ? 'НЕТ в справочнике: ' + missDismiss.join(', ') : '');

console.log('\n[2] Enum: filter.json ↔ «Справочные значения»');
const pairs = [['EmployeeStatusType', 'employeeStatus'], ['Gender', 'gender'], ['ContactType', 'contactType'],
  ['EducationLevel', 'educationLevel'], ['SpeechEvaluationResult', 'speechEvaluationResult'],
  ['MeetupOccupation', 'meetupOccupationType'], ['MeetupExperience', 'meetupExperienceType']];
for (const [schemaEnum, refKey] of pairs){
  const inSchema = REG.enums[schemaEnum] || [];
  const inRef = Object.keys(refs[refKey] || {});
  const onlySchema = inSchema.filter(x => !inRef.includes(x));
  const onlyRef = inRef.filter(x => !inSchema.includes(x));
  say(!onlySchema.length && !onlyRef.length, `${schemaEnum}: ${inSchema.length} значений`,
    [onlySchema.length ? 'только в filter.json: ' + onlySchema.join(', ') : '',
     onlyRef.length ? 'только в справочнике: ' + onlyRef.join(', ') : ''].filter(Boolean).join(' | '));
}
// значения статусов из боевых фильтров должны входить в enum
const badStatus = [...used.status].filter(x => !(REG.enums.EmployeeStatusType || []).includes(x));
say(!badStatus.length, `employeeStatus в подборках: ${[...used.status].join(', ') || '—'}`,
  badStatus.length ? 'вне enum: ' + badStatus.join(', ') : '');

console.log('\n[3] Дубли и целостность справочников');
const dup = (arr, key) => {
  const c = {}; arr.forEach(x => { const k = typeof key === 'function' ? key(x) : x[key]; c[k] = (c[k] || 0) + 1; });
  return Object.entries(c).filter(([, n]) => n > 1);
};
const dupSpecId = dup(specs, 'recruitment_stream_specialization_id');
say(!dupSpecId.length, `специализации: ${specs.length} записей, id уникальны`, dupSpecId.map(([k, n]) => `${k}×${n}`).join(', '));
const dupSpecName = dup(specs.filter(s => s.status === 'Активная'), 'name');
say(!dupSpecName.length, 'активные специализации: имена уникальны',
  dupSpecName.length ? 'дубли имён (движок будет спрашивать выбор): ' + dupSpecName.map(([k, n]) => `${k}×${n}`).join('; ') : '');
const dupStage = dup(stages, 'code');
say(!dupStage.length, `этапы: ${stages.length} кодов уникальны`, dupStage.map(([k, n]) => `${k}×${n}`).join(', '));
const dupReason = dup(reasons, 'code');
say(!dupReason.length, `причины закрытия: ${reasons.length} кодов уникальны`, dupReason.map(([k, n]) => `${k}×${n}`).join(', '));

console.log('\n[4] Модель полей ↔ filter.json');
let modelOnly = [], schemaOnly = [];
for (const [docName, doc] of Object.entries(kb.model.documents)){
  const schemaDoc = REG.fields[docName] || {};
  for (const [key, f] of Object.entries(doc.fields)){
    if (f.operatorSet === 'Nested') continue;
    if (!schemaDoc[key]) modelOnly.push(`${docName}.${key}`);
  }
  for (const key of Object.keys(schemaDoc)){
    if (key === 'Filter') continue;
    if (!doc.fields[key]) schemaOnly.push(`${docName}.${key}`);
  }
}
say(!modelOnly.length, `поля модели присутствуют в filter.json`, modelOnly.length ? 'нет в схеме: ' + modelOnly.join(', ') : '');
say(!schemaOnly.length, `поля filter.json присутствуют в модели`, schemaOnly.length ? 'нет в модели: ' + schemaOnly.join(', ') : '');

console.log('\n[5] Разрешимость: находит ли движок то, что нужно боевым подборкам');
const unresolvable = [];
for (const id of used.spec){
  const s = kb.specializationById(id);
  if (!s) continue;
  const hits = kb.findSpecializations(s.name);
  if (!hits.some(h => h.id === id)) unresolvable.push(`${s.name} (${s.status})`);
}
say(!unresolvable.length, `поиск по названию находит все ${used.spec.size} использованных специализаций`,
  unresolvable.length ? 'не находятся по своему же имени: ' + unresolvable.join('; ') : '');

// Проверяем только актуальные коды: legacy намеренно выведены из поиска,
// чтобы новые подборки собирались из справочника, а не из старых значений.
const stageUnres = [];
for (const code of used.stage){
  const s = kb.stageStatusByCode(code);
  if (!s || s.legacy) continue;
  const hits = kb.findStageStatuses(`${s.stage} ${s.status}`);
  if (!hits.some(h => h.code === code)) stageUnres.push(`${s.stage}/${s.status}=${code}`);
}
say(!stageUnres.length, `поиск по названию находит актуальные этапы из подборок`,
  stageUnres.length ? 'не находятся: ' + stageUnres.slice(0, 10).join('; ') : '');

console.log('\n[6] Группы значений (value_groups.json)');
try {
  const vg = KB('value_groups.json');
  const empty = Object.entries({ ...vg.valueGroups, ...vg.roleVariants }).filter(([, g]) => !g.values || !g.values.length);
  say(!empty.length, `групп значений ${Object.keys(vg.valueGroups).length}, наборов ролей ${Object.keys(vg.roleVariants).length}`,
    empty.length ? 'пустые: ' + empty.map(([k]) => k).join(', ') : '');
} catch (e){ say(false, 'value_groups.json не читается', e.message); }

console.log(`\n${problems ? '✗ проблем: ' + problems : '✓ база знаний согласована'}`);
process.exitCode = problems ? 1 : 0;
