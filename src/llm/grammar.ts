/**
 * GBNF grammar for the deal object.
 *
 * This is the mechanism the brief asks about, so the reasoning is written down
 * here rather than only in the README.
 *
 * **Why a grammar and not the alternatives.** Function calling on a 7B to 14B
 * open-weights model is chat-template dependent and emits well-formed calls with
 * wrong arguments, which is exactly the failure being targeted. A JSON mode
 * guarantees parseable JSON and nothing about the fields. Retry-and-repair as a
 * primary mechanism is nondeterministic and repairs toward plausible rather than
 * correct. A grammar constrains the next token, so the shape is not a hope.
 *
 * **Why it is generated rather than hand-written.** The field list comes from
 * the Zod schema by walking it, so the two cannot drift. A cross-check test
 * asserts the grammar covers exactly `ALL_FIELDS`.
 *
 * **The three decisions that carry the abstention behaviour.**
 *
 * 1. Every value alternates with `null`. If the grammar had no legal path to
 *    "not stated", constrained decoding would force the model token by token
 *    into inventing a differential. Abstaining has to be a legal parse (B1).
 * 2. Numeric and date fields get their own token-level rules. The smoke test
 *    showed the model emitting `"30,000"` for a quantity when the grammar
 *    permitted any string. A thousands separator is where a parse silently
 *    becomes a different number.
 * 3. Quote and product codes are an alternation over the codes actually present
 *    in the reference CSVs, plus null. An invented code cannot be emitted, so it
 *    stops being a failure mode rather than becoming a validation error.
 *
 * Output is minified. Whitespace between tokens is output the model pays for and
 * nothing reads, and on a forty-field object it is not a rounding error.
 */
import { ALL_FIELDS, describeSchema, type LeafKind, type SchemaNode } from '../domain/schema.js';

export type GrammarCodes = {
  readonly productCodes: readonly string[];
  readonly quoteCodes: readonly string[];
};

/** Field paths whose value is restricted to a reference-data code. */
const CODE_FIELDS: Record<string, keyof GrammarCodes> = {
  'product.product_code': 'productCodes',
  'pricing.quote_code': 'quoteCodes',
};

/**
 * GBNF rule names accept letters, digits and hyphens only: the llama.cpp parser
 * does not treat an underscore as a word character, so `f-recap_date` silently
 * ends the rule name at the underscore and the grammar fails to parse.
 */
function ruleName(prefix: string, path: string): string {
  return `${prefix}-${path.replace(/[^A-Za-z0-9]+/g, '-')}`;
}

function quoted(value: string): string {
  return `"\\"${value}\\""`;
}

function alternation(values: readonly string[]): string {
  if (values.length === 0) throw new Error('cannot build an alternation with no values');
  return values.map(quoted).join(' | ');
}

const PREAMBLE = [
  // A JSON string with at least one character. Control characters are excluded
  // so a stray newline cannot end up inside an evidence span.
  'char ::= [^"\\\\\\n\\r\\t] | "\\\\" ["\\\\/bfnrt] | "\\\\u" hex hex hex hex',
  'hex ::= [0-9a-fA-F]',
  'text ::= "\\"" char char* "\\""',
  // Plain decimal, signed, no thousands separators, no leading zeros.
  'decimal ::= "\\"" "-"? ("0" | [1-9] [0-9]*) ("." [0-9] [0-9]*)? "\\""',
  // YYYY-MM-DD. Calendar validity is checked by Zod after decoding; the grammar
  // only guarantees the shape.
  'digit ::= [0-9]',
  'isodate ::= "\\"" digit digit digit digit "-" digit digit "-" digit digit "\\""',
  'currency ::= "\\"" [A-Z] [A-Z] [A-Z] "\\""',
  'status ::= "\\"stated\\"" | "\\"absent\\"" | "\\"ambiguous\\""',
].join('\n');

