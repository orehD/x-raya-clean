// Движок JSON-подборок Candy: спека (DSL) → валидный фильтр + таблица проверки.
// Fail-closed: если хоть одно условие не разрешилось — фильтр не выдаётся,
// вместо него возвращаются уточняющие вопросы с вариантами из справочников.
//
// const { buildQuery } = require('./engine');
// const res = buildQuery({
//   conditions: { all: [
//     { intent:'специализация БА в процессе отбора',
//       field:'hiringProcesses.specializationId', op:'string_eq',
//       ref:{ kind:'specialization', query:'Бизнес-аналитик' } },
//     { same:'resumes.workExperience', children:[
//       { any:[
//         { field:'resumes.workExperience.position', op:'text_phrase', value:'Бизнес Аналитик' },
//         { field:'resumes.workExperience.position', op:'text_phrase', value:'Business Analyst' },
//       ]},
//       { field:'resumes.workExperience.startDate', op:'date_gt', value:'2023-01-01' },
//     ]},
//   ]},
//   exclusions: true,   // true | false | null (null → движок спросит)
// });
'use strict';
const { buildNode, exclusionBlocks, validateFilter, flatten, BuildError } = require('./builder');
const { resolveSpec, tableMarkdown, STATUS } = require('./resolve');
const { registryInfo } = require('./operators');

const EXCLUSIONS_QUESTION = 'Нужно ли исключить из выдачи сотрудников, читеров и уволенных по критичной причине?';

function questionsFrom(entries){
  const qs = [];
  for (const e of entries){
    if (e.status === STATUS.AMBIGUOUS){
      qs.push({
        type: 'choice',
        leafIndex: e.leafIndex,
        condition: e.condition,
        question: `По условию «${e.condition}» найдено несколько вариантов. Какие использовать?`,
        options: e.options,
      });
    } else if (e.status === STATUS.MISSING){
      qs.push({
        type: 'missing',
        leafIndex: e.leafIndex,
        condition: e.condition,
        question: `Не удалось подтвердить условие «${e.condition}»: ${e.note}.` + (e.options ? ' Возможно, имелось в виду одно из полей ниже?' : ''),
        options: e.options || null,
      });
    }
  }
  return qs;
}

/* Главная точка входа.
 * spec = { conditions: <DSL>, exclusions: true|false|null }
 * → { status:'ok', filter, table, tableMarkdown, warnings }
 * | { status:'clarify', questions, table, tableMarkdown }
 * | { status:'error', errors, table }                                   */
function buildQuery(spec){
  if (!spec || !spec.conditions) return { status: 'error', errors: ['пустая спека: нет conditions'] };
  // клонируем: resolve мутирует листья (подставляет value из ref)
  const conditions = JSON.parse(JSON.stringify(spec.conditions));

  const { entries, ok } = resolveSpec(conditions);
  const questions = questionsFrom(entries);
  if (spec.exclusions === null || spec.exclusions === undefined){
    questions.push({ type: 'confirm', condition: 'исключения', question: EXCLUSIONS_QUESTION });
  }
  if (!ok || questions.some(q => q.type === 'confirm')){
    // spec отдаём вместе с вопросами: диалог патчит именно её (ответы рекрутера
    // подставляются в листья по leafIndex) и вызывает buildQuery повторно
    return { status: 'clarify', questions, table: entries, tableMarkdown: tableMarkdown(entries),
      spec: { conditions, exclusions: spec.exclusions } };
  }

  // корень всегда $and: позитивные условия + при необходимости блок исключений
  const parts = Array.isArray(conditions.all) ? conditions.all : [conditions];
  if (spec.exclusions === true) parts.push(...exclusionBlocks());

  let filter;
  try {
    filter = flatten(buildNode(parts.length === 1 ? parts[0] : { all: parts }));
    // корень всегда должен быть группой: одиночное условие оборачиваем обратно в $and,
    // как это сделано во всех боевых подборках
    if (!filter.$and && !filter.$or && !filter.$not) filter = { $and: [filter] };
  } catch (err) {
    if (err instanceof BuildError) return { status: 'error', errors: [err.message], table: entries };
    throw err;
  }

  const errors = validateFilter(filter);
  if (errors.length) return { status: 'error', errors, table: entries };

  // Подпись подборки. Схема разрешает любые ключи на «#», Candy показывает их
  // в интерфейсе — по ним видно, что фильтр собрала X-Raya, и что именно просили.
  if (spec.label || spec.description){
    filter = {
      ...(spec.label ? { '#name': spec.label } : {}),
      ...(spec.description ? { '#description': spec.description } : {}),
      ...filter,
    };
  }

  return { status: 'ok', filter, table: entries, tableMarkdown: tableMarkdown(entries), registry: registryInfo() };
}

module.exports = { buildQuery, EXCLUSIONS_QUESTION };
