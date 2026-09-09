#!/usr/bin/env node
/**
 * T1: no OpenAI / Anthropic / Google model API anywhere in the extraction path.
 *
 * Two checks:
 *   1. no forbidden package in package.json dependencies or devDependencies
 *   2. no forbidden hostname or SDK import in src/
 *
 * Documentation is exempt: the README and docs discuss these vendors by name on
 * purpose. Only shipped source and the dependency manifest are scanned.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const FORBIDDEN_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@anthropic-ai/claude-agent-sdk',
  '@google/generative-ai',
  '@google-cloud/aiplatform',
  '@google/genai',
  'cohere-ai',
  '@mistralai/mistralai',
  'langchain',
  '@langchain/openai',
  '@langchain/anthropic',
  '@langchain/google-genai',
  'ai',
];

const FORBIDDEN_SOURCE_PATTERNS = [
  /api\.openai\.com/,
  /api\.anthropic\.com/,
  /generativelanguage\.googleapis\.com/,
  /aiplatform\.googleapis\.com/,
  /api\.mistral\.ai/,
  /api\.cohere\.(ai|com)/,
  /from\s+['"]openai['"]/,
  /from\s+['"]@anthropic-ai\//,
  /from\s+['"]@google\//,
  /OPENAI_API_KEY/,
  /ANTHROPIC_API_KEY/,
  /GEMINI_API_KEY/,
  /GOOGLE_API_KEY/,
];

/** api.openai.com style hosts are fine inside an OpenAI-*compatible* local adapter
 *  only if they point at localhost. Allow the wire format, forbid the vendor. */
const ALLOWED_HOST_PATTERN = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/;

const violations = [];

// --- check 1: dependency manifest -----------------------------------------
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
for (const name of Object.keys(declared)) {
  if (FORBIDDEN_PACKAGES.includes(name)) {
    violations.push(`package.json declares forbidden dependency "${name}"`);
  }
}

// --- check 2: source tree --------------------------------------------------
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SCANNED_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

let scanned = 0;
for (const file of walk('src')) {
  scanned += 1;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (ALLOWED_HOST_PATTERN.test(line.trim())) return;
    for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
      if (pattern.test(line)) {
        violations.push(`${file}:${index + 1} matches ${pattern}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error('guard: frontier-model API found in the extraction path\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nSee docs/rules-and-constraints.md T1.');
  process.exit(1);
}

console.error(`guard: ok. ${scanned} source file(s) scanned, no frontier-model API found.`);
