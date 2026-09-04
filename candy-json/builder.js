// Сборка и валидация JSON-фильтра Candy.
// DSL дерева условий:
//   { field:'hiringProcesses.specializationId', op:'string_eq', value:'…' }   — лист
//   { all:[…] } → $and    { any:[…] } → $or    { not:{…} } → $not
//   { same:'hiringProcesses', mode:'all'|'any', children:[…] }
//     — условия ОДНОГО вложенного объекта: собираются внутри одного nested_any
//       (контейнер — dotted-путь nested-контейнеров, напр. 'resumes.workExperience')
// Пути полей — всегда полные от Candidate (как в model_fields.json).
'use strict';
const kb = require('./kb');
const { checkOperatorFor, wrapValue, opSpec } = require('./operators');

class BuildError extends Error {
  constructor(msg, node){ super(msg); this.node = node; }
}

// {seg:{nested_any:{filter: inner}}} по цепочке контейнеров, изнутри наружу
function wrapChain(segs, inner){
  let obj = inner;
  for (let i = segs.length - 1; i >= 0; i--){
    obj = { [segs[i]]: { nested_any: { filter: obj } } };
  }
  return obj;
}

function isPrefix(prefix, arr){
  return prefix.every((s, i) => arr[i] === s);
}

/* Сборка узла DSL в фрагмент фильтра.
 * baseChain — nested-контекст, внутри которого уже находимся (для same-групп). */
function buildNode(node, baseChain = []){
  if (!node || typeof node !== 'object') throw new BuildError('пустой узел DSL', node);

  if (Array.isArray(node.all)) return { $and: node.all.map(n => buildNode(n, baseChain)) };
  if (Array.isArray(node.any)) return { $or: node.any.map(n => buildNode(n, baseChain)) };
  if (node.not) return { $not: buildNode(node.not, baseChain) };

  if (node.same){
    const segs = String(node.same).split('.');
    if (!isPrefix(baseChain, segs))
      throw new BuildError(`same-группа «${node.same}» не вложена в текущий контекст «${baseChain.join('.')}»`, node);
    const rel = segs.slice(baseChain.length);
    if (!Array.isArray(node.children) || !node.children.length)
      throw new BuildError(`same-группа «${node.same}» без children`, node);

    // Корневые поля кандидата модель иногда кладёт внутрь same-группы (например levels
    // в hiringProcesses). Внутри nested_any им не место, поэтому выносим их наружу,
    // а не отвергаем спеку: смысл условия сохраняется.
    const inGroup = [], outside = [];
    for (const child of node.children){
      const f = child && child.field ? kb.resolveField(child.field) : null;
      (f && f.root ? outside : inGroup).push(child);
    }
    if (!inGroup.length) return { $and: outside.map(n => buildNode(n, baseChain)) };

    const combined = inGroup.length === 1
      ? buildNode(inGroup[0], segs)
      : (node.mode === 'any'
          ? { $or: inGroup.map(n => buildNode(n, segs)) }
          : { $and: inGroup.map(n => buildNode(n, segs)) });
    const grouped = wrapChain(rel, combined);
    return outside.length
      ? { $and: [grouped, ...outside.map(n => buildNode(n, baseChain))] }
      : grouped;
  }

  if (node.field){
    const f = kb.resolveField(node.field);
    if (!f) throw new BuildError(`поле «${node.field}» не найдено в модели полей`, node);
    // Перечисление вариантов под одиночным оператором раскрывается в $or (см. ниже),
    // поэтому и оператор проверяем на отдельном значении, а не на всём массиве.
    if (!node.expand && Array.isArray(node.value)){
      const spec = opSpec(node.op);
      if (spec && spec.arity === 'one'){
        if (node.value.length === 1) node.value = node.value[0];
        else node.expand = true;
      }
    }
    const chk = checkOperatorFor(f.docName, f.leafKey, node.op, node.expand ? node.value[0] : node.value);
    if (!chk.ok) throw new BuildError(`${node.field}: ${chk.reason}` + (chk.allowed.length ? `; допустимы: ${chk.allowed.join(', ')}` : ''), node);
    // Корневое поле, ошибочно помещённое моделью в same-группу, не ломаем, а поднимаем
    // на корень: смысл условия от этого не меняется (у корневых полей нет nested-контекста),
    // а отказ ради формальности заставил бы рекрутера переформулировать верный запрос.
    if (!isPrefix(baseChain, f.nestedChain)){
      if (f.root) return { [f.leafKey]: { [node.op]: wrapValue(node.op, node.value) } };
      throw new BuildError(`поле «${node.field}» (контекст ${f.nestedChain.join('.') || 'root'}) не принадлежит группе «${baseChain.join('.')}»`, node);
    }
    const rel = f.nestedChain.slice(baseChain.length);
    // expand: одиночный оператор + набор значений из справочника → $or по каждому
    // (так устроены боевые подборки: 14 банков — это 14 веток text_phrase)
    const cond = node.expand
      ? { $or: node.value.map(v => ({ [f.leafKey]: { [node.op]: wrapValue(node.op, v) } })) }
      : { [f.leafKey]: { [node.op]: wrapValue(node.op, node.value) } };
    return wrapChain(rel, cond);
  }

  throw new BuildError('неизвестный тип узла DSL: ' + JSON.stringify(Object.keys(node)), node);
}

