// Field Resolution (fail-closed): превращает DSL-спеку со ссылками на справочники
// в DSL с конкретными literal-значениями + таблицу проверки, как в промпте ассистента.
//
// Лист DSL может вместо value нести ref — запрос в справочник:
//   { field:'hiringProcesses.specializationId', op:'string_eq',
//     ref:{ kind:'specialization', query:'бизнес-аналитик' } }
// Виды ref:
//   specialization — поиск в specializations.json (id или список вариантов)
//   stage          — поиск в stage_status_codes.json (коды plainEventState)
//   closingReason  — поиск в closing_reasons.json (коды причин)
//   enum           — reference_values.json: {kind:'enum', enum:'employeeStatus', query:'Employed'}
// Правило значений: String-поля получают ИМЯ enum-значения ("Employed", "Higher"),
// Int-поля — числовой код (наблюдение по боевым пресетам).
'use strict';
const kb = require('./kb');
const { checkOperatorFor, allowedOpsFor, opSpec } = require('./operators');

const STATUS = { OK: 'найдено', MISSING: 'не найдено', AMBIGUOUS: 'неоднозначно' };

function entryBase(node, f){
  return {
    condition: node.intent || `${node.field} ${node.op}`,
    source: f ? f.source : '—',
    type: f ? (f.root ? 'root' : 'nested') : '—',
    nestedContext: f ? f.nestedChain.join('.') || '—' : '—',
    field: node.field,
    filterKey: f ? f.leafKey : '—',
    operatorSet: f ? f.operatorSet : '—',
    operator: node.op,
    refFile: null, refHit: null,
    value: undefined,
    placement: f ? [...f.nestedChain.flatMap(s => [s, 'nested_any', 'filter']), f.leafKey].join('.') : '—',
    status: null, note: null, options: null,
  };
}

function isMany(op){ const s = opSpec(op); return s && s.arity === 'many'; }

// Разрешение одного ref → {value(s)} | {ambiguous, options} | {missing, note}
function resolveRef(ref, f, op){
  const wantInt = /^Int/.test(f.operatorSet);
  const many = isMany(op);
  switch (ref.kind) {
    case 'specialization': {
      const hits = kb.findSpecializations(ref.query);
      if (!hits.length) return { missing: true, note: `специализация «${ref.query}» не найдена в справочнике`, file: 'specializations.json' };
      if (!many && hits.length > 1) return { ambiguous: true, options: hits.map(h => ({ label: `${h.name} (${h.stream})`, value: h.id })), file: 'specializations.json' };
      return { value: many ? hits.map(h => h.id) : hits[0].id, hit: hits.map(h => h.name).join(', '), file: 'specializations.json' };
    }
    case 'stage': {
      const hits = kb.findStageStatuses(ref.query);
      if (!hits.length) return { missing: true, note: `этап/статус «${ref.query}» не найден`, file: 'stage_status_codes.json' };
      // этапы почти всегда набор кодов → many-операторы получают все совпадения,
      // одиночные операторы при >1 совпадении требуют уточнения
      if (!many && hits.length > 1) return { ambiguous: true, options: hits.map(h => ({ label: `${h.stage} — ${h.status}`, value: h.code })), file: 'stage_status_codes.json' };
      return { value: many ? hits.map(h => h.code) : hits[0].code, hit: hits.map(h => `${h.stage}/${h.status}=${h.code}`).join(', '), file: 'stage_status_codes.json' };
    }
    case 'closingReason': {
      const hits = kb.findClosingReasons(ref.query);
      if (!hits.length) return { missing: true, note: `причина закрытия «${ref.query}» не найдена`, file: 'closing_reasons.json' };
      if (!many && hits.length > 1) return { ambiguous: true, options: hits.map(h => ({ label: `${h.description} (${h.group})`, value: h.code })), file: 'closing_reasons.json' };
      return { value: many ? hits.map(h => h.code) : hits[0].code, hit: hits.map(h => `${h.description}=${h.code}`).join('; '), file: 'closing_reasons.json' };
    }
    case 'valueGroup': case 'roleVariants': case 'stageGroup': {
      const hits = kb.findValueGroup(ref.kind, ref.query);
      if (!hits.length) return { missing: true, note: `набор «${ref.query}» не найден среди готовых групп значений`, file: 'value_groups.json' };
      // спрашиваем только при действительно равнозначных кандидатах: findValueGroup
      // уже отсортировал по релевантности, и лидер почти всегда очевиден
      if (hits.length > 1 && hits[0].score !== undefined && hits[0].score === hits[1].score)
        return { ambiguous: true, options: hits.slice(0, 5).map(h => ({ label: `${h.title} (${h.values.length} значений)`, value: h.key })), file: 'value_groups.json' };
      const g = hits[0];
      // Группа — всегда набор. Множественный оператор берёт его целиком; одиночный
      // (text_phrase и подобные) движок развернёт в $or по каждому значению — expand.
      return { value: g.values, expand: !many, hit: `${g.title}: ${g.values.length} значений`, file: 'value_groups.json' };
    }
    case 'enum': {
      const hit = kb.refLookup(ref.enum, ref.query);
      if (!hit) return { missing: true, note: `значение «${ref.query}» не найдено в справочнике ${ref.enum}`, file: 'reference_values.json' };
      const v = wantInt ? hit.value : hit.key;
      return { value: many ? [v] : v, hit: `${hit.key}=${hit.value}`, file: 'reference_values.json' };
    }
    default:
      return { missing: true, note: `неизвестный вид справочника: ${ref.kind}` };
  }
}

