// X-Raya — сорсинг-агент. Один файл, ноль npm-зависимостей, Node 18+.
//
// Сервер отдаёт статические страницы и держит несколько API поверх внешних сервисов,
// чтобы ключи не уезжали в браузер. Логика сборки поисковых запросов живёт целиком
// на клиенте, в index.html — сервер её не касается.
//
// Запуск:     node server.js            (порт 3000, переопределяется PORT)
// Настройки:  docs/CONFIG.md и .env.example — полный список переменных
// Данные:     всё пишется в ./data, см. docs/DATA.md. В контейнере смонтируй том,
//             иначе файлы исчезнут при пересборке.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT  = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';
// gpt-5 и o-серия работают только со своей температурой по умолчанию — параметр не шлём
const IS_REASONING = /gpt-5|(^|\/)o[1-9]/i.test(MODEL);   // семейство «думающих» моделей
const TEMP = IS_REASONING ? null : (parseFloat(process.env.AI_TEMPERATURE) || 0.4);
// Скорость: у думающих моделей отключаем размышление — нам нужен короткий JSON, а не рассуждения.
// ВАЖНО: лимит ответа таким моделям по умолчанию НЕ шлём. У них max_completion_tokens
// включает и токены размышлений, поэтому тесный лимит съедается рассуждением,
// а сам ответ приходит пустым. Ставим только если задан явно через AI_MAX_TOKENS.
const REASONING = (process.env.AI_REASONING || 'minimal').trim();
const MAXTOK_ENV = parseInt(process.env.AI_MAX_TOKENS, 10) || 0;

function send(res, code, type, body) {
  const h = { 'content-type': type };
  // HTML не кэшируем: после Redeploy пользователи сразу получают свежую версию без Cmd+Shift+R
  if (type.startsWith('text/html')) h['cache-control'] = 'no-cache';
  res.writeHead(code, h);
  res.end(body);
}

// Пароль страницы метрик. Историческое имя переменной — STATS_TOKEN_X, оно и задано
// в окружении прода; принимаем оба, чтобы переключение версий не гасило /stats.
function statsToken() {
  return String(process.env.STATS_TOKEN || process.env.STATS_TOKEN_X || '').trim();
}

// Диагностика AI: куда уходит запрос и что отвечает ретранслятор.
// Защищено паролем статистики. Секреты наружу не отдаём — только хост и текст ошибки.
async function handleAIDiag(req, res) {
  const token = statsToken();
  const url = new URL(req.url, 'http://x');
  const given = req.headers['x-stats-token'] || url.searchParams.get('token') || '';
  if (!token || given !== token) return send(res, 401, 'application/json', JSON.stringify({ error: 'неверный пароль' }));

  let base = (process.env.AI_BASE_URL || '').trim();
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  if (base && !/\/chat\/completions$/.test(base)) base = base.replace(/\/+$/, '') + '/chat/completions';
  // ключ чистим: Coolify часто сохраняет значение с переносом строки или в кавычках
  const baseKey = String(process.env.AI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  let relay = (process.env.AI_RELAY_URL || '').trim();
  if (relay && !/^https?:\/\//i.test(relay)) relay = 'https://' + relay;
  if (base && baseKey) relay = '';
  const out = {
    путь: (base && baseKey) ? 'прямой провайдер'
        : relay ? 'через ретранслятор'
        : (process.env.OPENROUTER_API_KEY ? 'напрямую в OpenRouter' : 'не настроен'),
    провайдер: (base && baseKey) ? base.replace(/^https?:\/\//, '').split('/')[0] : null,
    ретранслятор: relay ? relay.replace(/^https?:\/\//, '').split('/')[0] : null,
    секрет_ретранслятора: process.env.RELAY_SECRET ? 'задан' : 'нет',
    ключ_провайдера: baseKey ? 'задан' : 'нет',
    ключ_openrouter_на_сервере: process.env.OPENROUTER_API_KEY ? 'задан' : 'нет',
    модель: MODEL,
    думающая_модель: IS_REASONING,
    reasoning_effort: IS_REASONING ? (REASONING || 'не задан') : 'не применяется',
    лимит_обычного_ответа: MAXTOK_ENV || (IS_REASONING ? 'не задан' : 800),
    лимит_подборки_candy: CANDY_MAXTOK,
    последняя_пустая_выдача: lastAIFail || 'не было',
    пароль_подборок: CANDY_PW ? 'задан' : 'не задан — вкладка открыта всем',
  };
  const probe = { цель: relay ? 'ретранслятор' : ((base && baseKey) ? 'провайдер напрямую' : 'openrouter') };
  try {
    const target = relay || base || 'https://openrouter.ai/api/v1/chat/completions';
    const headers = relay
      ? Object.assign({ 'content-type': 'application/json' }, process.env.RELAY_SECRET ? { 'x-relay-auth': process.env.RELAY_SECRET } : {})
      : { 'content-type': 'application/json', 'authorization': 'Bearer ' + (baseKey || process.env.OPENROUTER_API_KEY || ''), 'X-Title': 'X-Raya' };
    const body = relay
      ? JSON.stringify({ system: '', user: 'ping', model: MODEL })
      : JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }] });
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(target, { method: 'POST', headers, body, signal: ctl.signal });
    clearTimeout(tm);
    probe.код_ответа = r.status;
    const txt = await r.text();
    probe.ответ = txt.slice(0, 300);
    probe.вердикт = r.ok ? 'работает'
      : /security policy|access denied/i.test(txt) ? 'OpenRouter блокирует ключ или IP отправителя'
      : /forbidden/i.test(txt) ? 'RELAY_SECRET на сервере и в воркере не совпадают'
      : /OPENROUTER_API_KEY не задан/i.test(txt) ? 'в секретах воркера нет ключа OpenRouter'
      : /auth|credential|api key/i.test(txt) ? 'ключ OpenRouter недействителен'
      : /credit|quota|insufficient|balance|баланс/i.test(txt) ? 'на счёте провайдера кончились средства'
      : /model|модель/i.test(txt) ? 'провайдер не знает такую модель — задай AI_MODEL (обычно gpt-4o-mini без префикса)'
      : 'смотри текст ответа';
  } catch (e) {
    probe.ошибка = String((e && e.message) || e);
    probe.вердикт = 'ретранслятор недоступен по этому адресу';
  }
  out.проверка = probe;
  send(res, 200, 'application/json', JSON.stringify(out, null, 2));
}