/* Схлопывание вложенных однотипных групп: {$or:[{$or:[a,b]},c]} → {$or:[a,b,c]},
 * и {$and:[x]} → x. Семантика не меняется, но JSON становится таким же плоским,
 * как в боевых подборках — меньше поводов для несовместимости на стороне поиска. */
function flatten(node){
  if (Array.isArray(node)) return node.map(flatten);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, val] of Object.entries(node)){
    if (key === '$and' || key === '$or'){
      const items = [];
      for (const child of val.map(flatten)){
        const keys = child && typeof child === 'object' ? Object.keys(child) : [];
        // вложенная группа того же типа вливается в родительскую
        if (keys.length === 1 && keys[0] === key) items.push(...child[key]);
        else items.push(child);
      }
      // группа из одного условия — это само условие
      if (items.length === 1) return items[0];
      out[key] = items;
    } else if (val && typeof val === 'object'){
      out[key] = flatten(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/* Стандартный блок исключений из промпта:
 * сотрудники, читеры, негативная причина увольнения, критичные причины в фактах. */
function exclusionBlocks(){
  return [
    { not: { field: 'employeeStatus', op: 'string_eq', value: 'Employed' } },
    { not: { field: 'tags', op: 'text_list_matches_any_of', value: ['читер'] } },
    { not: { field: 'employeeDismissalReasonIsNegative', op: 'bool_eq', value: true } },
    { not: { same: 'facts', children: [
        { field: 'facts.employeeDismissalReasonId', op: 'int_one_of', value: [3, 4] },
    ] } },
  ];
}

/* ── Валидатор произвольного фильтра (регресс по боевым пресетам) ──
 * Обходит готовый JSON и сверяет каждый ключ с моделью, каждый оператор — с реестром. */
function validateFilter(filter, docName = kb.model.rootDocument, path = '$', errors = []){
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)){
    errors.push(`${path}: ожидался объект-фильтр`);
    return errors;
  }
  for (const [key, val] of Object.entries(filter)){
    const p = `${path}.${key}`;
    if (key.startsWith('#')) continue; // #name/#description — метаданные, разрешены схемой
    if (key === '$and' || key === '$or'){
      if (!Array.isArray(val)) { errors.push(`${p}: ожидался массив`); continue; }
      val.forEach((v, i) => validateFilter(v, docName, `${p}[${i}]`, errors));
    } else if (key === '$not'){
      validateFilter(val, docName, p, errors);
    } else {
      const doc = kb.model.documents[docName];
      const f = doc && doc.fields[key];
      if (!f){ errors.push(`${p}: поле «${key}» не найдено в документе ${docName}`); continue; }
      if (f.operatorSet === 'Nested'){
        const na = val && val.nested_any;
        if (!na || !na.filter){ errors.push(`${p}: nested-поле должно иметь структуру {nested_any:{filter:…}}`); continue; }
        validateFilter(na.filter, f.nestedDocument, `${p}.nested_any.filter`, errors);
      } else {
        const ops = Object.keys(val || {});
        if (ops.length !== 1){ errors.push(`${p}: ожидался ровно один оператор, получено: ${ops.join(', ') || 'ничего'}`); continue; }
        const op = ops[0];
        const body = val[op] || {};
        const value = 'values' in body ? body.values : ('value' in body ? body.value : body);
        const chk = checkOperatorFor(docName, key, op, value);
        if (!chk.ok) errors.push(`${p}.${op}: ${chk.reason}`);
      }
    }
  }
  return errors;
}

module.exports = { buildNode, wrapChain, exclusionBlocks, validateFilter, flatten, BuildError };
