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

// --- check 3: stdout discipline -------------------------------------------
// MCP runs on stdio and stdout carries protocol frames. One console.log in
// shared code breaks the server, and it breaks it in a way that looks like a
// client bug. See docs/code-style.md §12.
const STDOUT_WRITERS = [/\bconsole\.(log|info|debug|dir|table)\s*\(/];
const STDOUT_ALLOWED = new Set([
  // Entry points whose stdout is their product, and which are never the MCP
  // server. Each writes with process.stdout.write, not console.log.
]);

for (const file of walk('src')) {
  if (STDOUT_ALLOWED.has(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const pattern of STDOUT_WRITERS) {
      if (pattern.test(line)) {
        violations.push(
          `${file}:${index + 1} writes to stdout with console.* — stdout is reserved for MCP protocol frames`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error('guard: failed\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nSee docs/rules-and-constraints.md T1 and §7.');
  process.exit(1);
}

console.error(
  `guard: ok. ${scanned} source file(s) scanned. No frontier-model API, no console.* writing to stdout.`,
);