// Куда уходит запрос к модели. Три пути, в порядке приоритета:
// 1) AI_BASE_URL + AI_API_KEY — прямой вызов любого OpenAI-совместимого провайдера
//    (российские реселлеры вроде ProxyAPI/VseGPT работают с РФ-адресов без обходов);
// 2) AI_RELAY_URL — через ретранслятор (Cloudflare/Deno), если провайдер режет IP сервера;
// 3) OPENROUTER_API_KEY — напрямую в OpenRouter (работает не со всех адресов).
function aiConfig() {
  let base = (process.env.AI_BASE_URL || '').trim();
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  if (base && !/\/chat\/completions$/.test(base)) base = base.replace(/\/+$/, '') + '/chat/completions';
  // ключ чистим: Coolify часто сохраняет значение с переносом строки или в кавычках
  const baseKey = String(process.env.AI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  let relay = (process.env.AI_RELAY_URL || '').trim();
  if (relay && !/^https?:\/\//i.test(relay)) relay = 'https://' + relay;
  const key = String(process.env.OPENROUTER_API_KEY || '').trim().replace(/^["']|["']$/g, '') || undefined;
  if (base && baseKey) relay = '';           // прямой провайдер важнее ретранслятора
  const ok = !!(base || relay || key);
  return { base, baseKey, relay, key, ok };
}

// Ошибка вызова модели с кодом ответа, который надо отдать браузеру.
class AIError extends Error {
  constructor(msg, status) { super(msg); this.status = status || 502; }
}

// Один вызов модели. Возвращает текст ответа, при неудаче бросает AIError.
// opts.maxTokens: число — лимит ответа; 0 — снять лимит совсем; не задан — как раньше
// (AI_MAX_TOKENS, а для обычных моделей 800). У «думающих» моделей лимит включает
// и токены рассуждений, поэтому на длинных задачах его лучше не ставить вовсе:
// иначе бюджет уходит на размышления и до текста ответа дело не доходит.
async function askAI(system, user, opts) {
  const o = opts || {};
  const cfg = aiConfig();
  if (!cfg.ok) throw new AIError('AI не настроен: задай AI_BASE_URL + AI_API_KEY либо AI_RELAY_URL', 500);
  const capSet = o.maxTokens !== undefined;
  const maxTok = capSet ? o.maxTokens : MAXTOK_ENV;
  // Вариант 1: через relay-воркер (ключ живёт в секретах Cloudflare, не на сервере)
  if (cfg.relay) {
    const r = await fetch(cfg.relay, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' },
        process.env.RELAY_SECRET ? { 'x-relay-auth': process.env.RELAY_SECRET } : {}),
      body: JSON.stringify({ system, user, model: MODEL, temperature: TEMP }),
    });
    const rawTxt = await r.text();
    let d = null; try { d = JSON.parse(rawTxt); } catch {}
    if (!r.ok || !d) {
      console.error('AI relay ' + r.status + ': ' + rawTxt.slice(0, 400));
      throw new AIError((d && (d.error || d.message)) || ('ретранслятор вернул ' + r.status));
    }
    return d.text || '';
  }
  // Вариант 2: прямой вызов провайдера (OpenAI-совместимый API)
  const r = await fetch(cfg.base || 'https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + (cfg.baseKey || cfg.key),
      'X-Title': 'X-Raya',
    },
    body: JSON.stringify(Object.assign({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    TEMP === null ? {} : { temperature: TEMP },
    IS_REASONING
      ? Object.assign(
          REASONING && REASONING !== 'off' ? { reasoning_effort: REASONING } : {},
          maxTok ? { max_completion_tokens: maxTok } : {})
      : (maxTok ? { max_tokens: maxTok } : (capSet ? {} : { max_tokens: 800 })))),
  });
  // читаем как текст: провайдеры иногда отдают HTML или голый «Internal Server Error»
  const rawTxt = await r.text();
  let d = null; try { d = JSON.parse(rawTxt); } catch {}
  if (!r.ok || !d) {
    console.error('AI upstream ' + r.status + ': ' + rawTxt.slice(0, 400));
    const msg = (d && d.error && (d.error.message || d.error)) || (d && d.message) ||
                (rawTxt.trim().slice(0, 120) || ('провайдер вернул ' + r.status));
    // OpenRouter режет запросы с российских IP. Пользователю — нейтрально,
    // подробности пишем в лог сервера: лечится заданием AI_RELAY_URL.
    if (/security policy|access denied/i.test(String(msg))) {
      console.error('AI: OpenRouter отклонил запрос с IP сервера (' + msg + '). Задай AI_RELAY_URL, чтобы ходить через ретранслятор.');
      throw new AIError('AI временно недоступен — попробуй ещё раз чуть позже');
    }
    throw new AIError(msg);
  }
  const ch0 = (d.choices && d.choices[0]) || {};
  const text = (ch0.message && ch0.message.content) || '';
  if (!text) {
    const u = d.usage || {};
    const think = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
    console.error('AI: пустой ответ модели, finish_reason=' + (ch0.finish_reason || '?') +
                  ', лимит=' + (maxTok || 'не задан') + ', usage=' + JSON.stringify(u));
    lastAIFail = { когда: new Date().toISOString(), модель: MODEL, лимит_в_запросе: maxTok || 'не задавали',
                   finish_reason: ch0.finish_reason || '?', usage: u, на_рассуждения: think };
    // Пользователю — нейтрально и по делу; цифры и причина лежат в /api/ai/diag
    throw new AIError(ch0.finish_reason === 'length'
      ? 'AI не смог дописать ответ — попробуй ещё раз или опиши задачу короче'
      : 'AI вернул пустой ответ — попробуй ещё раз');
  }
  // finish_reason отдаём наверх: 'length' значит, что ответ оборвался на середине
  // и JSON в нём, скорее всего, недописан — вызывающий решит, что с этим делать.
  return { text, finish: ch0.finish_reason || '' };
}
// Подробности последнего пустого ответа модели — чтобы не лазить в логи Coolify.
// Отдаются в /api/ai/diag, который закрыт паролем статистики.
let lastAIFail = null;

function handleAI(req, res) {
  // Доступ открыт всем; защита от абьюза — лимит по IP
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(aiHits, ip, AI_LIMIT)) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто — лимит ' + AI_LIMIT + ' AI-запросов в час' }));
  if (!aiConfig().ok) return send(res, 500, 'application/json', JSON.stringify({ error: 'AI не настроен: задай AI_BASE_URL + AI_API_KEY либо AI_RELAY_URL' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    bump('ai', req, body.vid); track('ai', req, { vid: body.vid });
    const system = body.system || '', user = body.user || '';
    if (!user) return send(res, 400, 'application/json', JSON.stringify({ error: 'нет поля user' }));
    try {
      send(res, 200, 'application/json', JSON.stringify({ text: (await askAI(system, user)).text }));
    } catch (e) {
      send(res, e instanceof AIError ? e.status : 500, 'application/json',
        JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

// ═══════════ Подборки Candy: описание словами → JSON-фильтр ATS ═══════════
// Промпт со схемой полей, правилами синтаксиса и проверенными примерами живёт
// в candy-prompt.md рядом с сервером — правится без пересборки кода.
// Читаем один раз при первом обращении, дальше держим в памяти.
// Потолок ответа для подборки. Не отправить параметр — не значит «без потолка»:
// провайдер подставит свой умолчальный, а он маленький, и у «думающей» модели
// целиком уходит на рассуждения (ответ приходит пустой, finish_reason=length).
// Поэтому задаём явно и с большим запасом.
const CANDY_MAXTOK = parseInt(process.env.AI_MAX_TOKENS_CANDY, 10) || 32000;
// Пароль на вкладку подборок. Значение хранится только в переменной окружения.
// Не задан = вкладка открыта всем.
const CANDY_PW = String(process.env.CANDY_PASSWORD || '').trim();
const CANDY_PROMPT_FILE = path.join(__dirname, 'candy-prompt.md');
let _candyPrompt = null;
function candyPrompt() {
  if (_candyPrompt === null) {
    try { _candyPrompt = fs.readFileSync(CANDY_PROMPT_FILE, 'utf8'); }
    catch (e) { _candyPrompt = ''; console.error('Candy: не читается ' + CANDY_PROMPT_FILE + ': ' + e.message); }
  }
  return _candyPrompt;
}

// GET — заперта ли вкладка. POST {pw} — попытка открыть.
// Пароль общий, поэтому лимит на подбор высокий: он рассчитан против перебора.
function handleCandyGate(req, res) {
  if (req.method === 'GET')
    return send(res, 200, 'application/json', JSON.stringify({ locked: !!CANDY_PW }));
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(candyPwHits, ip, 300))
    return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком много попыток — подожди час' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    if (!CANDY_PW) return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
    if (String(body.pw || '').trim() !== CANDY_PW) {
      track('candy_pw_fail', req, { vid: body.vid });
      return send(res, 403, 'application/json', JSON.stringify({ error: 'неверный пароль' }));
    }
    track('candy_unlock', req, { vid: body.vid });
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}

/* ══════════ Движок подборок (candy-json) ══════════
 * Собирает фильтр детерминированно: модель только раскладывает запрос по полям и
 * ставит ссылки на справочники, а конкретные id, коды и операторы подставляет движок
 * из candy-kb и сверяет со схемой поиска. Промпт candy-prompt.md остаётся запасным
 * путём: если движок не загрузился, работает прежняя схема «модель пишет JSON сама».
 * Выключить движок принудительно: CANDY_ENGINE=off
 */
const CANDY_ENGINE_ON = String(process.env.CANDY_ENGINE || 'on').toLowerCase() !== 'off';
let candyMod = null, candyModError = null;
function candyEngine() {
  if (candyMod || candyModError || !CANDY_ENGINE_ON) return candyMod;
  try {
    // движок ходит в модель через наш askAI: один провайдер, одни лимиты, один учёт
    require('./candy-json/llm').setTransport(async ({ system, user, maxTokens }) => {
      const out = await askAI(system, user, { maxTokens: maxTokens || CANDY_MAXTOK });
      if (out.finish === 'length') throw new Error('LLM: ответ обрезан по лимиту токенов');
      return out.text;
    });
    candyMod = require('./candy-json/dialog');
    console.log('Candy: движок candy-json подключён');
  } catch (e) {
    candyModError = e.message;
    console.error('Candy: движок не загрузился, работаем по промпту:', e.message);
  }
  return candyMod;
}

// Диалоги рекрутера живут в памяти: подборка часто собирается за несколько реплик.
const candyDialogs = new Map();
const CANDY_DIALOG_TTL = 30 * 60e3;
function candyDialog(id, firstTask) {
  const now = Date.now();
  for (const [k, v] of candyDialogs) if (now - v.at > CANDY_DIALOG_TTL) candyDialogs.delete(k);
  // Первую формулировку запоминаем: дальше идут ответы на уточнения («вариант 1»,
  // «да, исключить»), и подписывать ими подборку бессмысленно.
  if (id && candyDialogs.has(id)) {
    const s = candyDialogs.get(id); s.at = now;
    return { id, dialog: s.dialog, task: s.task };
  }
  const mod = candyEngine();
  if (!mod) return null;
  const newId = crypto.randomBytes(9).toString('hex');
  const dialog = new mod.Dialog();
  candyDialogs.set(newId, { dialog, at: now, task: firstTask });
  return { id: newId, dialog, task: firstTask };
}

/* Ответ движка приводим к формату, который вкладка уже умеет читать: пояснение,
 * затем блок ```json с фильтром. Так фронт менять не нужно, а его валидатор
 * подтвердит то, что движок и так проверил по схеме. */
/* Подпись подборки. Ключи на «#» схема разрешает, а Candy показывает их в интерфейсе:
 * по ним видно, что фильтр собрала X-Raya, и с какой формулировки началось. */
function candyLabel(filter, task, explain) {
  if (!filter || filter['#name']) return filter;
  const short = String(task).replace(/\s+/g, ' ').trim();
  return Object.assign({
    '#name': 'X-Raya · ' + (short.length > 60 ? short.slice(0, 57).trimEnd() + '…' : short),
    '#description': String(explain || short).slice(0, 300),
  }, filter);
}

/* Что изменилось между прошлой и новой версией подборки. Считаем программно,
 * а не спрашиваем модель: рекрутеру важно знать точно, какие условия ушли и пришли,
 * особенно когда он просил «дай больше людей». */
function candyDiff(prev, next) {
  if (!prev || !next) return null;
  let metrics, kb;
  try { metrics = require('./candy-json/eval-metrics'); kb = require('./candy-json/kb'); }
  catch { return null; }
  const title = sig => {
    const p = sig.split(' ')[0];
    const f = kb.resolveField(p);
    return f ? f.title + ' (' + p + ')' : p;
  };
  const a = metrics.features(prev).cond, b = metrics.features(next).cond;
  const added = [...b].filter(x => !a.has(x)).map(title);
  const removed = [...a].filter(x => !b.has(x)).map(title);
  if (!added.length && !removed.length) return null;
  return { added, removed };
}

function candyText(r) {
  const parts = [];
  if (r.explain) parts.push(r.explain);
  parts.push('```json\n' + JSON.stringify(r.filter, null, 2) + '\n```');
  const rows = (r.table || []).filter(e => e.status === 'найдено');
  if (rows.length) {
    parts.push('Из чего собрано:');
    parts.push(rows.map(e => `• ${e.condition} → ${e.field} ${e.operator} ${e.value !== undefined ? JSON.stringify(e.value) : ''}`
      + (e.refFile ? ` (${e.refFile})` : '')).join('\n'));
  }
  return parts.join('\n\n');
}

function handleCandy(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(candyHits, ip, CANDY_LIMIT)) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто — лимит ' + CANDY_LIMIT + ' подборок в час' }));
  const sys = candyPrompt();
  if (!sys && !candyEngine()) return send(res, 500, 'application/json', JSON.stringify({ error: 'не найден candy-prompt.md на сервере' }));
  if (!aiConfig().ok) return send(res, 500, 'application/json', JSON.stringify({ error: 'AI не настроен: задай AI_BASE_URL + AI_API_KEY' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    // Замок проверяем и здесь, а не только на входе во вкладку: иначе его обошёл бы
    // любой прямой запрос к /api/candy, а расход на модель настоящий.
    if (CANDY_PW && String(body.pw || '') !== CANDY_PW)
      return send(res, 403, 'application/json', JSON.stringify({ error: 'нужен пароль от вкладки подборок' }));
    const task = String(body.task || '').trim().slice(0, 4000);
    if (!task) return send(res, 400, 'application/json', JSON.stringify({ error: 'нет описания подборки' }));
    // fix — вторая попытка с ошибками валидатора; refine — уточнение от рекрутера.
    // В обоих случаях прикладываем предыдущий ответ, чтобы модель правила его, а не начинала с нуля.
    const fix = String(body.fix || '').slice(0, 4000);
    const refine = String(body.refine || '').slice(0, 1000);
    const prev = String(body.prev || '').slice(0, 12000);
    bump('candy', req, body.vid);
    track(fix ? 'candy_fix' : refine ? 'candy_refine' : 'candy', req, { vid: body.vid });

    /* Основной путь — движок candy-json. Он ведёт диалог: на неоднозначный запрос
     * отвечает вопросами со списком вариантов из справочника, а фильтр отдаёт только
     * когда всё подтверждено. Ветку fix (починка синтаксиса) движку не отдаём:
     * он собирает JSON сам и чинить за собой ему нечего.
     * Если движка нет — ниже отрабатывает прежняя схема с промптом. */
    const eng = !fix && candyEngine();
    if (eng) {
      const sess = candyDialog(body.sessionId, refine || task);
      if (sess) {
        try {
          const r = await sess.dialog.send(refine || task);
          if (r.status === 'clarify') {
            return send(res, 200, 'application/json', JSON.stringify({
              sessionId: sess.id, status: 'clarify', explain: r.explain || '',
              questions: (r.questions || []).map(q => ({ question: q.question, options: q.options || null })),
              text: '', cut: false,
            }));
          }
          if (r.status === 'ok') {
            const prevFilter = candyDialogs.get(sess.id) && candyDialogs.get(sess.id).filter;
            r.filter = candyLabel(r.filter, sess.task || task, r.explain);
            const changes = candyDiff(prevFilter, r.filter);
            const st = candyDialogs.get(sess.id);
            if (st) { st.filter = r.filter; st.version = (st.version || 0) + 1; }
            return send(res, 200, 'application/json', JSON.stringify({
              sessionId: sess.id, status: 'ok', text: candyText(r),
              filter: r.filter, table: r.table || null, cut: false,
              changes, version: st ? st.version : 1,
            }));
          }
          return send(res, 200, 'application/json', JSON.stringify({
            sessionId: sess.id, status: 'error', text: '',
            error: 'Не удалось собрать фильтр: ' + (r.errors || []).join('; '),
          }));
        } catch (e) {
          console.error('Candy: движок упал, откатываюсь на промпт:', e.message);
          // не прерываем запрос: ниже отработает прежняя схема
        }
      }
    }

    // Дату сообщаем сами: у модели часов нет, а «за последние три месяца»
    // в Candy превращается в абсолютную date_gt — иначе она подставит плейсхолдер.
    let user = 'Сегодня: ' + today() + '\n\nЗадача рекрутера:\n' + task;
    if (fix) {
      user += '\n\nТвой предыдущий ответ:\n' + prev +
        '\n\nВалидатор нашёл в нём ошибки:\n' + fix +
        '\n\nИсправь их и верни ответ целиком в том же формате. Не объясняй, что было не так, — просто выдай исправленную подборку.';
    } else if (refine) {
      user += '\n\nТвой предыдущий ответ:\n' + prev +
        '\n\nРекрутер уточняет: ' + refine +
        '\n\nУчти уточнение и верни подборку целиком в том же формате.';
    }
    try {
      const out = await askAI(sys, user, { maxTokens: CANDY_MAXTOK });
      if (out.finish === 'length') console.error('Candy: ответ модели оборван по лимиту, длина ' + out.text.length);
      send(res, 200, 'application/json', JSON.stringify({ text: out.text, cut: out.finish === 'length' }));
    } catch (e) {
      send(res, e instanceof AIError ? e.status : 500, 'application/json',
        JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

/* Обратная связь по подборке: «стало больше людей?» после того, как рекрутер просил
 * расширить или сузить выдачу. Без этого мы не узнаём, попал ли движок в задачу —
 * метрика по эталонам такого не показывает. Пишем в отдельный файл рядом с данными. */
const CANDY_FB_FILE = process.env.CANDY_FEEDBACK_FILE || path.join(__dirname, 'data', 'candy-feedback.jsonl');
function handleCandyFeedback(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    if (CANDY_PW && String(body.pw || '') !== CANDY_PW)
      return send(res, 403, 'application/json', JSON.stringify({ error: 'нужен пароль от вкладки подборок' }));
    const rec = {
      t: new Date().toISOString(),
      v: visitorId(req, body.vid),
      sid: String(body.sessionId || '').slice(0, 40),
      // что рекрутер сказал про выдачу: больше / меньше / в самый раз
      verdict: String(body.verdict || '').slice(0, 20),
      task: String(body.task || '').slice(0, 500),
      note: String(body.note || '').slice(0, 500),
      version: parseInt(body.version, 10) || 1,
    };
    try { fs.appendFileSync(CANDY_FB_FILE, JSON.stringify(rec) + '\n'); }
    catch (e) { console.error('Candy: не записал отзыв:', e.message); }
    track('candy_fb', req, { vid: body.vid, ch: rec.verdict });
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}

// ═══════════ Лимиты и файлы состояния ═══════════
// Счётчик обращений по IP на скользящий час. Потолки заданы с запасом: за одним сетевым
// адресом может работать много пользователей одновременно.
const aiHits = new Map();
const candyHits = new Map();
const candyPwHits = new Map();
const AI_LIMIT = parseInt(process.env.AI_HOURLY_LIMIT, 10) || 600;
const CANDY_LIMIT = parseInt(process.env.CANDY_HOURLY_LIMIT, 10) || 200;
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || path.join(__dirname, 'data', 'feedback.jsonl');
const fbHits = new Map();
const HITS_FILE = process.env.HITS_FILE || path.join(__dirname, 'data', 'hits.json');
let dailyHits = {};
try { dailyHits = JSON.parse(fs.readFileSync(HITS_FILE, 'utf8')) || {}; } catch {}
let hitsDirty = false;

function overLimit(map, ip, max) {
  const now = Date.now();
  const hits = (map.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= max) return true;
  hits.push(now); map.set(ip, hits);
  return false;
}
function handleFeedback(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(fbHits, ip, 10)) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто — попробуй позже' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2e4) req.destroy(); });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const text = String(body.text || '').trim().slice(0, 2000);
    if (text.length < 5) return send(res, 400, 'application/json', JSON.stringify({ error: 'напиши хотя бы пару слов' }));
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    const rec = JSON.stringify({ text, email, at: new Date().toISOString() });
    try {
      fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
      fs.appendFileSync(FEEDBACK_FILE, rec + '\n');
    } catch (e) { console.error('feedback write failed:', e.message); }
    bump('feedback', req); track('feedback', req);
    const tk = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (tk && chat) {
      fetch('https://api.telegram.org/bot' + tk + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat,
          text: '💬 X-Raya: обратная связь\n' + (email ? 'от: ' + email + '\n' : '') + '\n' + text }),
      }).catch(() => {});
    }
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}

// ── счётчик поисков по дням: отложенная запись, чтобы не дёргать диск на каждый запрос ──
function flushHits() {
  if (!hitsDirty) return;
  hitsDirty = false;
  try { fs.mkdirSync(path.dirname(HITS_FILE), { recursive: true }); fs.writeFileSync(HITS_FILE, JSON.stringify(dailyHits)); }
  catch (e) { console.error('hits write failed:', e.message); }
}
setInterval(flushHits, 30000).unref && setInterval(flushHits, 30000).unref();
function handleHit(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e3) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
    // дата по МСК (UTC+3), без внешних данных
    const d = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    dailyHits[d] = (dailyHits[d] || 0) + 1;
    hitsDirty = true;
    bump('searches', req, b.vid); track('search', req, { vid: b.vid });
    res.writeHead(204); res.end();
  });
}

// ── анонимные счётчики использования: считаем действия, не людей ──
// Формат: {"YYYY-MM-DD": {searches, contacts, ai, candy, feedback, chat, visitors}}.
// visitors — уникальные посетители за день по псевдониму; сам IP не сохраняется.
const USAGE_FILE = process.env.USAGE_FILE || path.join(__dirname, 'data', 'usage.json');
let usage = {};
try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) || {}; } catch {}
let usageDirty = false;
const seenToday = { date: '', set: new Set() };
function today() { return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); }
function bump(metric, req, vid) {
  const d = today();
  const row = usage[d] = usage[d] || { searches: 0, contacts: 0, ai: 0, candidates: 0, feedback: 0, visitors: 0, chat: 0, candy: 0 };
  row[metric] = (row[metric] || 0) + 1;
  if (req) {
    if (seenToday.date !== d) { seenToday.date = d; seenToday.set = new Set(); }
    const h = visitorId(req, vid);
    if (h && h !== 'unknown' && !seenToday.set.has(h)) { seenToday.set.add(h); row.visitors = (row.visitors || 0) + 1; }
  }
  usageDirty = true;
}
setInterval(() => {
  if (!usageDirty) return;
  usageDirty = false;
  try { fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); }
  catch (e) { console.error('usage write failed:', e.message); }
}, 30000).unref();