/* Разрешает один лист DSL. Мутирует node.value при успехе. Возвращает entry таблицы. */
/* Автокоррекция пути: модель регулярно приписывает корневые поля к nested-документу
 * («hiringProcesses.levels» вместо «levels» — уровни агрегируются на кандидате).
 * Если имя поля однозначно существует в модели, чиним путь сами: рекрутер такую
 * ошибку исправить не может, а движок точно знает, где поле живёт. */
function autocorrectPath(fieldPath){
  const leaf = String(fieldPath).split('.').pop();
  const hits = kb.findFieldEverywhere(leaf).filter(h => h.path.split('.').pop() === leaf);
  if (!hits.length) return null;
  // предпочитаем корневое поле, иначе — единственное совпадение
  const root = hits.find(h => !h.path.includes('.'));
  if (root) return root.path;
  return hits.length === 1 ? hits[0].path : null;
}

function resolveLeaf(node){
  let f = kb.resolveField(node.field);
  if (!f){
    const fixed = autocorrectPath(node.field);
    if (fixed && fixed !== node.field){
      const alt = kb.resolveField(fixed);
      if (alt){ node.field = fixed; f = alt; }
    }
  }
  const e = entryBase(node, f);
  if (!f){
    e.status = STATUS.MISSING;
    e.note = `поле «${node.field}» не найдено в модели полей`;
    const near = kb.findFieldEverywhere(node.field.split('.').pop()).slice(0, 5);
    if (near.length) e.options = near.map(h => ({ label: `${h.path} — ${h.title}`, value: h.path }));
    return e;
  }
  // оператор проверяем до значения: если сам оператор не разрешён — стоп
  const allowed = allowedOpsFor(f.docName, f.leafKey);
  if (!allowed.includes(node.op)){
    e.status = STATUS.MISSING;
    e.note = `оператор «${node.op}» не разрешён для поля ${f.docName}.${f.leafKey}` + (allowed.length ? `; доступны: ${allowed.join(', ')}` : '');
    return e;
  }
  if (node.ref){
    const r = resolveRef(node.ref, f, node.op);
    e.refFile = r.file || null;
    if (r.missing){ e.status = STATUS.MISSING; e.note = r.note; return e; }
    if (r.ambiguous){ e.status = STATUS.AMBIGUOUS; e.note = 'несколько вариантов — нужен выбор'; e.options = r.options; return e; }
    node.value = r.value;
    if (r.expand) node.expand = true; // набор значений под одиночный оператор → $or
    e.refHit = r.hit;
  }
  // Массив под одиночным оператором — это не ошибка, а перечисление вариантов
  // («любая из этих должностей»). Разворачиваем в $or, как делают боевые подборки,
  // вместо отказа: модель почти всегда имеет в виду именно это.
  if (!node.expand && Array.isArray(node.value)){
    const spec = opSpec(node.op);
    if (spec && spec.arity === 'one'){
      if (node.value.length === 1) node.value = node.value[0];
      else node.expand = true;
    }
  }
  // при expand оператор проверяем на одном значении: массив здесь — это список веток $or
  const probe = node.expand ? node.value[0] : node.value;
  const chk = checkOperatorFor(f.docName, f.leafKey, node.op, probe);
  if (!chk.ok){ e.status = STATUS.MISSING; e.note = chk.reason; return e; }
  e.value = node.value;
  e.status = STATUS.OK;
  return e;
}

/* Обход дерева DSL: разрешить все листья. Возвращает {entries, ok} */
function resolveSpec(root){
  const entries = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.all)) return node.all.forEach(walk);
    if (Array.isArray(node.any)) return node.any.forEach(walk);
    if (node.not) return walk(node.not);
    if (node.same) return (node.children || []).forEach(walk);
    if (node.field){
      const e = resolveLeaf(node);
      e.leafIndex = entries.length; // стабильный id листа (DFS-порядок) — для диалоговых доуточнений
      entries.push(e);
    }
  };
  walk(root);
  return { entries, ok: entries.every(e => e.status === STATUS.OK) };
}

/* n-й лист спеки в том же DFS-порядке, что resolveSpec (для патча ответом рекрутера) */
function leafAt(root, index){
  let i = 0, found = null;
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node.all)) return node.all.forEach(walk);
    if (Array.isArray(node.any)) return node.any.forEach(walk);
    if (node.not) return walk(node.not);
    if (node.same) return (node.children || []).forEach(walk);
    if (node.field){ if (i === index) found = node; i++; }
  };
  walk(root);
  return found;
}

// Markdown-таблица проверки (формат из промпта ассистента) — для прозрачности в UI.
function tableMarkdown(entries){
  const head = '| Условие | Источник | Тип | Nested-контекст | Поле | Ключ в filter | operatorSet | Оператор | Справочник | Значение | Размещение | Статус |';
  const sep = '|' + '---|'.repeat(12);
  const rows = entries.map(e => `| ${e.condition} | ${e.source} | ${e.type} | ${e.nestedContext} | ${e.field} | ${e.filterKey} | ${e.operatorSet} | ${e.operator} | ${e.refFile ? e.refFile + (e.refHit ? ': ' + e.refHit : '') : '—'} | ${e.value !== undefined ? JSON.stringify(e.value) : '—'} | ${e.placement} | ${e.status}${e.note ? ' — ' + e.note : ''} |`);
  return [head, sep, ...rows].join('\n');
}

module.exports = { resolveSpec, resolveLeaf, leafAt, tableMarkdown, STATUS };
