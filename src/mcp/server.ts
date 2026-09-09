#!/usr/bin/env node
/**
 * `pnpm mcp` — the MCP server, over stdio.
 *
 * Both tools come from src/mcp/tools.ts, shared with the phase 9 demo. There is
 * no second implementation of anything here.
 *
 * **stdout is reserved for protocol frames.** Every diagnostic goes to stderr.
 * One console.log in shared code breaks the transport, and it breaks it in a way
 * that looks like a client bug, which is why `pnpm guard` fails the build on any
 * console.* in src/ (code-style §12).
 *
 * The model loads lazily. `get_price_quote` has no model in it at all, and
 * making a client wait for five gigabytes to ask for a price would be absurd.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createModelExtractor } from '../extract/extractor.js';
import { findModel } from '../llm/manifest.js';
import { NodeLlamaProvider } from '../llm/node-llama.js';
import { loadManifest, requireModelFile } from '../io/model-files.js';
import { loadReferenceData } from '../io/reference-files.js';
import { registerTools } from './tools.js';
import type { Extractor } from '../extract/types.js';

function log(event: string, detail: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`);
}

const referenceData = loadReferenceData('data');

let extractor: Extractor | null = null;
let provider: NodeLlamaProvider | null = null;

async function getExtractor(): Promise<Extractor> {
  if (extractor !== null) return extractor;
  const entry = findModel(loadManifest(), 'qwen3-8b-q4km');
  log('model_loading', { model: entry.id });
  provider = await NodeLlamaProvider.create({ entry, modelPath: requireModelFile(entry) });
  extractor = createModelExtractor({ provider, referenceData });
  log('model_loaded', { model: entry.id, loadMs: Math.round(provider.loadMetrics.loadMs) });
  return extractor;
}

const server = new McpServer({ name: 'optiflow-ctrm', version: '0.1.0' });
registerTools(server, { referenceData, getExtractor, log });

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  log('mcp_ready', { tools: ['parse_recap', 'get_price_quote'] });
}

const shutdown = async (): Promise<void> => {
  if (provider !== null) await provider.dispose();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

main().catch((error: unknown) => {
  log('error', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
