// Формальная проверка фильтров по JSON Schema поиска Candy (filter.json, draft-04).
// Нужна, чтобы не гадать «примет ли окно поиска наш JSON», а получить точный ответ.
//
//   node schema-check.js              — проверить все фильтры последнего прогона
//   node schema-check.js file.json    — проверить фильтр из файла
'use strict';
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv-draft-04');
const { flatten } = require('./builder');

const schema = JSON.parse(fs.readFileSync('/Users/macbook/Downloads/JSON/filter.json', 'utf-8').replace(/^﻿/, ''));
const ajv = new Ajv({ allErrors: true, strictSchema: false, verbose: false });
const validate = ajv.compile(schema);

/* Ошибки anyOf раскрываются в сотни веток — оставляем самые конкретные:
 * те, что указывают на реальное поле или оператор, а не на «не подошёл ни один вариант». */
function briefErrors(errors){
  const useful = (errors || [])
    .filter(e => e.keyword !== 'anyOf')
    .map(e => `${e.instancePath || '(корень)'} ${e.message}${e.params && e.params.additionalProperty ? ': ' + e.params.additionalProperty : ''}`);
  const uniq = [...new Set(useful)];
  return uniq.slice(0, 12);
}

function check(name, filter){
  const ok = validate(filter);
  if (ok) return { name, ok: true };
  return { name, ok: false, errors: briefErrors(validate.errors) };
}

const targets = [];
if (process.argv[2]){
  const f = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
  targets.push([path.basename(process.argv[2]), f]);
} else {
  const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '.eval-last.json'), 'utf-8'));
  for (const s of saved) if (s.filter) targets.push([s.name, s.filter]);
  // и боевые подборки для контроля: если они не проходят — вопрос к схеме, а не к движку
  const presets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', 'presets.json'), 'utf-8'));
  for (const p of presets) if (p.filter && !p.filter._parse_error) targets.push(['[боевая] ' + p.name, p.filter]);
}

let bad = 0, badRaw = 0;
console.log(`Проверка ${targets.length} фильтров по filter.json\n${'='.repeat(64)}`);
for (const [name, filter] of targets){
  const raw = check(name, filter);
  const flat = check(name, flatten(filter));
  if (!raw.ok) badRaw++;
  if (!flat.ok){
    bad++;
    console.log(`✗ ${name}`);
    flat.errors.forEach(e => console.log(`     ${e}`));
  } else if (!raw.ok){
    console.log(`✓ ${name}  (проходит только после схлопывания вложенных групп)`);
  }
}
console.log(`\n${'='.repeat(64)}`);
console.log(`Невалидных после схлопывания: ${bad} из ${targets.length}`);
console.log(`Невалидных до схлопывания:    ${badRaw} из ${targets.length}`);
