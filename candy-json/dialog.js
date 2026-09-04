// Диалоговый цикл доуточнений (CJM: «X-Raya уточняет запрос → рекрутер отвечает»).
//
//   const { Dialog } = require('./dialog');
//   const d = new Dialog();
//   let r = await d.send('нужны бэкенд-аналитики');        // → clarify с вопросами
//   r = await d.send('вариант 2, исключения нужны');       // → ok с фильтром
//
// Ответы на типовые вопросы (выбор варианта из справочника, да/нет про исключения)
// обрабатываются детерминированно, без похода в LLM. Всё остальное — новый круг
// интерпретации с полной историей диалога.
'use strict';
const { buildQuery, EXCLUSIONS_QUESTION } = require('./engine');
const { leafAt } = require('./resolve');
const { interpret } = require('./llm');

/* ── детерминированные парсеры ответов ── */

// «да»/«нет» про исключения.
// Границы слов — через lookaround по кириллице: \b в JS считает русские буквы
// не-словесными символами и потому здесь не работает.
const NO_RE  = /(?<![а-яёa-z])(нет|не\s+нужн[а-яё]*|не\s+надо|не\s+исключ[а-яё]*|остав[а-яё]*|no)(?![а-яёa-z])/;
const YES_RE = /(?<![а-яёa-z])(да|ага|нужн[а-яё]*|надо|конечно|исключ[а-яё]*|убер[а-яё]*|yes)(?![а-яёa-z])/;
function parseYesNo(text){
  const t = text.toLowerCase();
  if (NO_RE.test(t)) return false;   // «нет»/«не нужно» проверяем первым — они содержат «нужно»
  if (YES_RE.test(t)) return true;
  return null;
}

// выбор вариантов: «1», «вариант 2», «1 и 3», «первый», либо совпадение с label
function parseChoice(text, options){
  const t = text.toLowerCase();
  const picked = new Set();
  const words = { 'перв': 0, 'втор': 1, 'трет': 2, 'четверт': 3, 'пят': 4 };
  for (const [w, i] of Object.entries(words)) if (t.includes(w) && options[i]) picked.add(i);
  for (const m of t.matchAll(/\b(\d{1,2})\b/g)){
    const i = Number(m[1]) - 1;
    if (options[i]) picked.add(i);
  }
  if (!picked.size){
    options.forEach((o, i) => {
      const label = String(o.label).toLowerCase().split('(')[0].trim();
      if (label && t.includes(label)) picked.add(i);
    });
  }
  if (/\bвсе\b|\bлюбые\b/.test(t)) options.forEach((_, i) => picked.add(i));
  return [...picked].sort((a, b) => a - b);
}

/* Пытается закрыть открытые вопросы ответом рекрутера без LLM.
 * Возвращает true, если хоть что-то применили. */
function applyAnswer(session, text){
  let applied = false;
  const pending = session.pending;
  if (!pending) return false;

  // вопрос про исключения
  if (pending.questions.some(q => q.type === 'confirm')){
    const yn = parseYesNo(text);
    if (yn !== null){ pending.spec.exclusions = yn; applied = true; }
  }
  // Вопросы-выборы (неоднозначный справочник). Раньше закрывали только одиночный
  // вопрос, но в сложных подборках их бывает несколько сразу, и диалог зацикливался.
  // Теперь: если ответ указывает конкретные номера — применяем к первому открытому
  // выбору; если это универсальный ответ вроде «первый вариант» — ко всем сразу.
  const choices = pending.questions.filter(q => q.type === 'choice' && q.options);
  const universal = /перв|все\b|любой|перечисленн/i.test(text);
  const targets = universal ? choices : choices.slice(0, 1);
  for (const q of targets){
    const idx = parseChoice(text, q.options);
    if (!idx.length) continue;
    const leaf = leafAt(pending.spec.conditions, q.leafIndex);
    if (!leaf) continue;
    const values = idx.map(i => q.options[i].value);
    if (values.length === 1 && !/one_of|any_of|all_of/.test(leaf.op)){
      leaf.value = values[0];
    } else {
      // несколько значений → переключаем оператор на множественный аналог
      leaf.value = values;
      if (leaf.op === 'string_eq') leaf.op = 'string_one_of';
      if (leaf.op === 'int_eq') leaf.op = 'int_one_of';
    }
    delete leaf.ref;
    applied = true;
  }
  return applied;
}

