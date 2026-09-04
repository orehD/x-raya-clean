// Пересчёт метрик на сохранённых результатах прогона (.eval-last.json).
// Прогон 29 кейсов занимает ~25 минут и стоит денег, поэтому менять формулу метрики
// и смотреть, что получится, нужно без повторных обращений к модели.
// Запуск: node remetric.js
'use strict';
const fs = require('fs');
const path = require('path');
const { features, opFamily, dropService, f1 } = require('./eval-metrics');

const KB = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', p), 'utf-8'));
const presets = KB('presets.json');
const examples = KB('query_examples.json');

const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '.eval-last.json'), 'utf-8'));

function goldFor(name, q){
  const p = presets.find(x => x.name === name);
  if (p && p.filter && !p.filter._parse_error) return p.filter;
  const e = examples.find(x => (x.explanation || '').trim() === q.trim());
  return e && e.filter;
}

const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const rows = [];
for (const s of saved){
  if (!s.filter) { rows.push({ ...s, r: 0, p: 0, pn: 0, f: 0 }); continue; }
  const gold = goldFor(s.name, s.q);
  if (!gold) continue;
  const got = features(s.filter), want = features(gold);
  const wantCore = dropService(want.cond);
  const cond = wantCore.size ? f1(dropService(got.cond), wantCore) : f1(got.cond, want.cond);
  const gotNarrow = dropService(got.narrowing);
  const narrow = f1(gotNarrow, dropService(want.narrowing));
  // Движок не поставил ни одного сужающего условия — лишних сужений нет,
  // а значит и штрафовать не за что: точность здесь полная, а не нулевая.
  const pn = gotNarrow.size ? narrow.p : 1;
  rows.push({ name: s.name, r: cond.r, p: cond.p, pn: wantCore.size ? pn : cond.p, f: cond.f });
}

console.log(`Пересчёт на ${rows.length} сохранённых кейсах\n${'='.repeat(60)}`);
console.log(`ПОЛНОТА:                                 ${(avg(rows.map(x => x.r)) * 100).toFixed(0)}%`);
console.log(`ТОЧНОСТЬ (все условия):                  ${(avg(rows.map(x => x.p)) * 100).toFixed(0)}%`);
console.log(`ТОЧНОСТЬ (только сужающие, без $or):     ${(avg(rows.map(x => x.pn)) * 100).toFixed(0)}%`);
console.log(`F1:                                      ${(avg(rows.map(x => x.f)) * 100).toFixed(0)}%`);
console.log('\nПо кейсам (полнота / точность-сужающие):');
rows.sort((a, b) => a.r - b.r).forEach(x =>
  console.log(`  ${(x.r * 100).toFixed(0).padStart(3)}% / ${(x.pn * 100).toFixed(0).padStart(3)}%  ${x.name}`));
