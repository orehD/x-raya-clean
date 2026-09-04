// Генерация двух отчётов в .docx:
//   1) «Подборки — сравнение с эталонами» — по каждой подборке: запрос, метрики,
//      условия с цветовой разметкой (совпало / потеряно / добавлено) и оба JSON.
//   2) «Эвалы — методика и результаты» — как измеряли и что из этого вышло.
//
// Данные берутся из .eval-last.json (сохранённый прогон) — модель заново не дёргается.
// Запуск: node report-docx.js [папка назначения]
'use strict';
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType, PageBreak,
} = require(path.join(process.env.HOME, 'node_modules', 'docx'));

const { features, dropService, f1 } = require('./eval-metrics');

const KB = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'candy-kb', p), 'utf-8'));
const presets = KB('presets.json');
const examples = KB('query_examples.json');
const saved = JSON.parse(fs.readFileSync(path.join(__dirname, '.eval-last.json'), 'utf-8'));

/* ── палитра: те же роли, что в PDF-отчёте ── */
const C = {
  ink: '131922', muted: '4A5462', faint: '77828F',
  ok: '1F6B64',        // совпало с эталоном
  missing: 'A9652F',   // есть в эталоне, движок не поставил
  extra: '2F6BA9',     // движок добавил сверх эталона
  bad: '9E3B3B',
  line: 'D8DEE6', soft: 'F2F5F7',
};
const FONT = 'Arial';
const MONO = 'Consolas';

const t = (text, opts = {}) => new TextRun({ text, font: opts.mono ? MONO : FONT, ...opts });
const p = (children, opts = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], ...opts });
const spacer = (after = 120) => new Paragraph({ children: [], spacing: { after } });

function goldFor(name, q){
  const pr = presets.find(x => x.name === name);
  if (pr && pr.filter && !pr.filter._parse_error) return pr.filter;
  const e = examples.find(x => (x.explanation || '').trim() === (q || '').trim());
  return e && e.filter;
}

/* Компактная запись фильтра построчно — читаемее сырого JSON */
function outline(filter, depth = 0, out = []){
  if (!filter || typeof filter !== 'object') return out;
  const pad = '  '.repeat(depth);
  for (const [key, val] of Object.entries(filter)){
    if (key.startsWith('#')) continue;
    if (key === '$and' || key === '$or'){
      out.push(`${pad}${key === '$and' ? 'И' : 'ИЛИ'}:`);
      (val || []).forEach(v => outline(v, depth + 1, out));
    } else if (key === '$not'){
      out.push(`${pad}НЕ:`);
      outline(val, depth + 1, out);
    } else if (val && typeof val === 'object' && val.nested_any){
      out.push(`${pad}${key} →`);
      outline(val.nested_any.filter, depth + 1, out);
    } else {
      const op = Object.keys(val || {})[0];
      if (!op) continue;
      const body = val[op] || {};
      const v = 'values' in body ? body.values : body.value;
      const shown = Array.isArray(v)
        ? (v.length > 6 ? `[${v.slice(0, 6).join(', ')} … ещё ${v.length - 6}]` : `[${v.join(', ')}]`)
        : JSON.stringify(v);
      out.push(`${pad}${key} ${op} ${shown}`);
    }
  }
  return out;
}

const border = { style: BorderStyle.SINGLE, size: 1, color: C.line };
const borders = { top: border, bottom: border, left: border, right: border };
const cell = (children, width, shade) => new TableCell({
  borders, width: { size: width, type: WidthType.DXA },
  shading: shade ? { fill: shade, type: ShadingType.CLEAR } : undefined,
  margins: { top: 60, bottom: 60, left: 110, right: 110 },
  children: Array.isArray(children) ? children : [children],
});

const pct = x => `${Math.round((x || 0) * 100)}%`;

