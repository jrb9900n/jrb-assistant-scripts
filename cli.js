#!/usr/bin/env node
// cli.js — Interactive command-line interface for ad-hoc agent tasks
// Usage: node cli.js [taskType] "your task description"
//   or:  node cli.js  (interactive prompt mode)

import 'dotenv/config';
import { createInterface } from 'readline';
import { runAgent } from './core/agent.js';
import { logger } from './core/logger.js';

const TASK_TYPES = ['email', 'crm', 'report', 'code', 'file', 'general'];

async function runTask(taskType, task) {
  if (!TASK_TYPES.includes(taskType)) {
    taskType = 'general';
  }

  console.log(`\n🤖 Running agent [${taskType}]...\n`);

  const { result, usage } = await runAgent({ task, taskType });

  console.log('\n─────────────────────────────────────────');
  console.log(result);
  console.log('─────────────────────────────────────────');
  console.log(`\n📊 Tokens: ${usage.input + usage.output} (model: ${usage.model})\n`);
}

// One-shot mode: node cli.js email "summarise my inbox"
if (process.argv.length >= 4) {
  const [,, taskType, ...rest] = process.argv;
  await runTask(taskType, rest.join(' '));
  process.exit(0);
}

// One-shot with auto taskType: node cli.js "summarise my inbox"
if (process.argv.length === 3) {
  await runTask('general', process.argv[2]);
  process.exit(0);
}

// Interactive REPL mode
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log('\n🤖 J.R. Boehlke Executive Agent');
console.log('Type your task. Prefix with task type (email/crm/report/code/file) for better routing.');
console.log('Example: "email: summarise my inbox"   or just "what invoices are overdue?"');
console.log('Type "exit" to quit.\n');

function prompt() {
  rl.question('> ', async (input) => {
    if (!input.trim() || input.trim() === 'exit') {
      console.log('Bye.');
      rl.close();
      return;
    }

    // Parse optional "taskType: task" prefix
    const match = input.match(/^(email|crm|report|code|file):\s*(.+)/i);
    const taskType = match ? match[1].toLowerCase() : 'general';
    const task = match ? match[2] : input;

    try {
      await runTask(taskType, task);
    } catch (err) {
      console.error('Error:', err.message);
    }

    prompt();
  });
}

prompt();