function leafRuleName(leaf: LeafKind): string {
  switch (leaf.kind) {
    case 'text':
      return 'text';
    case 'decimal':
      return 'decimal';
    case 'iso_date':
      return 'isodate';
    case 'currency':
      return 'currency';
    case 'enum':
      return '';
  }
}

/**
 * Build the grammar.
 *
 * Keys are emitted in a fixed order. That removes key-name errors entirely and
 * walks the model through the fields in the order the prompt describes them,
 * which matters more on a small model than on a large one.
 */
export function buildDealGrammar(codes: GrammarCodes): string {
  const rules: string[] = [];
  const seenValueRules = new Map<string, string>();
  let counter = 0;

  function valueRuleFor(path: string, leaf: LeafKind): string {
    const codeField = CODE_FIELDS[path];
    if (codeField !== undefined) {
      const values = codes[codeField];
      if (values.length === 0) {
        throw new Error(`no reference codes available for ${path}; the grammar would be unusable`);
      }
      const name = ruleName('v', path);
      rules.push(`${name} ::= (${alternation(values)}) | "null"`);
      return name;
    }

    if (leaf.kind === 'enum') {
      const key = `enum:${leaf.values.join('|')}`;
      const existing = seenValueRules.get(key);
      if (existing !== undefined) return existing;
      counter += 1;
      const name = `v-enum${counter}`;
      rules.push(`${name} ::= (${alternation(leaf.values)}) | "null"`);
      seenValueRules.set(key, name);
      return name;
    }

    const base = leafRuleName(leaf);
    const key = `leaf:${base}`;
    const existing = seenValueRules.get(key);
    if (existing !== undefined) return existing;
    const name = `v-${base}`;
    rules.push(`${name} ::= ${base} | "null"`);
    seenValueRules.set(key, name);
    return name;
  }

  function fieldRuleFor(path: string, leaf: LeafKind): string {
    const valueRule = valueRuleFor(path, leaf);
    const name = ruleName('f', path);
    // The envelope, minified. Evidence is a string or null; a value with no
    // evidence is rejected after decoding rather than forbidden here, so the
    // rejection is visible in the report instead of silently reshaping output.
    rules.push(
      `${name} ::= "{\\"value\\":" ${valueRule} ",\\"evidence\\":" (text | "null") ",\\"status\\":" status "}"`,
    );
    return name;
  }

  function objectRuleFor(node: SchemaNode, path: string, name: string): string {
    if (node.kind === 'field') return fieldRuleFor(path, node.leaf);
    const parts: string[] = [];
    node.children.forEach(([key, child], index) => {
      const childPath = path === '' ? key : `${path}.${key}`;
      const childName =
        child.kind === 'field'
          ? fieldRuleFor(childPath, child.leaf)
          : objectRuleFor(child, childPath, ruleName('o', childPath));
      const separator = index === 0 ? '"{' : '",';
      parts.push(`${separator}\\"${key}\\":" ${childName}`);
    });
    rules.push(`${name} ::= ${parts.join(' ')} "}"`);
    return name;
  }

  objectRuleFor(describeSchema(), '', 'deal');
  return [`root ::= deal`, PREAMBLE, ...rules].join('\n');
}

/** Every leaf path the grammar emits, for the cross-check against ALL_FIELDS. */
export function grammarFieldPaths(): string[] {
  const out: string[] = [];
  const walk = (node: SchemaNode, path: string): void => {
    if (node.kind === 'field') {
      out.push(path);
      return;
    }
    for (const [key, child] of node.children) walk(child, path === '' ? key : `${path}.${key}`);
  };
  walk(describeSchema(), '');
  return out;
}

export function assertGrammarCoversSchema(): void {
  const fromGrammar = grammarFieldPaths().sort();
  const fromSchema = [...ALL_FIELDS].sort();
  if (JSON.stringify(fromGrammar) !== JSON.stringify(fromSchema)) {
    throw new Error('grammar field paths have drifted from the schema');
  }
}