/* ────────────────────────────── документ 1 ────────────────────────────── */
function buildComparison(){
  const kids = [];
  kids.push(p(t('Подборки: что собрал движок и чем это отличается от эталона', { bold: true, size: 34, color: C.ink }),
    { spacing: { after: 120 } }));
  kids.push(p(t('Прогон 29 боевых подборок Candy. Запрос взят дословно из описания подборки, эталон — её же фильтр, написанный рекрутером. Модель gpt-5-mini через VseGPT.',
    { size: 20, color: C.muted }), { spacing: { after: 200 } }));

  // легенда
  kids.push(p([
    t('Как читать разметку: ', { size: 20, color: C.muted }),
    t('совпало с эталоном', { size: 20, color: C.ok, bold: true }),
    t(' · ', { size: 20, color: C.faint }),
    t('есть в эталоне, движок не поставил', { size: 20, color: C.missing, bold: true }),
    t(' · ', { size: 20, color: C.faint }),
    t('движок добавил сверх эталона', { size: 20, color: C.extra, bold: true }),
  ], { spacing: { after: 100 } }));
  kids.push(p(t('Условия сравниваются по признаку «поле + семейство оператора»: string_eq и string_one_of по одному набору id дают одинаковую выдачу и считаются совпадением. Служебный блок исключений (сотрудники, читеры, негативное увольнение) движок добавляет сам и в сравнении не участвует.',
    { size: 18, color: C.faint }), { spacing: { after: 80 } }));
  kids.push(p(t('Две точности. «Точность» считает все условия движка, «точность по сужающим» — только те, что стоят вне $or. Ветка $or расширяет выдачу и лишней быть не может, поэтому вторая цифра честнее показывает, не отсекает ли движок нужных кандидатов.',
    { size: 18, color: C.faint }), { spacing: { after: 300 } }));

  // сводная таблица
  const rows = [];
  const stats = [];
  for (const s of saved){
    const gold = goldFor(s.name, s.q);
    if (!gold) continue;
    if (!s.filter){ stats.push({ ...s, gold, r: 0, pn: 0, f: 0, failed: s.failed }); continue; }
    const got = features(s.filter), want = features(gold);
    const wantCore = dropService(want.cond);
    const cond = wantCore.size ? f1(dropService(got.cond), wantCore) : f1(got.cond, want.cond);
    const gotNarrow = dropService(got.narrowing);
    const narrow = f1(gotNarrow, dropService(want.narrowing));
    stats.push({ ...s, gold, r: cond.r, p: cond.p, pn: wantCore.size ? (gotNarrow.size ? narrow.p : 1) : cond.p, f: cond.f,
      matched: [...dropService(got.cond)].filter(x => wantCore.has(x)),
      missing: cond.missing, extra: cond.extra });
  }

  rows.push(new TableRow({ children: [
    cell(p(t('Подборка', { bold: true, size: 18, color: C.faint })), 4400, C.soft),
    cell(p(t('Полнота', { bold: true, size: 18, color: C.faint })), 1400, C.soft),
    cell(p(t('Точность', { bold: true, size: 18, color: C.faint })), 1400, C.soft),
    cell(p(t('F1', { bold: true, size: 18, color: C.faint })), 1200, C.soft),
    cell(p(t('Условий', { bold: true, size: 18, color: C.faint })), 1000, C.soft),
  ] }));
  for (const s of stats){
    const color = s.failed ? C.bad : (s.r >= 0.8 ? C.ok : (s.r >= 0.5 ? C.ink : C.missing));
    rows.push(new TableRow({ children: [
      cell(p(t(s.name, { size: 19, color: C.ink })), 4400),
      cell(p(t(s.failed ? '—' : pct(s.r), { size: 19, color, bold: true })), 1400),
      cell(p(t(s.failed ? '—' : pct(s.pn), { size: 19, color: C.ink })), 1400),
      cell(p(t(s.failed ? '—' : pct(s.f), { size: 19, color: C.muted })), 1200),
      cell(p(t(s.failed ? 'сбой' : String((s.matched || []).length + (s.missing || []).length), { size: 19, color: C.muted })), 1000),
    ] }));
  }
  kids.push(p(t('Сводка по всем подборкам', { bold: true, size: 26, color: C.ink }), { spacing: { after: 140 } }));
  kids.push(new Table({ width: { size: 9400, type: WidthType.DXA }, columnWidths: [4400, 1400, 1400, 1200, 1000], rows }));
  kids.push(spacer(200));
  const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  kids.push(p([
    t('Среднее: ', { size: 20, color: C.muted }),
    t(`полнота ${pct(avg(stats.map(s => s.r)))}`, { size: 20, color: C.ok, bold: true }),
    t(`, точность по сужающим условиям ${pct(avg(stats.map(s => s.pn)))}`, { size: 20, color: C.muted }),
    t(`. Дошли до фильтра ${stats.filter(s => !s.failed).length} из ${stats.length}.`, { size: 20, color: C.muted }),
  ]));

  // подробности по каждой подборке
  for (const s of stats){
    kids.push(new Paragraph({ children: [new PageBreak()] }));
    kids.push(p(t(s.name, { bold: true, size: 28, color: C.ink }), { spacing: { after: 60 } }));
    kids.push(p(t(`Запрос: ${s.q}`, { size: 19, color: C.muted, italics: true }), { spacing: { after: 140 } }));

    if (s.failed){
      kids.push(p(t('Движок не собрал фильтр: остались неснятые уточнения или сбой обращения к модели.',
        { size: 20, color: C.bad })));
      continue;
    }

    kids.push(p([
      t('Полнота ', { size: 20, color: C.muted }), t(pct(s.r), { size: 20, color: C.ok, bold: true }),
      t('   ·   Точность ', { size: 20, color: C.muted }), t(pct(s.p), { size: 20, color: C.ink, bold: true }),
      t('   ·   Точность по сужающим ', { size: 20, color: C.muted }), t(pct(s.pn), { size: 20, color: C.ink, bold: true }),
      t('   ·   F1 ', { size: 20, color: C.muted }), t(pct(s.f), { size: 20, color: C.muted, bold: true }),
    ], { spacing: { after: 60 } }));
    if (s.pn === 0 && s.matched.length)
      kids.push(p(t('Точность по сужающим 0% означает, что совпавшие условия лежат внутри ветки $or — она расширяет выдачу и в этой метрике не считается, а сужающие условия ($and) с эталоном не совпали.',
        { size: 17, color: C.faint, italics: true }), { spacing: { after: 140 } }));
    else kids.push(spacer(100));

    // условия с разметкой
    kids.push(p(t('Условия', { bold: true, size: 22, color: C.ink }), { spacing: { after: 80 } }));
    const line = (txt, color, prefix) => p([
      t(prefix, { mono: true, size: 18, color, bold: true }),
      t(txt, { mono: true, size: 18, color }),
    ], { spacing: { after: 30 } });
    if (!s.matched.length && !s.missing.length && !s.extra.length)
      kids.push(p(t('нет содержательных условий для сравнения', { size: 19, color: C.faint })));
    s.matched.forEach(x => kids.push(line(x, C.ok, '= ')));
    s.missing.forEach(x => kids.push(line(x, C.missing, '− ')));
    s.extra.forEach(x => kids.push(line(x, C.extra, '+ ')));
    kids.push(spacer(160));

    // два фильтра рядом — построчной записью
    const two = new Table({
      width: { size: 9400, type: WidthType.DXA },
      columnWidths: [4700, 4700],
      rows: [
        new TableRow({ children: [
          cell(p(t('Собрал движок', { bold: true, size: 18, color: C.faint })), 4700, C.soft),
          cell(p(t('Эталон рекрутера', { bold: true, size: 18, color: C.faint })), 4700, C.soft),
        ] }),
        new TableRow({ children: [
          cell(outline(s.filter).map(l => p(t(l, { mono: true, size: 15, color: C.ink }), { spacing: { after: 10 } })), 4700),
          cell(outline(s.gold).map(l => p(t(l, { mono: true, size: 15, color: C.muted }), { spacing: { after: 10 } })), 4700),
        ] }),
      ],
    });
    kids.push(two);
  }

  return new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } },
      children: kids,
    }],
  });
}