// ═══════════ «Связь» — анонимный чат в реальном времени ═══════════
// Транспорт: SSE (сервер→клиент) + обычные POST (клиент→сервер). Без зависимостей и WebSocket —
// проходит через любой прокси. Сообщения живут 24 часа и удаляются автоматически.
const CHAT_FILE = process.env.CHAT_FILE || path.join(__dirname, 'data', 'chat.jsonl');
const CHAT_TTL = 24 * 3600e3;
const CHAT_KEEP = 300;              // сколько сообщений держим максимум
let chatMsgs = [];
try {
  chatMsgs = fs.readFileSync(CHAT_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(m => m && Date.now() - new Date(m.at).getTime() < CHAT_TTL);
} catch {}
let chatDirty = false;
const chatClients = new Set();      // активные SSE-подключения
const chatHits = new Map();         // ip → лимит сообщений

function chatSave() {
  if (!chatDirty) return;
  chatDirty = false;
  try {
    fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true });
    fs.writeFileSync(CHAT_FILE, chatMsgs.map(m => JSON.stringify(m)).join('\n') + '\n');
  } catch (e) { console.error('chat write failed:', e.message); }
}
setInterval(chatSave, 20000).unref();
// чистка протухших раз в 10 минут
setInterval(() => {
  const before = chatMsgs.length;
  chatMsgs = chatMsgs.filter(m => Date.now() - new Date(m.at).getTime() < CHAT_TTL);
  if (chatMsgs.length !== before) { chatDirty = true; chatBroadcast({ type: 'purge', keep: chatMsgs.map(m => m.id) }); }
}, 600e3).unref();

