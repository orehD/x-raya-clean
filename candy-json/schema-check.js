// Проверка фильтров без внешних библиотек: поля, операторы, значения enum
// и структура nested_any сверяются с реестром, извлечённым из схемы поиска Candy
// (candy-kb/filter_schema_registry.json). Тот же код, что защищает сборку в движке,
// поэтому проверка отвечает ровно на вопрос «примет ли это окно поиска».
//
//   node schema-check.js                   — фильтры последнего прогона eval.js
//   node schema-check.js фильтр.json       — один фильтр из файла
//   node schema-check.js --presets         — боевые подборки из candy-kb
'use strict';
const fs = require('fs');
const path = require('path');
const { validateFilter } = require('./builder');

const KB = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', p), 'utf-8'));

function collect(){
  const arg = process.argv[2];
  const out = [];
  if (arg && arg !== '--presets'){
    out.push([path.basename(arg), JSON.parse(fs.readFileSync(arg, 'utf-8'))]);
    return out;
  }
  if (arg !== '--presets'){
    const savedFile = path.join(__dirname, '.eval-last.json');
    if (fs.existsSync(savedFile))
      for (const s of JSON.parse(fs.readFileSync(savedFile, 'utf-8')))
        if (s.filter) out.push([s.name, s.filter]);
  }
  // боевые подборки — контрольная группа: если не проходят они, вопрос к схеме
  for (const p of KB('presets.json'))
    if (p.filter && !p.filter._parse_error) out.push(['[боевая] ' + p.name, p.filter]);
  return out;
}

const targets = collect();
if (!targets.length){
  console.log('Нечего проверять: нет ни .eval-last.json, ни указанного файла.');
  process.exit(0);
}

let bad = 0;
console.log(`Проверка ${targets.length} фильтров по реестру схемы Candy\n${'='.repeat(64)}`);
for (const [name, filter] of targets){
  const errors = validateFilter(filter);
  if (!errors.length) continue;
  bad++;
  console.log(`✗ ${name}`);
  errors.slice(0, 8).forEach(e => console.log(`     ${e}`));
}
console.log(`\n${'='.repeat(64)}`);
console.log(bad ? `Невалидных: ${bad} из ${targets.length}` : `Все ${targets.length} фильтров валидны`);
process.exitCode = bad ? 1 : 0;