/* ────────────────────────────── документ 2 ────────────────────────────── */
function buildEvalReport(){
  const kids = [];
  const h1 = txt => p(t(txt, { bold: true, size: 34, color: C.ink }), { spacing: { after: 140 } });
  const h2 = txt => p(t(txt, { bold: true, size: 26, color: C.ink }), { spacing: { before: 260, after: 120 } });
  const h3 = txt => p(t(txt, { bold: true, size: 22, color: C.ink }), { spacing: { before: 160, after: 80 } });
  const txtp = (s, opts = {}) => p(t(s, { size: 20, color: C.muted, ...opts }), { spacing: { after: 100 } });

  kids.push(h1('Как измерялось качество движка подборок'));
  kids.push(txtp('Движок переводит запрос рекрутера в JSON-фильтр поиска Candy. Документ фиксирует методику замера, историю прогонов и выводы — чтобы результат можно было воспроизвести и обсудить, а не принимать на веру.'));

  kids.push(h2('Текущее состояние'));
  const tiles = new Table({
    width: { size: 9400, type: WidthType.DXA }, columnWidths: [2350, 2350, 2350, 2350],
    rows: [
      new TableRow({ children: [
        cell(p(t('Доходимость', { size: 18, color: C.faint })), 2350, C.soft),
        cell(p(t('Полнота', { size: 18, color: C.faint })), 2350, C.soft),
        cell(p(t('Точность по сужающим', { size: 18, color: C.faint })), 2350, C.soft),
        cell(p(t('Цена запроса', { size: 18, color: C.faint })), 2350, C.soft),
      ] }),
      new TableRow({ children: [
        cell(p(t('28 / 29', { size: 30, bold: true, color: C.ink })), 2350),
        cell(p(t('69%', { size: 30, bold: true, color: C.ok })), 2350),
        cell(p(t('66%', { size: 30, bold: true, color: C.missing })), 2350),
        cell(p(t('~1 ₽', { size: 30, bold: true, color: C.ink })), 2350),
      ] }),
    ],
  });
  kids.push(tiles);
  kids.push(spacer(160));

  kids.push(h2('Что именно считаем'));
  kids.push(txtp('Фильтры не сравниваются побайтово: у одной задачи много правильных записей. Каждое условие сводится к признаку «поле + семейство оператора», например resumes.workExperience.position text≈, и дальше сравниваются множества.'));
  const metricRows = [
    ['Полнота', 'доля условий эталона, которые движок воспроизвёл', 'потерянное условие рекрутер не заметит и получит не тех людей'],
    ['Точность', 'доля условий движка, которые есть в эталоне', 'лишнее условие сужает выдачу, но видно в таблице проверки'],
    ['Доходимость', 'сколько кейсов дошло до готового фильтра', 'ловит сбои, зацикленные уточнения и отказы движка'],
    ['F1 по значениям', 'совпадение конкретных литералов: id, коды, строки', 'показывает, берутся ли значения из справочников'],
  ];
  kids.push(new Table({
    width: { size: 9400, type: WidthType.DXA }, columnWidths: [1900, 3600, 3900],
    rows: [
      new TableRow({ children: [
        cell(p(t('Метрика', { bold: true, size: 18, color: C.faint })), 1900, C.soft),
        cell(p(t('Что означает', { bold: true, size: 18, color: C.faint })), 3600, C.soft),
        cell(p(t('Почему важна', { bold: true, size: 18, color: C.faint })), 3900, C.soft),
      ] }),
      ...metricRows.map(r => new TableRow({ children: [
        cell(p(t(r[0], { size: 19, bold: true, color: C.ink })), 1900),
        cell(p(t(r[1], { size: 19, color: C.muted })), 3600),
        cell(p(t(r[2], { size: 19, color: C.muted })), 3900),
      ] })),
    ],
  }));

  kids.push(h3('Две нормализации, без которых цифры врут'));
  kids.push(txtp('Семейства операторов. string_eq и string_one_of по одному набору id дают одинаковую выдачу. Различать их — штрафовать за форму записи, а не за смысл. Даты не склеиваем: date_gt и date_lt означают разное.'));
  kids.push(txtp('Служебный блок исключений (сотрудники, читеры, негативное увольнение) движок добавляет сам по ответу «да». К пониманию запроса он отношения не имеет, а в эталонах есть не везде — из сравнения исключён.'));

  kids.push(new Paragraph({ children: [new PageBreak()] }));
  kids.push(h2('Две выборки, и почему их цифры несравнимы'));
  kids.push(txtp('Это главное, что стоит проговорить при обсуждении результатов.'));
  kids.push(h3('Выборка А — 8 кейсов, F1 90–93%'));
  kids.push(txtp('Формулировки запросов писались вручную, уже с эталонным фильтром перед глазами. В такой фразе фактически лежит подсказка — и поле, и дата, и признак: «риск-менеджеры, которые сейчас работают риск-менеджером и начали до 28 января 2025». Модель решала задачу «переложи готовое ТЗ в JSON», а не «пойми рекрутера». Цифра честная для той постановки, но мерила не то.'));
  kids.push(h3('Выборка Б — 29 кейсов, полнота 69%'));
  kids.push(txtp('Запрос берётся дословно из описания боевой подборки — того, что рекрутер писал для коллег, а не для нейросети: «Потенциальные ML-продакты», «Исключаем заведомо неподходящих кандидатов». Кейсы собираются автоматически из выгрузки подборок; четыре подборки-донора few-shot исключены, чтобы не измерять воспроизведение подсказки.'));
  kids.push(h3('Симулятор рекрутера'));
  kids.push(txtp('На выборке Б модель начала задавать уточняющие вопросы — правильное поведение по CJM. Но метрика их не понимала: 18 кейсов из 21 получили ноль просто потому, что диалог не закрылся. Теперь на вопросы отвечает вторая модель в роли рекрутера: она видит только исходную формулировку, эталон ей недоступен. Доходимость выросла с 3/21 до 28/29.'));

  kids.push(h2('Хронология прогонов'));
  kids.push(txtp('Этап 1 — выборка А, ручные формулировки.'));
  const a = [
    ['A0', 'Базовая версия: правила и справочники', '64%', '28%'],
    ['A1', 'Внедрены готовые наборы значений — с багами', '13%', '16%'],
    ['A2', 'Починены выбор варианта и служебный блок в метрике', '50%', '35%'],
    ['A3', 'Синхронизирована проверка оператора в сборщике', '80%', '64%'],
    ['A5', 'Нормализация семейств операторов, temperature 0', '80%', '69%'],
    ['A6', 'Служебный блок приведён к нормализованным именам', '92%', '66%'],
    ['A10', 'Ретраи на лимит запросов', '93%', '76%'],
  ];
  kids.push(new Table({
    width: { size: 9400, type: WidthType.DXA }, columnWidths: [900, 5300, 1600, 1600],
    rows: [
      new TableRow({ children: [
        cell(p(t('Шаг', { bold: true, size: 18, color: C.faint })), 900, C.soft),
        cell(p(t('Что изменилось', { bold: true, size: 18, color: C.faint })), 5300, C.soft),
        cell(p(t('F1 условия', { bold: true, size: 18, color: C.faint })), 1600, C.soft),
        cell(p(t('F1 значения', { bold: true, size: 18, color: C.faint })), 1600, C.soft),
      ] }),
      ...a.map((r, i) => new TableRow({ children: [
        cell(p(t(r[0], { mono: true, size: 18, color: C.faint })), 900),
        cell(p(t(r[1], { size: 19, color: C.ink, bold: i === a.length - 1 })), 5300),
        cell(p(t(r[2], { mono: true, size: 19, color: i === a.length - 1 ? C.ok : C.ink, bold: i === a.length - 1 })), 1600),
        cell(p(t(r[3], { mono: true, size: 19, color: C.muted })), 1600),
      ] })),
    ],
  }));
  kids.push(spacer(160));
  kids.push(txtp('Этап 2 — выборка Б, дословные описания подборок.'));
  const b = [
    ['B0', 'Перевод на описания подборок', '3/21', '—', '—', '32%'],
    ['B1', 'Few-shot из боевых подборок, закрытие нескольких уточнений', '—', '—', '—', '37%'],
    ['B2', 'Симулятор рекрутера', '25/25', '—', '—', '54%'],
    ['B5', 'Устойчивость к сбоям сети и лимитов', '23/29', '59%', '49%', '51%'],
    ['B6', 'Автокоррекция путей полей', '26/29', '67%', '51%', '54%'],
    ['B7', 'Объединение источников роли в один $or', '28/29', '69%', '66%', '55%'],
  ];
  kids.push(new Table({
    width: { size: 9400, type: WidthType.DXA }, columnWidths: [800, 4200, 1300, 1050, 1050, 1000],
    rows: [
      new TableRow({ children: [
        cell(p(t('Шаг', { bold: true, size: 18, color: C.faint })), 800, C.soft),
        cell(p(t('Что изменилось', { bold: true, size: 18, color: C.faint })), 4200, C.soft),
        cell(p(t('Доходимость', { bold: true, size: 18, color: C.faint })), 1300, C.soft),
        cell(p(t('Полнота', { bold: true, size: 18, color: C.faint })), 1050, C.soft),
        cell(p(t('Точность', { bold: true, size: 18, color: C.faint })), 1050, C.soft),
        cell(p(t('F1', { bold: true, size: 18, color: C.faint })), 1000, C.soft),
      ] }),
      ...b.map((r, i) => new TableRow({ children: [
        cell(p(t(r[0], { mono: true, size: 18, color: C.faint })), 800),
        cell(p(t(r[1], { size: 19, color: C.ink, bold: i === b.length - 1 })), 4200),
        cell(p(t(r[2], { mono: true, size: 19, color: i === b.length - 1 ? C.ok : C.ink, bold: i === b.length - 1 })), 1300),
        cell(p(t(r[3], { mono: true, size: 19, color: i === b.length - 1 ? C.ok : C.muted })), 1050),
        cell(p(t(r[4], { mono: true, size: 19, color: C.muted })), 1050),
        cell(p(t(r[5], { mono: true, size: 19, color: C.muted })), 1000),
      ] })),
    ],
  }));
  kids.push(spacer(120));
  kids.push(txtp('Точность в строке B7 — по сужающим условиям: после объединения роли в $or прежняя метрика штрафовала за каждую ветку, хотя ветка $or выдачу расширяет, а не режет.', { size: 18, color: C.faint }));

  kids.push(new Paragraph({ children: [new PageBreak()] }));
  kids.push(h2('Что дало прирост'));
  const wins = [
    ['Готовые наборы значений', 'Рекрутеры уже выверили списки: 14 написаний банков, топ-вузы, уровни английского, 36 кодов этапа «Трудоустройство». Движок подставляет набор целиком. F1 по значениям вырос с 28% до 76% — модель перестала выдумывать свои списки.'],
    ['Автокоррекция путей', 'Модель регулярно пишет hiringProcesses.levels, хотя levels живёт на корне кандидата. Рекрутер такую ошибку исправить не может — движок знает модель данных и чинит путь сам. Плюс три дошедших кейса.'],
    ['Симулятор рекрутера', 'Превратил бессмысленную метрику в осмысленную: уточняющий диалог перестал засчитываться как провал.'],
    ['Нормализация метрики', 'Трижды «регресс качества» оказывался дефектом измерения: несовпадение имён после нормализации, штраф за служебный блок, штраф за вопросы.'],
  ];
  for (const [title, body] of wins){
    kids.push(p(t(title, { bold: true, size: 21, color: C.ok }), { spacing: { before: 120, after: 40 } }));
    kids.push(txtp(body));
  }

  kids.push(h2('Развилка, которая снялась одним решением'));
  kids.push(txtp('Три итерации маятника: «всегда добавляй оба поля резюме» — 8 лишних условий; «только по явному упоминанию» — 6 потерянных; «почти всегда должность» — 9 лишних. Причина в данных: половина боевых подборок ищет роль только по специализации процесса, половина — ещё и по резюме, и из текста описания это не выводится.'));
  kids.push(txtp('Спор оказался ложным. Правильный ответ — добавлять, но в тот же $or. Роль подтверждается любым источником; раньше источники попадали в $and, и кандидат должен был подойти сразу по всем — выдача схлопывалась.'));
  const code = [
    '// было: логическое И — кандидат обязан совпасть по обоим источникам',
    '{"$and":[',
    '  {"hiringProcesses":{"nested_any":{"filter":{"specializationId":…}}}},',
    '  {"resumes":{"nested_any":{"filter":{"workExperience":…"position":…}}}}',
    ']}',
    '',
    '// стало: одно свидетельство роли из любого источника',
    '{"$or":[',
    '  {"hiringProcesses":{"nested_any":{"filter":{"specializationId":…}}}},',
    '  {"resumes":{"nested_any":{"filter":{"$or":[',
    '     {"declaredSpecialization":…}, {"workExperience":{"nested_any":…"position":…}}',
    '  ]}}}}',
    ']}',
  ];
  kids.push(new Table({
    width: { size: 9400, type: WidthType.DXA }, columnWidths: [9400],
    rows: [new TableRow({ children: [cell(
      code.map(l => p(t(l, { mono: true, size: 16, color: l.startsWith('// было') ? C.bad : (l.startsWith('// стало') ? C.ok : C.ink) }), { spacing: { after: 10 } })),
      9400, C.soft)] })],
  }));

  kids.push(h2('Практики, которые из этого следуют'));
  const rules = [
    ['Детерминированное важнее вероятностного', 'Всё, что можно вычислить кодом — id, коды, наборы значений, пути полей — приходит из справочника. Модель ставит ссылку, движок её разрешает. Галлюцинация id исключена архитектурно, а не запретом в промпте.'],
    ['Fail-closed', 'Не подтверждено справочником — фильтр не выдаётся, задаётся вопрос. Лучше уточнить, чем молча выдать не тех кандидатов.'],
    ['Движок чинит то, чего рекрутер не знает', 'Неверный путь поля, массив под одиночным оператором, корневое поле внутри вложенной группы — ошибки формы, а не смысла. Их незачем выносить в диалог.'],
    ['Метрику проверять так же придирчиво, как код', 'Иначе дефект измерения читается как регресс продукта и толкает чинить работающее.'],
    ['Разделять обучающую и проверочную выборки', 'Подборки-доноры few-shot исключены из замера.'],
    ['Различать сужающие и расширяющие условия', 'Лишнее условие в $and отсекает кандидатов, лишняя ветка в $or — нет. Метрика, которая их не различает, ведёт к неверным решениям.'],
    ['Полнота приоритетнее точности', 'Потерянное условие невидимо для рекрутера, лишнее — видно в таблице проверки и снимается одной репликой.'],
    ['Сохранять результаты прогона', 'Прогон занимает ~25 минут и стоит денег; формулу метрики надо уметь пересчитывать на сохранённых фильтрах.'],
  ];
  rules.forEach(([title, body], i) => {
    kids.push(p([
      t(String(i + 1).padStart(2, '0') + '  ', { mono: true, size: 18, color: C.ok }),
      t(title, { bold: true, size: 21, color: C.ink }),
    ], { spacing: { before: 120, after: 40 } }));
    kids.push(txtp(body));
  });

  kids.push(h2('Ограничения и что дальше'));
  kids.push(txtp('У сравнения с эталонами есть потолок. Описания подборок неоднозначны, и два рекрутера соберут разные, но одинаково правильные фильтры. «Бизнес-аналитики с английским» — искать роль по специализации процесса, по заявленной специализации в резюме, по должности в опыте или по всем сразу? Все варианты защитимы.'));
  kids.push(txtp('Поэтому следующий честный шаг — не догонять цифру, а проверить на живых рекрутерах: сколько раз выдача устроила с первого раза и сколько реплик ушло на доводку.'));
  kids.push(txtp('Ближайший технический прирост лежит в справочниках. Чаще всего теряются условия воронки: коды этапов, причины закрытия, даты перехода в статус. Нужны наборы под формулировки вроде «без отказа на финальном интервью» и расшифровка 42 кодов этапов, которых нет в справочнике.'));

  return new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } },
      children: kids,
    }],
  });
}

/* ────────────────────────────── запуск ────────────────────────────── */
async function main(){
  const outDir = process.argv[2] || path.join(process.env.HOME, 'Desktop');
  const jobs = [
    ['Подборки — сравнение с эталонами.docx', buildComparison()],
    ['Эвалы — методика и результаты.docx', buildEvalReport()],
  ];
  for (const [name, doc] of jobs){
    const buf = await Packer.toBuffer(doc);
    const file = path.join(outDir, name);
    fs.writeFileSync(file, buf);
    console.log(`${name} — ${Math.round(buf.length / 1024)} КБ`);
  }
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