function chatBroadcast(payload) {
  const line = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const c of chatClients) { try { c.write(line); } catch {} }
}
// уникальные браузеры, а не открытые вкладки: у одного человека может быть 3 вкладки
function chatPeople() { return new Set([...chatClients].map(c => c._vid || Math.random())).size; }
function chatOnline() { chatBroadcast({ type: 'online', n: chatPeople() }); }
// публичная форма сообщения: реакции отдаём счётчиками, чужие id клиентов наружу не уходят
function chatPublic(m) {
  const reactions = {};
  for (const [emo, set] of Object.entries(m.rx || {})) if (set.length) reactions[emo] = set.length;
  return { id: m.id, nick: m.nick, hue: m.hue, text: m.text, at: m.at, reply: m.reply || null, reactions };
}
function chatStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  try { res._vid = visitorId(req, new URL(req.url, 'http://x').searchParams.get('v')); } catch { res._vid = visitorId(req); }
  chatClients.add(res);
  const fresh = chatMsgs.filter(m => Date.now() - new Date(m.at).getTime() < CHAT_TTL);
  res.write('data: ' + JSON.stringify({ type: 'init', messages: fresh.map(chatPublic), online: chatPeople() }) + '\n\n');
  chatOnline();
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  const close = () => { clearInterval(ping); chatClients.delete(res); chatOnline(); };
  req.on('close', close); req.on('error', close);
}
function chatSend(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (chatHits.get(ip) || []).filter(t => now - t < 60e3);
  if (hits.length >= 20) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком быстро — 20 сообщений в минуту' }));
  hits.push(now); chatHits.set(ip, hits);
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 4e3) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
    const text = String(b.text || '').trim().slice(0, 500);
    if (!text) return send(res, 400, 'application/json', JSON.stringify({ error: 'пустое сообщение' }));
    const nick = String(b.nick || 'АГЕНТ').trim().slice(0, 24) || 'АГЕНТ';
    const hue = Math.max(0, Math.min(359, parseInt(b.hue, 10) || 0));
    let reply = null;
    if (b.replyTo) {
      const src = chatMsgs.find(m => m.id === b.replyTo);
      if (src) reply = { id: src.id, nick: src.nick, text: src.text.slice(0, 90) };
    }
    const msg = { id: crypto.randomBytes(8).toString('hex'), nick, hue, text, at: new Date().toISOString(), reply, rx: {} };
    bump('chat', req, b.vid); track('chat_msg', req, { vid: b.vid });
    chatMsgs.push(msg);
    if (chatMsgs.length > CHAT_KEEP) chatMsgs = chatMsgs.slice(-CHAT_KEEP);
    chatDirty = true;
    chatBroadcast({ type: 'msg', msg: chatPublic(msg) });
    send(res, 200, 'application/json', JSON.stringify({ ok: true, id: msg.id }));
  });
}
function chatReact(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2e3) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
    const m = chatMsgs.find(x => x.id === b.id);
    if (!m) return send(res, 404, 'application/json', JSON.stringify({ error: 'сообщение не найдено' }));
    const emo = String(b.emoji || '').slice(0, 8);
    const who = String(b.who || '').slice(0, 40);
    if (!emo || !who) return send(res, 400, 'application/json', JSON.stringify({ error: 'нет данных' }));
    m.rx = m.rx || {};
    const set = new Set(m.rx[emo] || []);
    if (set.has(who)) set.delete(who); else set.add(who);   // повторный клик снимает реакцию
    m.rx[emo] = [...set];
    if (!m.rx[emo].length) delete m.rx[emo];
    chatDirty = true;
    chatBroadcast({ type: 'react', id: m.id, reactions: Object.fromEntries(Object.entries(m.rx).map(([e, s]) => [e, s.length])) });
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}
// «агент выходит на связь…» — эфемерное событие, нигде не хранится
function chatTyping(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e3) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
    chatBroadcast({ type: 'typing', nick: String(b.nick || '').slice(0, 24), who: String(b.who || '').slice(0, 40) });
    res.writeHead(204); res.end();
  });
}

