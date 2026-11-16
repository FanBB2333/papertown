// `pnpm i18n:missing`: lists tr('…') strings with no entry in src/i18n/en.json; exits 1 if any.
// Server strings go through the same dictionary (localize() in i18n.ts) and are added by hand,
// with {0}, {1}… for f-string substitutions in order.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SRC = new URL('../src/', import.meta.url).pathname;
const en = JSON.parse(readFileSync(join(SRC, 'i18n/en.json'), 'utf8'));

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* files(join(dir, e.name));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) yield join(dir, e.name);
  }
}

const missing = new Map();
for (const file of files(SRC)) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tr') {
      const a = node.arguments[0];
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && en[a.text] === undefined) {
        const at = `${file.slice(SRC.length)}:${sf.getLineAndCharacterOfPosition(a.getStart()).line + 1}`;
        if (!missing.has(a.text)) missing.set(a.text, at);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const [key, at] of missing) console.log(`${at}\t${key}`);
console.log(missing.size ? `${missing.size} string(s) without English` : 'every tr() string has English');
process.exit(missing.size ? 1 : 0);
