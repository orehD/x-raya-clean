// Метрика качества LLM-слоя: прогон бизнес-формулировок через полный конвейер
// и сравнение с эталонными боевыми фильтрами (пресеты + примеры из таблицы Алисы).
//
//   node eval.js            — прогон всех кейсов
//   node eval.js 3          — только первые 3 (экономия бюджета VseGPT)
//
// Сравниваем не побайтово (у одной задачи много валидных формулировок), а по
// признакам: какие поля, операторы и значения попали в фильтр. Считаем
// precision/recall по множеству условий «поле+оператор» и отдельно сверяем id.
'use strict';
const fs = require('fs');
const path = require('path');
const { Dialog } = require('./dialog');
const { features, dropService, f1 } = require('./eval-metrics');
const { chat } = require('./llm');

const KB = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', p), 'utf-8'));
const presets = KB('presets.json');
const examples = KB('query_examples.json');

/* Кейсы собираются автоматически: описание боевой подборки — это и есть запрос,
 * который сформулировал рекрутер, а её фильтр — эталон. Плюс примеры из таблицы
 * «Подборки база Candy». Ручной список не ведём: он устаревает и сужает выборку. */
// Подборки-доноры few-shot примеров в промпте. Их держим вне метрики: иначе
// измеряли бы, как модель воспроизводит показанный ей же ответ.
const TRAIN = require('./fewshot').DONOR_PRESETS;

function buildCases(){
  const out = [];
  for (const p of presets){
    if (!p.filter || p.filter._parse_error) continue;
    if (TRAIN.includes(p.name)) continue;
    const d = (p.description || '').trim();
    if (d.length < 25) continue;
    out.push({ q: d, gold: p.filter, name: p.name });
  }
  for (const e of examples){
    if (!e.filter || e.filter._parse_error) continue;
    const d = (e.explanation || '').trim();
    if (d.length < 20) continue;
    out.push({ q: d, gold: e.filter, name: 'пример: ' + d.slice(0, 30) });
  }
  return out;
}
const CASES = buildCases();

/* Симулятор рекрутера: отвечает на уточняющие вопросы ассистента, опираясь только
 * на свою исходную формулировку. Эталонный фильтр ему недоступен — иначе мы бы
 * измеряли подсказку, а не работу движка. */
const RECRUITER_SYS = `Ты рекрутер Т-Банка. Ты уже отправил ассистенту запрос на подборку кандидатов, и он задаёт уточняющие вопросы.
Отвечай коротко и по делу, обычным текстом (без JSON и без списков-нумерации).
Правила:
- Отвечай только то, что следует из твоего запроса или из здравого смысла рекрутера.
- Если ассистент предлагает пронумерованные варианты — назови номер (например «вариант 1» или «1 и 3»). Если подходят все — так и скажи.
- Если спрашивает про исключение сотрудников, читеров и уволенных по критичной причине — отвечай «да, исключить».
- Если вопрос про детали, которых ты не задавал (конкретные даты, пороги, списки слов) — отвечай «на твоё усмотрение, возьми разумный вариант».
- Не придумывай новые требования сверх исходного запроса.`;

async function recruiterAnswer(query, questions){
  const qs = (questions || []).map((q, i) => {
    const opts = (q.options || []).map((o, j) => `   ${j + 1}) ${o.label}`).join('\n');
    return `${i + 1}. ${q.question}${opts ? '\n' + opts : ''}`;
  }).join('\n');
  try {
    return await chat({
      system: RECRUITER_SYS,
      messages: [{ role: 'user', content: `Мой исходный запрос: ${query}\n\nВопросы ассистента:\n${qs}\n\nОтветь на все вопросы одним коротким сообщением.` }],
      maxTokens: 500,
    });
  } catch (_){
    return 'первый вариант, исключения нужны, остальное на твоё усмотрение';
  }
}