// ═══════════ Метрики: анонимный событийный лог ═══════════
// Строит воронку «зашёл → искал → открыл ссылку → вернулся».
// Пишется только псевдоним посетителя; сам IP и тексты запросов не сохраняются.
// События старше 30 дней удаляются автоматически.
const EVENTS_FILE = process.env.EVENTS_FILE || path.join(__dirname, 'data', 'events.jsonl');
const EV_TTL_DAYS = 30;
const EV_ALLOWED = new Set(['visit', 'search', 'open', 'copy', 'ai', 'contact', 'feedback', 'miss', 'chat_msg', 'candidate', 'candy']);
let events = [];
try {
  const edge = Date.now() - EV_TTL_DAYS * 86400e3;
  events = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.t > edge);
} catch {}
let evDirty = false;
function evSave() {
  if (!evDirty) return;
  evDirty = false;
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.writeFileSync(EVENTS_FILE, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  } catch (e) { console.error('events write failed:', e.message); }
}
setInterval(evSave, 20000).unref();
// раз в час выбрасываем протухшее
setInterval(() => {
  const edge = Date.now() - EV_TTL_DAYS * 86400e3;
  const before = events.length;
  events = events.filter(e => e.t > edge);
  if (events.length !== before) evDirty = true;
}, 3600e3).unref();

// Псевдоним посетителя. Основной ключ — анонимный id браузера из localStorage: за одним
// сетевым адресом может работать много пользователей, и по IP они считались бы как один.
// Если id не передан (старая вкладка, бот), берётся необратимый хэш IP.
// Соль для необратимого хэша IP. Создаётся при первом запуске и лежит рядом с данными,
// чтобы один и тот же адрес давал один и тот же псевдоним между перезапусками. Наружу не отдаётся.
const SALT_FILE = process.env.SALT_FILE || path.join(__dirname, 'data', 'salt.key');
const HASH_SALT = (() => {
  const env = String(process.env.HASH_SALT || '').trim();
  if (env) return env;
  try { return fs.readFileSync(SALT_FILE, 'utf8').trim(); } catch {}
  const v = crypto.randomBytes(24).toString('base64url');
  try { fs.mkdirSync(path.dirname(SALT_FILE), { recursive: true }); fs.writeFileSync(SALT_FILE, v); }
  catch (e) { console.error('salt write failed:', e.message); }
  return v;
})();

