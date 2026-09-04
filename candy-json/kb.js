// База знаний Candy: загрузка справочников из ../candy-kb и разрешение полей по модели.
// Единственная точка доступа к данным — движок не знает про файлы напрямую.
'use strict';
const fs = require('fs');
const path = require('path');

const KB_DIR = path.join(__dirname, '..', 'candy-kb');

function load(name){
  return JSON.parse(fs.readFileSync(path.join(KB_DIR, name), 'utf-8'));
}

const model = load('model_fields.json');
const stages = load('stage_status_codes.json');
const closingReasons = load('closing_reasons.json');
const refValues = load('reference_values.json');
const specializations = load('specializations.json');
const dismissalReasons = load('dismissal_reasons.json');
const presets = load('presets.json');
const valueGroupsFile = load('value_groups.json');

/* ── Разрешение поля по модели ──
 * resolveField('hiringProcesses.events.plainEventState') →
 * {
 *   path, operatorSet:'Int', enumType:null, title,
 *   source:'Candidate.hiringProcesses[].events[]',
 *   nestedChain:['hiringProcesses','events'],   // контейнеры nested_any по порядку
 *   leafKey:'plainEventState',                  // ключ внутри последнего filter
 *   root:false
 * }
 * Корневое поле → nestedChain:[], leafKey=path, root:true.
 * Не найдено → null (fail-closed решает вызывающий).
 */
function resolveField(fieldPath){
  const parts = String(fieldPath).split('.');
  let docName = model.rootDocument;
  let doc = model.documents[docName];
  const nestedChain = [];
  let source = model.rootDocument;
  for (let i = 0; i < parts.length; i++){
    const key = parts[i];
    const f = doc.fields[key];
    if (!f) return null;
    const last = i === parts.length - 1;
    if (f.operatorSet === 'Nested'){
      if (last) {
        // фильтровать по самому контейнеру нельзя — только по полям внутри
        return null;
      }
      nestedChain.push(key);
      source += '.' + key + '[]';
      docName = f.nestedDocument;
      doc = model.documents[docName];
      if (!doc) return null;
    } else {
      if (!last) return null; // скаляр в середине пути — путь неверный
      return {
        path: fieldPath,
        docName,
        operatorSet: f.operatorSet,
        enumType: f.enumType || null,
        title: f.title,
        source,
        nestedChain,
        leafKey: key,
        root: nestedChain.length === 0,
      };
    }
  }
  return null;
}

/* Поиск поля по всем документам: где встречается leaf-ключ или заголовок.
 * Нужно для уточнений «специализация есть в N источниках». */
function findFieldEverywhere(needle){
  const n = String(needle).toLowerCase();
  const hits = [];
  const walk = (docName, prefix, sourcePrefix, depth) => {
    if (depth > 3) return;
    const doc = model.documents[docName];
    if (!doc) return;
    for (const [key, f] of Object.entries(doc.fields)){
      const p = prefix ? prefix + '.' + key : key;
      if (f.operatorSet === 'Nested'){
        walk(f.nestedDocument, p, sourcePrefix + '.' + key + '[]', depth + 1);
      } else if (key.toLowerCase() === n || key.toLowerCase().includes(n) || (f.title||'').toLowerCase().includes(n)){
        hits.push({ path: p, title: f.title, operatorSet: f.operatorSet, source: sourcePrefix + (prefix ? '' : ''), enumType: f.enumType || null });
      }
    }
  };
  walk(model.rootDocument, '', 'Candidate', 0);
  return hits;
}

/* ── Справочники ── */

