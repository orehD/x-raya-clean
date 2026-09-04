// Реестр операторов — канонический, из filter.json (JSON Schema поиска Candy).
// Извлечён в candy-kb/filter_schema_registry.json:
//   operators: имя → {arity: one|many|range, valueType}
//   fields:    Документ → поле → {ops:[…], nested, enum?}
//   enums:     EnumName → допустимые строковые значения
// Проверка оператора идёт ПО ПОЛЮ (точнее, чем по operatorSet из модели).
'use strict';
const fs = require('fs');
const path = require('path');

const REG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', 'filter_schema_registry.json'), 'utf-8'));

const TYPE_CHECK = {
  string: v => typeof v === 'string',
  integer: v => Number.isInteger(v),
  boolean: v => typeof v === 'boolean',
  any: () => true,
};

function opSpec(op){ return REG.operators[op] || null; }
function allowedOpsFor(docName, fieldKey){
  const doc = REG.fields[docName];
  return (doc && doc[fieldKey] && doc[fieldKey].ops) || [];
}
function fieldEnum(docName, fieldKey){
  const doc = REG.fields[docName];
  const e = doc && doc[fieldKey] && doc[fieldKey].enum;
  return e ? { name: e, values: REG.enums[e] || [] } : null;
}

/* Трёхступенчатая проверка: оператор существует → разрешён для поля → значение совместимо
 * (тип, форма value/values/from-to, enum-значения). */
function checkOperatorFor(docName, fieldKey, op, value){
  const spec = opSpec(op);
  const allowed = allowedOpsFor(docName, fieldKey);
  if (!spec) return { ok: false, reason: `оператор «${op}» отсутствует в filter.json`, allowed };
  if (!allowed.includes(op)) return { ok: false, reason: `оператор «${op}» не разрешён для поля ${docName}.${fieldKey}`, allowed };

  const en = fieldEnum(docName, fieldKey);
  const typeOk = TYPE_CHECK[spec.valueType] || TYPE_CHECK.any;
  const checkOne = (v) => {
    if (!typeOk(v)) return `значение ${JSON.stringify(v)} не подходит по типу (нужен ${spec.valueType})`;
    if (en && !en.values.includes(v)) return `значение ${JSON.stringify(v)} не входит в enum ${en.name}: ${en.values.join(', ')}`;
    return null;
  };

  if (spec.arity === 'many'){
    if (!Array.isArray(value) || !value.length) return { ok: false, reason: `«${op}» требует непустой массив values`, allowed };
    for (const v of value){ const e = checkOne(v); if (e) return { ok: false, reason: e, allowed }; }
  } else if (spec.arity === 'range'){
    if (!value || typeof value !== 'object' || Array.isArray(value) || (!value.from && !value.to))
      return { ok: false, reason: `«${op}» требует объект {from, to}`, allowed };
  } else {
    if (Array.isArray(value)) return { ok: false, reason: `«${op}» принимает одно значение, а не массив`, allowed };
    const e = checkOne(value); if (e) return { ok: false, reason: e, allowed };
  }
  return { ok: true, spec };
}

// Обёртка значения по форме: {value} | {values} | {from,to}
function wrapValue(op, value){
  const spec = opSpec(op);
  if (spec.arity === 'many') return { values: value };
  if (spec.arity === 'range') return value; // уже {from, to}
  return { value };
}

function registryInfo(){ return { source: REG.source, operators: Object.keys(REG.operators).length }; }

module.exports = { REG, opSpec, allowedOpsFor, fieldEnum, checkOperatorFor, wrapValue, registryInfo };