function visitorId(req, given) {
  const g = String(given || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  if (g.length >= 6) return 'b' + g;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!ip) return 'unknown';
  return crypto.createHash('sha256').update(ip + '|' + HASH_SALT).digest('hex').slice(0, 12);
}
// track('search', req) — одна строка на событие; в extra кладём только неперсональное
function track(ev, req, extra) {
  if (!EV_ALLOWED.has(ev)) return;
  const rec = { t: Date.now(), v: req ? visitorId(req, extra && extra.vid) : '-', e: ev };
  if (extra && extra.ch) rec.ch = String(extra.ch).slice(0, 24);
  if (extra && extra.ref) rec.r = String(extra.ref).slice(0, 60);
  events.push(rec);
  evDirty = true;
}
// приём событий с клиента (визит, открытие ссылки, копирование) — с защитой от накрутки
const evHits = new Map();
function handleEvent(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(evHits, ip, 400)) { res.writeHead(204); return res.end(); }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 2e3) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
    track(String(b.ev || ''), req, { ch: b.ch, ref: b.ref, vid: b.vid });
    res.writeHead(204); res.end();
  });
}

// ── «пусто / не то»: промахи движка приезжают сюда, а не остаются в браузере ──
// Текст запроса сохраняем только по явному нажатию кнопки — это описано в политике данных.
const MISS_FILE = process.env.MISS_FILE || path.join(__dirname, 'data', 'misses.jsonl');
const missHits = new Map();
function handleMiss(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (overLimit(missHits, ip, 60)) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто' }));
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 4e3) req.destroy(); });
  req.on('end', () => {
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch {}
    const q = String(b.q || '').trim().slice(0, 300);
    if (!q) return send(res, 400, 'application/json', JSON.stringify({ error: 'нет запроса' }));
    const rec = {
      q,
      ch: String(b.ch || '').slice(0, 40),
      ttl: String(b.ttl || '').slice(0, 80),
      reason: String(b.reason || '').slice(0, 40),
      note: String(b.note || '').slice(0, 300),
      at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(MISS_FILE), { recursive: true });
      fs.appendFileSync(MISS_FILE, JSON.stringify(rec) + '\n');
    } catch (e) { console.error('miss write failed:', e.message); }
    track('miss', req, { ch: rec.ch, vid: b.vid });
    const tk = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (tk && chat) {
      fetch('https://api.telegram.org/bot' + tk + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat,
          text: '🎯 X-Raya: промах движка\n«' + rec.q + '»\nканал: ' + (rec.ttl || rec.ch) +
                '\nпричина: ' + rec.reason + (rec.note ? '\nкомментарий: ' + rec.note : '') }),
      }).catch(() => {});
    }
    send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  });
}

// дата по МСК (UTC+3) строкой YYYY-MM-DD
function msk(ts) { return new Date(ts + 3 * 3600e3).toISOString().slice(0, 10); }
// Окно считаем по календарным дням МСК, а не «последние N×24 часа»: «сегодня» должно
// совпадать с тем, что человек видит в жизни. 7 дней = сегодня и шесть предыдущих.
function winEdge(daysBack) {
  const mskNow = Date.now() + 3 * 3600e3;
  const mskDayStart = Math.floor(mskNow / 86400e3) * 86400e3;
  return mskDayStart - (daysBack - 1) * 86400e3 - 3 * 3600e3;
}

// Всё считается из одного источника — лога событий, по одному ключу vid (браузер).
// Поэтому «людей» в карточке, в воронке и в возвратах всегда одно и то же число.
function metricsReport(daysBack) {
  const edge = winEdge(daysBack);
  const win = events.filter(e => e.t >= edge);
  const uniq = ev => new Set(win.filter(e => e.e === ev).map(e => e.v));
  const cnt = ev => win.filter(e => e.e === ev).length;

  const visits = uniq('visit'), searches = uniq('search'), opens = uniq('open');

  // возвраты: у кого события в 2+ разных дня; D1 — вернулся на следующий день после первого
  const byV = new Map();
  for (const e of win) {
    if (!byV.has(e.v)) byV.set(e.v, new Set());
    byV.get(e.v).add(msk(e.t));
  }
  let ret2 = 0, d1 = 0, cohort = 0;
  for (const [, ds] of byV) {
    if (ds.size >= 2) ret2++;
    const sorted = [...ds].sort();
    const first = sorted[0];
    // D1 считаем только для тех, у кого был шанс вернуться (первый день не сегодня)
    if (first !== msk(Date.now())) {
      cohort++;
      const next = new Date(new Date(first + 'T00:00:00Z').getTime() + 86400e3).toISOString().slice(0, 10);
      if (ds.has(next)) d1++;
    }
  }

  // воронка: те же множества, что и в карточках — цифры сходятся по определению
  const funnel = [
    { step: 'Зашли', n: visits.size, hint: 'открыли страницу' },
    { step: 'Сделали поиск', n: searches.size, hint: 'ввели запрос или вакансию' },
    { step: 'Открыли ссылку', n: opens.size, hint: 'кликнули хотя бы один канал' },
    { step: 'Вернулись', n: ret2, hint: 'заходили в разные дни' },
  ];

  // какие каналы реально открывают
  const chCount = {};
  for (const e of win) if (e.e === 'open' && e.ch) chCount[e.ch] = (chCount[e.ch] || 0) + 1;
  const channels = Object.entries(chCount).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([ch, n]) => ({ ch, n }));

  return {
    days: daysBack,
    since: msk(edge),
    people: visits.size,
    actions: {
      searches: cnt('search'), opens: cnt('open'), candy: cnt('candy'),
      contacts: cnt('contact'), ai: cnt('ai'), misses: cnt('miss'),
    },
    // сколько человек (не действий) дошло до каждой функции
    reach: { searches: searches.size, opens: opens.size, candy: uniq('candy').size,
             contacts: uniq('contact').size, ai: uniq('ai').size },
    funnel,
    retention: {
      total: byV.size, returned: ret2,
      returnedPct: byV.size ? Math.round(ret2 / byV.size * 100) : 0,
      d1, cohort, d1Pct: cohort ? Math.round(d1 / cohort * 100) : 0,
    },
    channels,
  };
}

// График по дням — всегда 30 дней, независимо от выбранного окна наверху
function metricsDays() {
  const win = events.filter(e => e.t >= winEdge(30));
  const out = [];
  for (let i = 29; i >= 0; i--) {
    const d = msk(Date.now() - i * 86400e3);
    const dayEv = win.filter(e => msk(e.t) === d);
    out.push({
      date: d,
      people: new Set(dayEv.filter(e => e.e === 'visit').map(e => e.v)).size,
      searches: dayEv.filter(e => e.e === 'search').length,
    });
  }
  return out;
}

