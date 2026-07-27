#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(__dirname, 'index.js');

let child = spawn('node', [main], { stdio: 'inherit' });

child.on('exit', (code) => {
  if (code !== null && code !== 0) console.log(`[dev] exited with code ${code}`);
});

watch(main, { persistent: false }, (event) => {
  if (event !== 'change') return;
  console.log('\n[dev] index.js changed — restarting...\n');
  child.kill('SIGTERM');
  child = spawn('node', [main], { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.log(`[dev] exited with code ${code}`);
  });
});

console.log('[dev] watching index.js for changes — edit and save to auto-restart');