class Dialog {
  constructor(opts = {}){
    this.history = [];      // реплики для LLM
    this.pending = null;    // {spec, questions} последнего clarify
    this.opts = opts;
  }

  _finish(res){
    if (res.status === 'clarify') this.pending = { spec: res.spec, questions: res.questions };
    else this.pending = null;
    return res;
  }

  async send(text){
    // 1) пробуем закрыть открытые вопросы детерминированно
    if (this.pending && applyAnswer(this, text)){
      this.history.push({ role: 'user', content: text });
      const res = buildQuery(this.pending.spec);
      res.spec = this.pending.spec;
      if (res.status !== 'clarify') return this._finish(res);
      // часть вопросов осталась — отдадим их, не дёргая LLM
      return this._finish(res);
    }

    // 2) полноценный круг интерпретации с историей
    let ai = await interpret(text, { history: this.history, ...this.opts });
    this.history.push({ role: 'user', content: 'Запрос рекрутера: ' + text });
    this.history.push({ role: 'assistant', content: ai.raw });

    if (ai.questions){
      return this._finish({ status: 'clarify', explain: ai.explain || null, spec: null,
        questions: ai.questions.map(q => ({ type: 'text', question: q })) });
    }
    let res = buildQuery(ai.spec);

    // Промах мимо схемы: в промпте была урезанная выборка полей — повторяем
    // один раз с полной схемой, прежде чем идти к рекрутеру с вопросами.
    const missedField = res.status === 'clarify' && !this._retriedFull &&
      (res.questions || []).some(q => q.type === 'missing' && /не найдено в модели/.test(q.question));
    if (missedField){
      this._retriedFull = true;
      try {
        ai = await interpret(text, { history: this.history, ...this.opts, full: true });
        this.history.push({ role: 'assistant', content: ai.raw });
        if (!ai.questions) res = buildQuery(ai.spec);
      } catch (_) { /* остаёмся с прежним результатом */ }
    }

    // Спека не собралась (например, поле не принадлежит указанной same-группе):
    // отдаём модели текст ошибки и даём один шанс починить — это дешевле и точнее,
    // чем спрашивать рекрутера о том, чего он всё равно не знает.
    if (res.status === 'error' && !this._repaired){
      this._repaired = true;
      const errs = (res.errors || []).join('; ');
      try {
        const fix = await interpret(
          `Предыдущая спека не собралась движком. Ошибки: ${errs}. Исправь спеку и верни JSON целиком. Исходный запрос: ${text}`,
          { history: this.history, ...this.opts, full: true });
        this.history.push({ role: 'assistant', content: fix.raw });
        if (fix.spec){
          const fixed = buildQuery(fix.spec);
          if (fixed.status !== 'error'){ res = fixed; res.explain = fix.explain || ai.explain || null; res.spec = fix.spec; }
        }
      } catch (_) { /* остаёмся с прежней ошибкой */ }
    }
    res.explain = ai.explain || null;
    res.spec = ai.spec;
    // вопросы движка тоже кладём в историю — LLM увидит их на следующем круге
    if (res.status === 'clarify'){
      const qtext = res.questions.map(q => '- ' + q.question + (q.options ? '\n' + q.options.map((o, i) => `  ${i + 1}. ${o.label}`).join('\n') : '')).join('\n');
      this.history.push({ role: 'assistant', content: 'Уточняющие вопросы движка:\n' + qtext });
    }
    return this._finish(res);
  }
}

module.exports = { Dialog, applyAnswer, parseChoice, parseYesNo, EXCLUSIONS_QUESTION };