function handleStats(req, res) {
  const token = statsToken();
  if (!token) return send(res, 501, 'application/json', JSON.stringify({ error: 'STATS_TOKEN_X (или STATS_TOKEN) не задан на сервере' }));
  const url = new URL(req.url, 'http://x');
  const given = req.headers['x-stats-token'] || url.searchParams.get('token') || '';
  if (given !== token) return send(res, 401, 'application/json', JSON.stringify({ error: 'неверный пароль' }));

  const readJsonl = f => {
    try {
      return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  const feedback = readJsonl(FEEDBACK_FILE);
  const sum = k => Object.values(usage).reduce((a, r) => a + (r[k] || 0), 0);

  send(res, 200, 'application/json', JSON.stringify({
    // Два блока намеренно разделены и считаются по-разному:
    // lifetime — счётчики действий из usage.json, живут вечно, «сколько раз сделано»;
    // windows  — лог событий за 30 дней, ключ vid, «сколько человек и что делали».
    // Смешивать их нельзя, поэтому «людей за всё время» здесь нет: лог столько не хранит.
    lifetime: {
      searches: sum('searches') || Object.values(dailyHits).reduce((a, b) => a + b, 0),
      candy: sum('candy'),
      contacts: sum('contacts'),
      ai: sum('ai'),
      feedback: feedback.length,
    },
    windows: { d1: metricsReport(1), d7: metricsReport(7), d30: metricsReport(30) },
    days: metricsDays(),
    evTtlDays: EV_TTL_DAYS,
    feedback: feedback.slice(-40).reverse(),
    misses: readJsonl(MISS_FILE).slice(-60).reverse(),
  }));
}

// ── проверка ника: существует ли профиль на площадках ──
// kind 'status': 200 → найден, 404 → нет; kind 'string': 200 и есть маркер → найден.
// Площадки за Cloudflare (LeetCode, Kaggle, Behance…) не проверяем — фронт покажет «вручную».
const NICK_SITES = [
  { id: 'github',   u: n => 'https://github.com/' + n },
  { id: 'gitlab',   u: n => 'https://gitlab.com/' + n },
  { id: 'habr',     u: n => 'https://habr.com/ru/users/' + n + '/' },
  { id: 'dribbble', u: n => 'https://dribbble.com/' + n },
  { id: 'vk',       u: n => 'https://vk.com/' + n },
  { id: 'telegram', u: n => 'https://t.me/' + n, kind: 'string', str: 'tgme_page_title' },
];
const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const nickHits = new Map();
const nickCache = new Map(); // nick → {at, data}

async function checkSite(site, nick) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(site.u(nick), {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA_CHROME, 'accept-language': 'ru,en;q=0.8' },
    });
    if (site.kind === 'string') {
      if (r.status !== 200) return 'unknown';
      const html = await r.text();
      return html.includes(site.str) ? 'found' : 'none';
    }
    if (r.status === 200) return 'found';
    if (r.status === 404) return 'none';
    return 'unknown';
  } catch { return 'unknown'; }
  finally { clearTimeout(tm); }
}

function handleNick(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (nickHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 60) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто' }));
  hits.push(now); nickHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const nick = String(body.nick || '').trim();
    if (!/^[\w.\-]{2,32}$/.test(nick))
      return send(res, 400, 'application/json', JSON.stringify({ error: 'некорректный ник' }));
    const cached = nickCache.get(nick.toLowerCase());
    if (cached && now - cached.at < 3600e3)
      return send(res, 200, 'application/json', JSON.stringify(cached.data));
    const out = {};
    await Promise.all(NICK_SITES.map(async s => { out[s.id] = await checkSite(s, nick); }));
    nickCache.set(nick.toLowerCase(), { at: now, data: out });
    if (nickCache.size > 500) nickCache.delete(nickCache.keys().next().value);
    send(res, 200, 'application/json', JSON.stringify(out));
  });
}

// ── проверка размера выдачи (Serper.dev приоритетно, иначе Google CSE) ──
const countCache = new Map(); // qhash → {at, found, approx}
const countHits = new Map();

// Serper.dev: отдаёт список органики. approx=true → found это число результатов на первой
// странице (10 = «есть много», меньше = реальное малое число, 0 = пусто).
async function countViaSerper(q, key) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST', signal: ctl.signal,
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q, num: 10, gl: 'ru', hl: 'ru' }),
    });
    const d = await r.json();
    if (!r.ok) { const e = new Error((d && (d.message || d.error)) || 'serper error'); e.code = r.status; throw e; }
    const found = Array.isArray(d.organic) ? d.organic.length : 0;
    return { found, approx: true };
  } finally { clearTimeout(tm); }
}

// Google CSE: даёт оценку общего числа результатов (approx=false → показываем ~N).
async function countViaCSE(q, key, cx) {
  const u = 'https://www.googleapis.com/customsearch/v1?key=' + encodeURIComponent(key) +
    '&cx=' + encodeURIComponent(cx) + '&num=1&fields=searchInformation(totalResults)&q=' + encodeURIComponent(q);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    const d = await r.json();
    if (!r.ok) { const e = new Error((d.error && d.error.message) || 'cse error'); e.code = /quota|limit/i.test(e.message) ? 429 : 502; throw e; }
    const found = parseInt((d.searchInformation && d.searchInformation.totalResults) || '0', 10) || 0;
    return { found, approx: false };
  } finally { clearTimeout(tm); }
}

function handleCount(req, res) {
  const serper = process.env.SERPER_KEY;
  const cseKey = process.env.GOOGLE_CSE_KEY, cseCx = process.env.GOOGLE_CSE_CX;
  if (!serper && !(cseKey && cseCx)) return send(res, 501, 'application/json', JSON.stringify({ error: 'not_configured' }));
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (countHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 200) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто' }));
  hits.push(now); countHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const q = String(body.q || '').trim().slice(0, 800);
    if (q.length < 3) return send(res, 400, 'application/json', JSON.stringify({ error: 'пустой запрос' }));
    const ck = q.toLowerCase();
    const cached = countCache.get(ck);
    if (cached && now - cached.at < 24 * 3600e3)
      return send(res, 200, 'application/json', JSON.stringify({ found: cached.found, approx: cached.approx, cached: true }));
    try {
      const out = serper ? await countViaSerper(q, serper) : await countViaCSE(q, cseKey, cseCx);
      countCache.set(ck, { at: now, found: out.found, approx: out.approx });
      if (countCache.size > 3000) countCache.delete(countCache.keys().next().value);
      send(res, 200, 'application/json', JSON.stringify(out));
    } catch (e) {
      send(res, e.code || 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }));
    }
  });
}

// ── пробив контактов через SignalHire Person API (sync, withoutWaterfall) ──
// Идентификатор: LinkedIn URL / email / телефон. 1 успешный мэтч = 1 кредит SignalHire.
const SH_URL = process.env.SH_API_URL || 'https://www.signalhire.com/api/v1/candidate/search';
const shCache = new Map(); // item(lower) → {at, data} — повторный лукап не жжёт кредит
const shHits = new Map();

