// Few-shot примеры для промпта: реальные боевые подборки, разобранные в DSL-спеку.
// Показывают модели паттерны, которые правилами объяснить труднее, чем примером:
// связка «компания + должность» внутри одного места работы, $or из нескольких этапов,
// $not внутри вложенного фильтра, ссылки на готовые наборы значений.
//
// DONOR_PRESETS исключаются из метрики (eval.js), иначе мы измеряли бы способность
// модели воспроизвести показанный ей же ответ.
'use strict';

const DONOR_PRESETS = ['Юристы', 'Java jun | jun+', 'Проверенные', 'Сопровождение'];

const EXAMPLES = [
  {
    q: 'Кандидаты со специализацией Юристы, работающие в банках, дилерских и авто-компаниях. Исключены текущие сотрудники, читеры, бывшие с негативной причиной увольнения',
    spec: {
      conditions: { all: [
        { intent: 'специализация Юристы', field: 'hiringProcesses.specializationId', op: 'string_one_of', ref: { kind: 'specialization', query: 'Юристы' } },
        { same: 'resumes.workExperience', mode: 'any', children: [
          { all: [
            { intent: 'работает в банке', field: 'resumes.workExperience.company', op: 'text_phrase', value: 'Банк' },
            { intent: 'должность юрист', field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Юрист' },
          ] },
          { all: [
            { intent: 'работает у дилера', field: 'resumes.workExperience.company', op: 'text_phrase', value: 'Дилер' },
            { intent: 'должность юрист', field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Юрист' },
          ] },
          { all: [
            { intent: 'работает в авто-компании', field: 'resumes.workExperience.company', op: 'text_phrase', value: 'Авто' },
            { intent: 'должность юрист', field: 'resumes.workExperience.position', op: 'text_phrase', value: 'Юрист' },
          ] },
        ] },
      ] },
      exclusions: true,
    },
    why: 'Пары «компания + должность» должны совпасть в ОДНОМ месте работы, поэтому each пара — all внутри same:"resumes.workExperience" с mode:"any". Роль здесь названа явно в связке с компанией, блок declaredSpecialization не нужен.',
  },
  {
    q: 'Кандидаты, которые ранее общались с нами и успешно проходили скрининг, техническое или финальное интервью',
    spec: {
      conditions: { all: [
        { any: [
          { intent: 'прошёл HR-скрининг', field: 'hiringProcesses.events.plainEventState', op: 'int_one_of', ref: { kind: 'stageGroup', query: 'прошли скрининг' } },
          { intent: 'прошёл техническое интервью', field: 'hiringProcesses.events.plainEventState', op: 'int_one_of', ref: { kind: 'stageGroup', query: 'прошли техничку' } },
          { intent: 'прошёл финальное интервью', field: 'hiringProcesses.events.plainEventState', op: 'int_one_of', ref: { kind: 'stageGroup', query: 'прошли финал' } },
        ] },
      ] },
      exclusions: true,
    },
    why: '«Скрининг ИЛИ техничка ИЛИ финал» — три отдельные ветки any по наборам этапов, а не один общий список: так подборка остаётся читаемой и совпадает с боевой.',
  },
  {
    q: 'Java-разработчики с опытом от полугода до двух лет. Исключены fullstack-разработчики и фрилансеры',
    spec: {
      conditions: { all: [
        { intent: 'специализация Java', field: 'hiringProcesses.specializationId', op: 'string_eq', ref: { kind: 'specialization', query: 'Java Developer' } },
        { same: 'resumes.workExperience', children: [
          { intent: 'должность про Java', field: 'resumes.workExperience.position', op: 'text_match', value: 'Java' },
          { intent: 'начал работать не раньше', field: 'resumes.workExperience.startDate', op: 'date_gt', value: '2023-09-01' },
          { not: { intent: 'исключить fullstack', field: 'resumes.workExperience.position', op: 'text_match', value: 'Fullstack' } },
        ] },
      ] },
      exclusions: true,
    },
    why: 'Исключение по должности живёт ВНУТРИ той же same-группы: убираем места работы, где позиция fullstack, а не кандидатов целиком. Диапазон опыта переводим в дату начала работы.',
  },
  {
    q: 'Кандидаты, подходящие в нормативное сопровождение, с опытом работы в банках за последние три года',
    spec: {
      conditions: { all: [
        { same: 'resumes.workExperience', children: [
          { intent: 'работал в банке', field: 'resumes.workExperience.company', op: 'text_phrase', ref: { kind: 'valueGroup', query: 'банки' } },
          { any: [
            { intent: 'работает сейчас', field: 'resumes.workExperience.isCurrent', op: 'bool_eq', value: true },
            { intent: 'или начал за последние три года', field: 'resumes.workExperience.startDate', op: 'date_gt', value: '2023-09-01' },
          ] },
        ] },
        { intent: 'специализация нормативного сопровождения', field: 'hiringProcesses.specializationId', op: 'string_one_of', ref: { kind: 'specialization', query: 'нормативное сопровождение' } },
      ] },
      exclusions: true,
    },
    why: '«За последние три года» = работает сейчас ИЛИ начал после даты. Список банков берём готовым набором, а не перечисляем руками.',
  },
];

function fewshotBlock(){
  return EXAMPLES.map((e, i) =>
    `Пример ${i + 1}.\nЗапрос: ${e.q}\nОтвет: ${JSON.stringify({ spec: e.spec })}\nПочему так: ${e.why}`
  ).join('\n\n');
}

module.exports = { DONOR_PRESETS, EXAMPLES, fewshotBlock };
