// Метрики сравнения фильтров. Вынесены отдельно, чтобы eval.js (прогон через модель)
// и remetric.js (пересчёт на сохранённых результатах) считали одинаково.
'use strict';

/* Семейство оператора: string_eq и string_one_of по одному и тому же набору id дают
 * идентичную выдачу, поэтому для оценки интерпретации это одно и то же условие.
 * Различать их — значит штрафовать движок за форму записи, а не за смысл. */
function opFamily(op){
  if (/^string_(eq|one_of)$/.test(op)) return 'string≈';
  if (/^int_(eq|one_of)$/.test(op)) return 'int≈';
  if (/^(text_phrase|text_match|text_list_phrase|text_list_matches_any_of|text_list_matches_all_of)$/.test(op)) return 'text≈';
  if (/_contains_(any|all)_of$/.test(op)) return 'list≈';
  if (/^date_/.test(op)) return op; // даты различаем: gt и lt — разный смысл
  return op;
}

/* Разбор фильтра в множества признаков.
 * narrowing — условия вне $or: только они сужают выдачу, и только по ним имеет
 * смысл считать точность (лишняя ветка внутри $or выдачу расширяет). */
function features(filter, docPath = '', acc = { cond: new Set(), vals: new Set(), narrowing: new Set() }, inOr = false){
  if (!filter || typeof filter !== 'object') return acc;
  for (const [key, val] of Object.entries(filter)){
    if (key.startsWith('#')) continue;
    if (key === '$and'){ (val || []).forEach(v => features(v, docPath, acc, inOr)); continue; }
    if (key === '$or'){ (val || []).forEach(v => features(v, docPath, acc, true)); continue; }
    if (key === '$not'){ features(val, docPath, acc, inOr); continue; }
    if (val && typeof val === 'object' && val.nested_any){ features(val.nested_any.filter, docPath ? docPath + '.' + key : key, acc, inOr); continue; }
    const op = Object.keys(val || {})[0];
    if (!op) continue;
    const p = docPath ? docPath + '.' + key : key;
    const sig = `${p} ${opFamily(op)}`;
    acc.cond.add(sig);
    if (!inOr) acc.narrowing.add(sig);
    const body = val[op] || {};
    const v = 'values' in body ? body.values : body.value;
    for (const x of (Array.isArray(v) ? v : [v])) acc.vals.add(`${p}=${x}`);
  }
  return acc;
}

/* Служебный блок исключений движок добавляет сам по ответу «да» — к качеству
 * интерпретации запроса он отношения не имеет и в эталонах есть не везде. */
const SERVICE = new Set(['employeeStatus string≈', 'tags text≈',
  'employeeDismissalReasonIsNegative bool_eq', 'facts.employeeDismissalReasonId int≈',
  'facts.employeeStatus string≈', 'facts.employeeDismissalDate date_gt']);
const SERVICE_FIELDS = new Set(['employeeStatus', 'tags', 'employeeDismissalReasonIsNegative',
  'facts.employeeDismissalReasonId', 'facts.employeeStatus', 'facts.employeeDismissalDate']);
const dropService = (set) => new Set([...set].filter(x =>
  !SERVICE.has(x) && !SERVICE_FIELDS.has(x.split('=')[0])));

function f1(got, want){
  const inter = [...got].filter(x => want.has(x)).length;
  const p = got.size ? inter / got.size : 0;
  const r = want.size ? inter / want.size : 0;
  return { p, r, f: (p + r) ? 2 * p * r / (p + r) : 0, inter,
    missing: [...want].filter(x => !got.has(x)), extra: [...got].filter(x => !want.has(x)) };
}

module.exports = { opFamily, features, dropService, f1, SERVICE, SERVICE_FIELDS };
