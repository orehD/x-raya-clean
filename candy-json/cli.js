#!/usr/bin/env node
// Ручная проверка движка из терминала.
//
//   node cli.js "джависты, прошедшие техничку, без сотрудников"   — полный конвейер (нужен VSEGPT_API_KEY)
//   node cli.js --spec spec.json                                  — только движок, без LLM
//   node cli.js --prompt                                          — показать системный промпт интерпретатора
'use strict';
const fs = require('fs');
const { ask, buildQuery, systemPrompt } = require('./index');

async function main(){
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help'){
    console.log('node cli.js "<запрос рекрутера>" | --spec <file.json> | --prompt');
    return;
  }
  if (args[0] === '--prompt'){ console.log(systemPrompt()); return; }

  let res;
  if (args[0] === '--spec'){
    const spec = JSON.parse(fs.readFileSync(args[1], 'utf-8'));
    res = buildQuery(spec);
  } else {
    res = await ask(args.join(' '));
  }

  if (res.explain) console.log('\n🧭 ' + res.explain);
  if (res.status === 'clarify'){
    console.log('\n❓ Нужны уточнения:');
    for (const q of res.questions){
      console.log('  -', q.question);
      (q.options || []).forEach((o, i) => console.log(`      ${i + 1}. ${o.label} (${o.value})`));
    }
  } else if (res.status === 'ok'){
    console.log('\n📋 Таблица проверки:\n' + res.tableMarkdown);
    console.log('\n✅ Фильтр:\n' + JSON.stringify(res.filter, null, 2));
  } else {
    console.log('\n💥 Ошибки:', res.errors);
  }
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
