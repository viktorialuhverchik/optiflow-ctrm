#!/usr/bin/env node
/**
 * `pnpm mcp:smoke` — drive the MCP server as a real client over stdio.
 *
 * It checks the things that break quietly: that the tools are advertised, that
 * `get_price_quote` needs no model, that a bad argument comes back as a tool
 * error rather than a crash, and that a refusal to guess a pricing window is
 * still a refusal here.
 *
 * `--with-model` adds a `parse_recap` call, which loads five gigabytes and takes
 * about forty seconds, so it is off by default.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function textOf(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text ?? '').join('\n');
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { 'with-model': { type: 'boolean', default: false } } });

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/mcp/server.ts'],
  });
  const client = new Client({ name: 'optiflow-smoke', version: '0.1.0' });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    check('both tools advertised', JSON.stringify(names) === '["get_price_quote","parse_recap"]', names.join(', '));

    // --- a plain lookup, no model ------------------------------------------
    const single = (await client.callTool({
      name: 'get_price_quote',
      arguments: {
        quote_code: 'PLATTS_FOB_MED_ITALY_GASOIL_01',
        date_or_period: '2026-09-04',
        statistic: 'mean',
      },
    })) as ToolResult;
    const singleBody = JSON.parse(textOf(single)) as { value: string; quotations_used: unknown[] };
    check('single-day lookup', singleBody.value === '631.23', `value ${singleBody.value}`);
    check('lookup returns its working', singleBody.quotations_used.length === 1);

    // --- a window that spans a weekend --------------------------------------
    const window = (await client.callTool({
      name: 'get_price_quote',
      arguments: {
        quote_code: 'PLATTS_FOB_MED_ITALY_GASOIL_01',
        date_or_period: 'B/L +0/+3',
        statistic: 'mean',
        bl_date: '2026-09-04',
      },
    })) as ToolResult;
    const windowBody = JSON.parse(textOf(window)) as {
      value: string;
      non_publication_days: number;
      quotations_used: unknown[];
    };
    check('B/L-relative window', windowBody.value === '629.29', `value ${windowBody.value}`);
    check('weekend days reported, not averaged in', windowBody.non_publication_days === 2);

    // --- refusing to guess ---------------------------------------------------
    const noAnchor = (await client.callTool({
      name: 'get_price_quote',
      arguments: {
        quote_code: 'PLATTS_FOB_MED_ITALY_GASOIL_01',
        date_or_period: 'B/L +0/+3',
        statistic: 'mean',
      },
    })) as ToolResult;
    check(
      'refuses a B/L period with no B/L date',
      noAnchor.isError === true,
      textOf(noAnchor).slice(0, 60),
    );

    const unknownCode = (await client.callTool({
      name: 'get_price_quote',
      arguments: {
        quote_code: 'PLATTS_CIF_NWE_GASOLINE',
        date_or_period: '2026-09-04',
        statistic: 'mean',
      },
    })) as ToolResult;
    check('rejects a quotation we do not hold', unknownCode.isError === true);

    const pastCoverage = (await client.callTool({
      name: 'get_price_quote',
      arguments: {
        quote_code: 'PLATTS_FOB_MED_ITALY_GASOIL_01',
        date_or_period: '2026-10-27..2026-11-05',
        statistic: 'mean',
      },
    })) as ToolResult;
    const pastBody = JSON.parse(textOf(pastCoverage)) as { outside_coverage: boolean };
    check('flags a window past the data we hold', pastBody.outside_coverage === true);

    // --- the model path -------------------------------------------------------
    if (values['with-model'] === true) {
      const parsed = (await client.callTool(
        {
          name: 'parse_recap',
          arguments: {
            text: readFileSync('data/recap_03.txt', 'utf8'),
            reference_date: '2026-08-24',
          },
        },
        undefined,
        // The default request timeout is a minute. Loading five gigabytes and
        // decoding a forty-field object takes most of that on this machine.
        { timeout: 300_000 },
      )) as ToolResult;
      const body = JSON.parse(textOf(parsed)) as {
        open_questions: number;
        deal: { pricing: { differential: { value: { value: string | null } } } };
      };
      check('parse_recap returns questions', body.open_questions > 0, `${body.open_questions} open`);
      check(
        'parse_recap refuses the unstated differential',
        body.deal.pricing.differential.value.value === null,
      );
    }

    const width = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) {
      process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}\n`);
    }
    const failed = checks.filter((c) => !c.ok).length;
    process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`);
    return failed === 0 ? 0 : 1;
  } finally {
    await client.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