function validContactItem(s) {
  if (/^https?:\/\/([\w-]+\.)?linkedin\.com\/(in|sales)\/\S+$/i.test(s)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return true;
  if (/^\+?[\d\s\-().]{7,20}$/.test(s)) return true;
  return false;
}

function handleContact(req, res) {
  // Защита от абьюза — лимит по IP, 30 обращений в час
  const key = process.env.SIGNALHIRE_KEY || process.env.SIGNALHIRE_API;
  if (!key) return send(res, 501, 'application/json', JSON.stringify({ error: 'not_configured' }));
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (shHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 30) return send(res, 429, 'application/json', JSON.stringify({ error: 'слишком часто — лимит 30 пробивов в час' }));
  hits.push(now); shHits.set(ip, hits);

  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e4) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    bump('contacts', req, body.vid); track('contact', req, { vid: body.vid });
    const item = String(body.item || '').trim().slice(0, 300);
    if (!validContactItem(item))
      return send(res, 400, 'application/json', JSON.stringify({ error: 'нужна ссылка на LinkedIn-профиль, email или телефон' }));
    const ck = item.toLowerCase();
    const cached = shCache.get(ck);
    if (cached && now - cached.at < 7 * 24 * 3600e3)
      return send(res, 200, 'application/json', JSON.stringify(Object.assign({ cached: true }, cached.data)));
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(SH_URL, {
        method: 'POST', signal: ctl.signal,
        headers: { apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify({ items: [item], withoutWaterfall: true }),
      });
      clearTimeout(tm);
      const credits = parseInt(r.headers.get('x-credits-left') || '', 10);
      if (r.status === 402) return send(res, 402, 'application/json', JSON.stringify({ error: 'кредиты SignalHire закончились' }));
      if (r.status === 401) return send(res, 502, 'application/json', JSON.stringify({ error: 'SignalHire: неверный ключ' }));
      if (r.status === 429) return send(res, 429, 'application/json', JSON.stringify({ error: 'SignalHire: слишком много запросов, подожди минуту' }));
      const arr = await r.json();
      if (!r.ok || !Array.isArray(arr))
        return send(res, 502, 'application/json', JSON.stringify({ error: (arr && (arr.error || arr.message)) || 'SignalHire error' }));
      const it = arr[0] || {};
      if (it.status !== 'success') {
        const msg = it.status === 'credits_are_over' ? 'кредиты SignalHire закончились'
          : it.status === 'duplicate_query' ? 'повторный запрос — подожди пару минут'
          : 'профиль не найден в базе SignalHire';
        const code = it.status === 'credits_are_over' ? 402 : 200;
        return send(res, code, 'application/json', JSON.stringify({ status: it.status || 'failed', error: msg, credits: isNaN(credits) ? null : credits }));
      }
      const c = it.candidate || {};
      const contacts = (Array.isArray(c.contacts) ? c.contacts : [])
        .filter(x => x && x.value && (x.type === 'email' || x.type === 'phone'))
        .map(x => ({ type: x.type, value: String(x.value), rating: x.rating || null, subType: x.subType || null }));
      const exp0 = Array.isArray(c.experience) && c.experience[0] ? c.experience[0] : null;
      const data = {
        status: 'success',
        fullName: c.fullName || '',
        headline: c.headLine || (exp0 ? [exp0.position, exp0.company].filter(Boolean).join(' · ') : ''),
        location: (Array.isArray(c.locations) && c.locations[0] && c.locations[0].name) || '',
        contacts,
        credits: isNaN(credits) ? null : credits,
      };
      shCache.set(ck, { at: now, data });
      if (shCache.size > 1000) shCache.delete(shCache.keys().next().value);
      send(res, 200, 'application/json', JSON.stringify(data));
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });
}

const STATS_PAGE = path.join(__dirname, 'stats.html');

const server = http.createServer((req, res) => {
  // www → bare-домен
  const rhost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (rhost === 'www.x-raya.space') {
    res.writeHead(301, { location: 'https://x-raya.space' + req.url });
    return res.end();
  }
  if (req.method === 'POST' && req.url === '/api/ai') return handleAI(req, res);
  if (req.method === 'POST' && req.url === '/api/candy') return handleCandy(req, res);
  if (req.url.split('?')[0] === '/api/candy/gate' && (req.method === 'GET' || req.method === 'POST')) return handleCandyGate(req, res);
  if (req.method === 'POST' && req.url === '/api/candy/feedback') return handleCandyFeedback(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/ai/diag') return handleAIDiag(req, res);
  if (req.method === 'POST' && req.url === '/api/nick') return handleNick(req, res);
  if (req.method === 'POST' && req.url === '/api/count') return handleCount(req, res);
  if (req.method === 'POST' && req.url === '/api/contact') return handleContact(req, res);
  if (req.method === 'POST' && req.url === '/api/hit') return handleHit(req, res);
  if (req.method === 'POST' && req.url === '/api/feedback') return handleFeedback(req, res);
  if (req.method === 'POST' && req.url === '/api/ev') return handleEvent(req, res);
  if (req.method === 'POST' && req.url === '/api/miss') return handleMiss(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/chat/stream') return chatStream(req, res);
  if (req.method === 'POST' && req.url === '/api/chat/send') return chatSend(req, res);
  if (req.method === 'POST' && req.url === '/api/chat/react') return chatReact(req, res);
  if (req.method === 'POST' && req.url === '/api/chat/typing') return chatTyping(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/help') {
    return fs.readFile(path.join(__dirname, 'help.html'), (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'help.html not found');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/stats') return handleStats(req, res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/stats') {
    return fs.readFile(STATS_PAGE, (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'stats.html not found');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/privacy') {
    return fs.readFile(path.join(__dirname, 'privacy.html'), (err, data) => {
      if (err) return send(res, 500, 'text/plain', 'privacy.html not found');
      send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
  // OG-превью для шаринга в мессенджерах
  if (req.method === 'GET' && req.url.split('?')[0] === '/og.png') {
    return fs.readFile(path.join(__dirname, 'og.png'), (err, data) => {
      if (err) return send(res, 404, 'text/plain', 'not found');
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(data);
    });
  }
  // локальные шрифты
  if (req.method === 'GET' && req.url.startsWith('/fonts/') && req.url.indexOf('.woff2') !== -1) {
    const name = path.basename(req.url.split('?')[0]); // защита от path traversal
    return fs.readFile(path.join(__dirname, 'fonts', name), (err, data) => {
      if (err) return send(res, 404, 'text/plain', 'not found');
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
      res.end(data);
    });
  }
  // всё остальное — отдаём одностраничник
  fs.readFile(INDEX, (err, data) => {
    if (err) return send(res, 500, 'text/plain', 'index.html not found');
    send(res, 200, 'text/html; charset=utf-8', data);
  });
});

server.listen(PORT, () => {
  console.log('X-Raya запущен на порту ' + PORT);
  console.log('AI: модель ' + MODEL + (IS_REASONING ? ' (думающая, reasoning_effort=' + REASONING + ')' : '') +
    ', лимит ответа ' + (MAXTOK_ENV || (IS_REASONING ? 'без лимита' : 800)));
  const _ai = aiConfig();
  if (_ai.base && _ai.baseKey) console.log('AI: напрямую к провайдеру ' + _ai.base.replace(/^https?:\/\//, '').split('/')[0]);
  else if (_ai.relay) console.log('AI: через ретранслятор ' + _ai.relay.replace(/^https?:\/\//, '').split('/')[0]);
  else if (_ai.key) console.log('⚠ AI: напрямую в OpenRouter — с российского IP он это блокирует, задай AI_BASE_URL + AI_API_KEY');
  else console.log('⚠ AI не настроен: задай AI_BASE_URL + AI_API_KEY');
  console.log('Подборки Candy: лимит ответа ' + CANDY_MAXTOK +
    ', вкладка ' + (CANDY_PW ? 'под паролем (CANDY_PASSWORD)' : 'открыта всем — пароль не задан'));
  // Движок грузится лениво, но проверяем его сразу: иначе о том, что в образ не попали
  // candy-json или candy-kb, узнаем только когда рекрутер уже ждёт ответа.
  if (!CANDY_ENGINE_ON) console.log('Подборки Candy: движок выключен (CANDY_ENGINE=off), работает промпт candy-prompt.md');
  else if (candyEngine()) console.log('Подборки Candy: движок candy-json готов, справочники на месте');
  else console.error('Подборки Candy: движок недоступен' + (candyModError ? ' (' + candyModError + ')' : '') +
    ' — работает запасной путь по промпту');
});
