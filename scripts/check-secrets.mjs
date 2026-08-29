#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const patterns = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['OpenAI project key', /\bsk-proj-[A-Za-z0-9_-]{40,}\b/g],
  ['OpenRouter key', /\bsk-or-v1-[A-Za-z0-9]{40,}\b/g],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g],
  ['private key', new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----', 'g')],
];

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
for (const file of files) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (contents.includes('\0')) continue;
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of contents.matchAll(pattern)) {
      const line = contents.slice(0, match.index).split('\n').length;
      findings.push(`${file}:${line}: ${label}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`High-confidence secret patterns found:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} tracked files).`);
