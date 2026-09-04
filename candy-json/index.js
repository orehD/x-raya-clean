// Публичный API модуля JSON-подборок Candy.
//
// Полный конвейер: запрос рекрутера → interpret (LLM) → buildQuery (движок, fail-closed).
//   const candy = require('./candy-json');
//   const out = await candy.ask('джависты, прошедшие техничку, без сотрудников');
//   // → { status:'ok', filter, table, explain } | { status:'clarify', questions, … }
//
// Без LLM (готовая спека): candy.buildQuery(spec)
'use strict';
const kb = require('./kb');
const { buildQuery } = require('./engine');
const { validateFilter, exclusionBlocks } = require('./builder');
const { interpret } = require('./llm');
const { systemPrompt } = require('./prompts');

// Короткое имя подборки из запроса рекрутера: первая строка до 60 символов.
function labelFrom(query){
  const s = String(query).replace(/\s+/g, ' ').trim();
  return 'X-Raya · ' + (s.length > 60 ? s.slice(0, 57).trimEnd() + '…' : s);
}

async function ask(query, opts = {}){
  const ai = await interpret(query, opts);
  if (ai.questions) return { status: 'clarify', questions: ai.questions.map(q => ({ type: 'text', question: q })), explain: ai.explain || null, spec: null };
  // подписываем фильтр запросом рекрутера — в Candy это видно в интерфейсе
  if (opts.label !== false){
    ai.spec.label = opts.label || labelFrom(query);
    ai.spec.description = ai.explain || query;
  }
  const res = buildQuery(ai.spec);
  res.explain = ai.explain || null;
  res.spec = ai.spec; // спека нужна для доуточнений следующего круга
  return res;
}

module.exports = { ask, buildQuery, validateFilter, exclusionBlocks, systemPrompt, kb };