async function main(){
  const limit = Number(process.argv[2]) || CASES.length;
  const cases = CASES.filter(c => c.gold).slice(0, limit);
  console.log(`Модель: ${process.env.VSEGPT_MODEL || '(из .env)'}`);
  console.log(`Прогон ${cases.length} кейсов (эталоны найдены)\n${'='.repeat(70)}`);
  const scores = [];
  for (const c of cases){
    process.stdout.write(`\n▸ [${c.name}] «${c.q.slice(0, 90)}»\n`);
    await new Promise(r => setTimeout(r, 1200)); // лимит VseGPT: 1 запрос в секунду
    const d = new Dialog();
    let r;
    // Сбой сети или лимита не должен ронять весь прогон: кейс помечаем и идём дальше.
    try { r = await d.send(c.q); }
    catch (e){ console.log('  💥 LLM:', e.message); scores.push({ name: c.name, q: c.q, f: 0, vf: 0, failed: 'llm' }); continue; }
    // На уточнения отвечает симулятор рекрутера: он знает только исходную
    // формулировку (эталонный фильтр ему не показываем) и отвечает так, как ответил бы
    // живой человек. Без этого метрика штрафовала бы движок за сам факт вопроса —
    // хотя уточняющий диалог прямо предусмотрен CJM.
    let rounds = 0, broke = false;
    while (r.status === 'clarify' && rounds++ < 4){
      try {
        const answer = await recruiterAnswer(c.q, r.questions);
        r = await d.send(answer);
      } catch (e){ console.log('  💥 диалог:', e.message); broke = true; break; }
    }
    if (broke){ scores.push({ name: c.name, q: c.q, f: 0, vf: 0, failed: 'llm' }); continue; }
    if (r.status !== 'ok'){
      const why = r.status === 'error' ? r.errors : (r.questions || []).map(q => q.question);
      console.log('  ⚠ статус:', r.status, JSON.stringify(why).slice(0, 300));
      scores.push({ name: c.name, q: c.q, f: 0, vf: 0, failed: r.status });
      continue;
    }
    const got = features(r.filter), want = features(c.gold);
    // Если эталон состоит только из служебных условий (подборка «очисти базу»),
    // сравнивать после их отбрасывания нечего — тогда меряем по полным множествам.
    const wantCore = dropService(want.cond);
    const cond = wantCore.size ? f1(dropService(got.cond), wantCore) : f1(got.cond, want.cond);
    const vals = wantCore.size ? f1(dropService(got.vals), dropService(want.vals)) : f1(got.vals, want.vals);
    // Точность считаем только по сужающим (AND) условиям: лишняя ветка внутри $or
    // расширяет выдачу и вреда не наносит.
    const gotNarrow = dropService(got.narrowing);
    const narrow = f1(gotNarrow, dropService(want.narrowing));
    // Нет сужающих условий — нет и лишних сужений: точность полная, а не нулевая.
    cond.pNarrow = wantCore.size ? (gotNarrow.size ? narrow.p : 1) : cond.p;
    scores.push({ name: c.name, q: c.q, f: cond.f, p: cond.p, pn: cond.pNarrow, r: cond.r, vf: vals.f,
      missing: cond.missing, extra: cond.extra, filter: r.filter });
    console.log(`  условия (поле+оператор): F1 ${(cond.f * 100).toFixed(0)}%  (точность ${(cond.p * 100).toFixed(0)}%, полнота ${(cond.r * 100).toFixed(0)}%)`);
    console.log(`  значения:                F1 ${(vals.f * 100).toFixed(0)}%`);
    if (cond.missing.length) console.log('  не хватило:', cond.missing.slice(0, 5).join(' | '));
    if (cond.extra.length) console.log('  лишнее:    ', cond.extra.slice(0, 5).join(' | '));
    console.log('  🧭', (r.explain || '').slice(0, 160));
  }
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const ok = scores.filter(s => !s.failed);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Дошли до фильтра: ${ok.length}/${scores.length}`);
  // Полнота важнее точности: потерянное условие рекрутер не увидит, а лишнее видно
  // в таблице проверки и снимается одной репликой в диалоге.
  console.log(`ПОЛНОТА  (условия эталона воспроизведены): ${(avg(scores.map(s => s.r || 0)) * 100).toFixed(0)}%`);
  console.log(`ТОЧНОСТЬ (условия движка есть в эталоне):  ${(avg(scores.map(s => s.p || 0)) * 100).toFixed(0)}%`);
  console.log(`ТОЧНОСТЬ по сужающим условиям (без $or):   ${(avg(scores.map(s => s.pn || 0)) * 100).toFixed(0)}%`);
  console.log(`Средний F1 по условиям: ${(avg(scores.map(s => s.f)) * 100).toFixed(0)}%`);
  console.log(`Средний F1 по значениям: ${(avg(scores.map(s => s.vf || 0)) * 100).toFixed(0)}%`);

  // Сводка ошибок: что чаще всего теряем и что добавляем лишнего — по ней видно,
  // какое правило промпта или какой справочник чинить следующим.
  const tally = (key) => {
    const c = {};
    for (const s of scores) for (const x of (s[key] || [])) c[x] = (c[x] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  const show = (title, rows) => { if (rows.length){ console.log(`\n${title}`); rows.forEach(([x, n]) => console.log(`  ${String(n).padStart(2)}× ${x}`)); } };
  show('Чаще всего НЕ ХВАТАЕТ (движок не поставил условие эталона):', tally('missing'));
  show('Чаще всего ЛИШНЕЕ (движок добавил сверх эталона):', tally('extra'));
  const weak = scores.filter(s => s.f < 0.7).sort((a, b) => a.f - b.f);
  if (weak.length){
    console.log('\nСлабые кейсы (F1 < 70%):');
    weak.forEach(s => console.log(`  ${(s.f * 100).toFixed(0)}%  [${s.name}] ${s.q.slice(0, 80)}`));
  }
  // Собранные фильтры сохраняем: метрику потом можно пересчитать без новых
  // обращений к модели — прогон 25 кейсов стоит времени и денег.
  fs.writeFileSync(path.join(__dirname, '.eval-last.json'), JSON.stringify(scores, null, 2));
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