// Нормализация: регистр, ё, дефисы. Русские слова стеммим грубо (отсекаем окончание),
// чтобы «риски» находило «риск», а «аналитики» — «аналитик».
function norm(s){
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[-–—_/]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Синонимы RU→EN: в справочнике специализации часто записаны латиницей.
const SYNONYMS = {
  'тимлид': 'team lead', 'тимлида': 'team lead', 'тимлиды': 'team lead', 'лид': 'lead',
  'джава': 'java', 'джавист': 'java', 'джависты': 'java', 'явист': 'java',
  'питон': 'python', 'питонист': 'python', 'пайтон': 'python',
  'разработчик': 'developer', 'разраб': 'developer', 'программист': 'developer',
  'аналитик': 'analyst', 'дизайнер': 'designer', 'тестировщик': 'qa',
  'фронтенд': 'frontend', 'бэкенд': 'backend', 'бекенд': 'backend',
  'продакт': 'product', 'проджект': 'project', 'скала': 'scala', 'котлин': 'kotlin',
};
function expand(q){
  const n = norm(q);
  const extra = [];
  for (const [ru, en] of Object.entries(SYNONYMS)) if (n.includes(ru)) extra.push(en);
  return { n, variants: [n, ...extra] };
}
// Стем русского слова: слова длиннее 5 символов режем на 2 буквы с конца (риски→рис|к…).
function stem(w){
  if (w.length <= 4 || !/[а-я]/.test(w)) return w;
  return w.slice(0, Math.max(4, w.length - 2));
}
function tokensOf(q){ return norm(q).split(' ').filter(w => w.length > 1).map(stem); }

/* Специализации: ранжированный поиск.
 * Совпадение по названию всегда важнее совпадения по стриму — иначе запрос «java»
 * вытаскивал бы все специализации стрима JavaScript. */
function findSpecializations(query, { onlyActive = true, limit = 8 } = {}){
  const { variants } = expand(query);
  const toks = [...new Set(variants.flatMap(v => tokensOf(v)))];
  const pool = specializations.filter(s => !onlyActive || s.status === 'Активная');
  const scored = [];
  for (const s of pool){
    const name = norm(s.name), stream = norm(s.recruitment_stream || '');
    let score = 0;
    for (const v of variants){
      if (name === v) score = Math.max(score, 100);
      else if (name.startsWith(v)) score = Math.max(score, 80);
      else if (name.includes(v)) score = Math.max(score, 60);
    }
    if (!score){
      const inName = toks.filter(t => name.includes(t)).length;
      if (inName === toks.length && toks.length) score = 50;
      else if (inName) score = 20 + inName * 5;
    }
    // стрим — слабый сигнал: добавляем очки, но никогда не поднимаем выше совпадений по имени
    if (variants.some(v => stream.includes(v)) || toks.every(t => stream.includes(t))) score += 5;
    if (score >= 20) scored.push({ score, id: s.recruitment_stream_specialization_id, name: s.name, stream: s.recruitment_stream, status: s.status });
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  // если есть сильные совпадения (по названию), слабые не показываем
  const top = scored.length && scored[0].score >= 50 ? scored.filter(x => x.score >= 50) : scored;
  return top.slice(0, limit).map(({ score, ...rest }) => rest);
}

function specializationById(id){
  const s = specializations.find(x => x.recruitment_stream_specialization_id === id);
  return s ? { id, name: s.name, stream: s.recruitment_stream, status: s.status } : null;
}

// Этапы/статусы: поиск по этапу и/или статусу («скрининг пройден» → коды).
// legacy-коды (встречаются в старых подборках, но отсутствуют в актуальном
// справочнике) в выдачу не попадают — новые подборки собираем только из актуальных.
function findStageStatuses(query){
  const q = String(query).toLowerCase();
  return stages.filter(s => !s.legacy).filter(s =>
    (s.stage + ' ' + s.status + ' ' + s.techName).toLowerCase().includes(q) ||
    q.includes(s.stage.toLowerCase())
  );
}
function stageStatusByCode(code){ return stages.find(s => s.code === Number(code)) || null; }

// Причины закрытия процесса отбора.
function findClosingReasons(query){
  const q = String(query).toLowerCase();
  return closingReasons.filter(r => !r.obsolete && (r.description + ' ' + r.techName).toLowerCase().includes(q));
}
function closingReasonByCode(code){ return closingReasons.find(r => r.code === Number(code)) || null; }

// Enum-справочники (гражданство, пол, тип контакта, статус сотрудника…)
function refEnum(name){ return refValues[name] || null; }
function refLookup(enumName, key){
  const e = refValues[enumName];
  if (!e || Array.isArray(e)) return null;
  if (key in e) return { key, value: e[key] };
  const hit = Object.entries(e).find(([k]) => k.toLowerCase() === String(key).toLowerCase());
  return hit ? { key: hit[0], value: hit[1] } : null;
}

// Причины увольнения people-hub.
function findDismissalReasons(query){
  const q = String(query).toLowerCase();
  return dismissalReasons.filter(r => r.name.toLowerCase().includes(q));
}

/* ── Готовые наборы значений из боевых подборок ──
 * Списки банков, топ-вузов, уровней английского, варианты написания ролей и наборы
 * кодов этапов рекрутеры уже выверили на практике. Движок подставляет их целиком,
 * поэтому модели не приходится выдумывать варианты — это главный источник точности.
 */
const GROUP_KINDS = { valueGroup: 'valueGroups', roleVariants: 'roleVariants', stageGroup: 'stageGroups' };

function findValueGroup(kind, query){
  const bucket = valueGroupsFile[GROUP_KINDS[kind]] || {};
  const q = norm(query);
  const qtoks = tokensOf(query);
  const scored = [];
  for (const [key, g] of Object.entries(bucket)){
    const hay = [key, g.title, ...(g.aliases || [])].map(norm);
    let score = 0;
    for (const h of hay){
      if (h === q) score = Math.max(score, 100);
      else if (h.includes(q) || q.includes(h)) score = Math.max(score, 70);
      else {
        const toks = tokensOf(h);
        const hit = qtoks.filter(t => toks.some(x => x.startsWith(t) || t.startsWith(x))).length;
        if (hit && hit >= Math.min(qtoks.length, toks.length)) score = Math.max(score, 40 + hit * 5);
      }
    }
    if (score) scored.push({ score, key, title: g.title, values: g.values });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored; // score оставляем: вызывающий решает, считать ли выбор неоднозначным
}

function listGroups(){
  const out = {};
  for (const [kind, bucket] of Object.entries(GROUP_KINDS))
    out[kind] = Object.entries(valueGroupsFile[bucket] || {}).map(([k, g]) => ({ key: k, title: g.title, size: (g.values || []).length }));
  return out;
}

module.exports = {
  KB_DIR, model, stages, closingReasons, refValues, specializations, dismissalReasons, presets,
  resolveField, findFieldEverywhere,
  findSpecializations, specializationById,
  findStageStatuses, stageStatusByCode,
  findClosingReasons, closingReasonByCode,
  refEnum, refLookup, findDismissalReasons,
  findValueGroup, listGroups, valueGroups: valueGroupsFile,
};
