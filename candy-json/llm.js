// LLM-слой через VseGPT (OpenAI-совместимый агрегатор, api.vsegpt.ru).
// Через него доступны и Claude (anthropic/*), и GPT (openai/*) — модель задаётся env.
//   VSEGPT_API_KEY   — ключ (sk-or-…)
//   VSEGPT_MODEL     — модель, по умолчанию anthropic/claude-sonnet-4.5
//   VSEGPT_BASE_URL  — переопределение эндпоинта (по умолчанию https://api.vsegpt.ru/v1)
// Стиль — как в api/ai.js X-Raya: чистый fetch, без зависимостей (Node ≥18).
'use strict';

// Подхватываем .env из candy-json/ или корня sourcing-agent (без зависимостей).
// Формат: KEY=value, строки с # игнорируются. process.env имеет приоритет.
(function loadEnv(){
  const fs = require('fs');
  const path = require('path');
  for (const p of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]){
    try {
      for (const line of fs.readFileSync(p, 'utf-8').split('\n')){
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !m[1].startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) { /* файла нет — ок */ }
  }
})();

const BASE_URL = process.env.VSEGPT_BASE_URL || 'https://api.vsegpt.ru/v1';
const MODEL = process.env.VSEGPT_MODEL || 'anthropic/claude-sonnet-4.5';

/* Сменный транспорт. На сервере X-Raya провайдер уже настроен (askAI: AI_BASE_URL,
 * ключ, ретранслятор, лимиты, учёт расходов) — движку незачем ходить в сеть своим
 * путём и требовать второй ключ. Хост подменяет транспорт один раз при старте:
 *   require('./candy-json/llm').setTransport(async ({system, user}) => (await askAI(system, user)).text)
 * Без подмены работает встроенный VseGPT — так удобно гонять eval локально. */
let transport = null;
function setTransport(fn){ transport = fn; }

// Спека с вариантами написания роли легко занимает 2-3k токенов, а обрыв по лимиту
// даёт невалидный JSON — держим потолок с запасом.
// temperature 0: задача структурная (разложить запрос по известным полям),
// творчество тут только добавляет разброс между одинаковыми запросами.
async function chat({ system, messages, temperature = 0, maxTokens = 8000, model = MODEL }){
  if (transport){
    // История диалога сворачивается в один пользовательский текст: транспорт хоста
    // принимает пару system/user, а не массив сообщений.
    const user = messages.map(m => (m.role === 'assistant' ? 'Твой предыдущий ответ:\n' : '') + m.content).join('\n\n');
    const text = await transport({ system, user, maxTokens });
    if (!text) throw new Error('LLM: пустой ответ');
    return text;
  }
  const key = process.env.VSEGPT_API_KEY;
  if (!key) throw new Error('VSEGPT_API_KEY не задан');
  let r;
  try {
    r = await fetch(BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + key,
        'X-Title': 'X-Raya Candy JSON',
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [ { role: 'system', content: system }, ...messages ],
      }),
    });
  } catch (e){
    // обрыв соединения — сетевой сбой, его имеет смысл повторить
    const err = new Error('LLM: сеть — ' + e.message);
    err.retryable = true;
    throw err;
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok){
    const msg = (d.error && (d.error.message || d.error)) || 'HTTP ' + r.status;
    const err = new Error('LLM: ' + msg);
    // VseGPT держит лимит 1 запрос/сек и иногда отдаёт временные ошибки шлюза —
    // помечаем их, чтобы вызывающий мог просто подождать и повторить
    err.retryable = /rate-limit|too many|429|unknown main server|timeout|gateway|temporar/i.test(String(msg));
    throw err;
  }
  const choice = d.choices && d.choices[0];
  const text = choice && choice.message && choice.message.content;
  if (!text) throw new Error('LLM: пустой ответ');
  if (choice.finish_reason === 'length') throw new Error('LLM: ответ обрезан по лимиту токенов');
  return text;
}

// Достаём первый JSON-объект из ответа (модель может обернуть в ```json … ```)
function parseJson(text){
  const cleaned = text.replace(/```json|```/g, '');
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('ответ модели не содержит JSON');
  return JSON.parse(m[0]);
}

/* Интерпретация запроса рекрутера → {spec, explain} | {questions, explain}.
 * history — предыдущие реплики диалога [{role:'user'|'assistant', content}] для доуточнений. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function interpret(query, { history = [], system, full = false, retries = 3 } = {}){
  const { systemPrompt } = require('./prompts');
  const sys = system || systemPrompt(query, { full });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++){
    try {
      const text = await chat({
        system: sys,
        messages: [...history, { role: 'user', content: 'Запрос рекрутера: ' + query }],
        // на повторе поднимаем потолок и снижаем температуру: обрыв и кривой JSON
        // обычно лечатся именно этим, а не другой формулировкой
        maxTokens: attempt ? 12000 : 8000,
        temperature: 0,
      });
      return { raw: text, ...parseJson(text) };
    } catch (e){
      lastErr = e;
      const softFail = e.retryable || /обрезан|JSON|не содержит/i.test(e.message);
      if (!softFail) throw e;                       // биллинг, неверный ключ и т.п. — повторять бессмысленно
      if (attempt < retries) await sleep(e.retryable ? 1500 * (attempt + 1) : 300);
    }
  }
  throw lastErr;
}

module.exports = { chat, parseJson, interpret, setTransport, MODEL, BASE_URL };
