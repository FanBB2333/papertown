// LaTeX and BibTeX for the editor, as stream parsers that, unlike the legacy stex mode, tell apart
// commands, titles, environments, cite/ref keys and math, and a .bib's entries, keys, fields and values.

import { StreamLanguage, type StringStream } from '@codemirror/language';
import { Tag } from '@lezer/highlight';

// the math has tags of its own, so a theme can give a formula its own colour
export const mathTag = Tag.define();
export const mathCmdTag = Tag.define();
export const mathDelimTag = Tag.define();

// what the next {…} after a command holds, and the token it is drawn as
const ARG: Record<string, string> = {
  head: 'heading', label: 'labelName', env: 'className', strong: 'strong', em: 'emphasis', url: 'url', path: 'string', pkg: 'namespace',
};
const NEXT: [RegExp, string][] = [
  [/^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title|caption|frametitle)(?![a-zA-Z@])\*?/, 'head'],
  [/^\\(?:[a-zA-Z]*cite[a-zA-Z]*|[cC]ref|ref|eqref|autoref|pageref|nameref|label)(?![a-zA-Z@])\*?/, 'label'],
  [/^\\(?:url|href)(?![a-zA-Z@])/, 'url'],
  [/^\\(?:input|include|includeonly|includegraphics|bibliography|addbibresource|graphicspath|bibliographystyle)(?![a-zA-Z@])\*?/, 'path'],
  [/^\\(?:usepackage|RequirePackage|documentclass|LoadClass)(?![a-zA-Z@])/, 'pkg'],
  [/^\\(?:textbf|mathbf)(?![a-zA-Z@])/, 'strong'],
  [/^\\(?:emph|textit|textsl)(?![a-zA-Z@])/, 'em'],
];
const MATH_ENVS = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath|split)\*?$/;

interface TexState {
  math: string | null; // what closes the formula we are in: '$', '$$', '\)', '\]', or an environment's name
  next: string | null; // the kind of the {…} a command just asked for
  args: string[]; // the kinds of the {…} we are inside, innermost last
  begin: boolean; // the environment name being read follows \begin (not \end)
  env: string; // that name, as far as it has been read
}

function texToken(stream: StringStream, s: TexState): string | null {
  if (stream.eatSpace()) return null;
  if (stream.peek() === '%') { stream.skipToEnd(); return 'comment'; }
  if (s.math) return mathToken(stream, s);

  if (stream.match(/^\\(begin|end)\b/)) { s.next = 'env'; s.begin = stream.current() === '\\begin'; s.env = ''; return 'keyword'; }
  for (const [re, kind] of NEXT) if (stream.match(re)) { s.next = kind; return 'macroName'; }
  if (stream.match('$$')) { s.math = '$$'; return 'mathDelim'; }
  if (stream.match('$')) { s.math = '$'; return 'mathDelim'; }
  if (stream.match('\\(')) { s.math = '\\)'; return 'mathDelim'; }
  if (stream.match('\\[')) { s.math = '\\]'; return 'mathDelim'; }
  if (stream.match(/^\\[a-zA-Z@]+\*?/)) { s.next = null; return 'macroName'; }
  if (stream.match(/^\\[%&$#_{}]/)) return 'escape';
  if (stream.match(/^\\(?:\\|[,;:!> ])/)) return 'operator';

  const ch = stream.next()!;
  if (ch === '{') {
    s.args.push(s.next ?? s.args[s.args.length - 1] ?? '');
    s.next = null;
    return 'brace';
  }
  if (ch === '}') {
    const kind = s.args.pop();
    if (kind === 'env' && s.begin && MATH_ENVS.test(s.env.trim())) s.math = s.env.trim();
    return 'brace';
  }
  if (ch === '[') {
    if (s.next) { stream.match(/^[^\]\n]*\]?/); return 'meta'; }
    return 'squareBracket';
  }
  if (ch === ']') return 'squareBracket';
  if (ch === '&' || ch === '~') return 'operator';
  s.next = null;
  stream.match(/^[^\\{}%$&~[\]\s]*/);
  const kind = s.args[s.args.length - 1];
  if (kind === 'env') s.env += stream.current();
  return kind ? ARG[kind] ?? null : null;
}

function mathToken(stream: StringStream, s: TexState): string | null {
  const close = s.math!;
  if (close === '$' || close === '$$' || close === '\\)' || close === '\\]') {
    if (stream.match(close)) { s.math = null; return 'mathDelim'; }
  } else {
    const m = stream.match(/^\\end\s*\{([^}]*)\}/, false) as RegExpMatchArray | null;
    if (m && m[1].trim() === close) { stream.match(/^\\end/); s.math = null; s.next = 'env'; s.begin = false; s.env = ''; return 'keyword'; }
  }
  if (stream.match(/^\\[a-zA-Z@]+/) || stream.match(/^\\./)) return 'mathCmd';
  if (stream.match(/^\d+(?:\.\d+)?/)) return 'number';
  if (stream.match(/^[a-zA-Z]+/)) return 'math';
  const ch = stream.next()!;
  if ('{}[]()'.includes(ch)) return 'bracket';
  if ('^_&+-=<>|/*,.;:!\''.includes(ch)) return 'operator';
  return 'math';
}

export const latex = StreamLanguage.define<TexState>({
  name: 'latex',
  startState: () => ({ math: null, next: null, args: [], begin: false, env: '' }),
  copyState: s => ({ ...s, args: [...s.args] }),
  token: texToken,
  tokenTable: { math: mathTag, mathCmd: mathCmdTag, mathDelim: mathDelimTag },
  languageData: { commentTokens: { line: '%' } },
});

interface BibState {
  at: 'out' | 'open' | 'key' | 'field' | 'eq' | 'value' | 'after';
  kind: string; // the entry type, lowercased: article, string, comment…
  depth: number; // braces open inside a value (or a @comment's body)
  quote: boolean; // inside a "…" value
}

function bibToken(stream: StringStream, s: BibState): string | null {
  // a value can run over several lines: carry on with it before anything else
  if (s.depth > 0 || s.quote) return bibValue(stream, s);
  if (stream.eatSpace()) return null;
  if (stream.peek() === '%') { stream.skipToEnd(); return 'comment'; }
  switch (s.at) {
    case 'out':
      if (stream.match(/^@[a-zA-Z]+/)) { s.kind = stream.current().slice(1).toLowerCase(); s.at = 'open'; return 'keyword'; }
      stream.match(/^[^@%]+/) || stream.next();
      return 'comment';
    case 'open':
      if (stream.eat('{') || stream.eat('(')) {
        if (s.kind === 'comment') { s.depth = 1; return 'brace'; }
        s.at = s.kind === 'string' || s.kind === 'preamble' ? (s.kind === 'preamble' ? 'value' : 'field') : 'key';
        return 'brace';
      }
      s.at = 'out';
      return null;
    case 'key':
      if (stream.match(/^[^,\s}]+/)) { s.at = 'field'; return 'labelName'; }
      break;
    case 'field':
      if (stream.match(/^[a-zA-Z][\w\-:.]*/)) { s.at = 'eq'; return 'propertyName'; }
      break;
    case 'eq':
      if (stream.eat('=')) { s.at = 'value'; return 'definitionOperator'; }
      break;
    case 'value':
      if (stream.eat('{')) { s.depth = 1; return bibValue(stream, s); }
      if (stream.eat('"')) { s.quote = true; return bibValue(stream, s); }
      if (stream.match(/^\d+/)) { s.at = 'after'; return 'number'; }
      if (stream.match(/^[a-zA-Z][\w\-:.]*/)) { s.at = 'after'; return 'variableName'; }
      break;
    case 'after':
      if (stream.eat('#')) { s.at = 'value'; return 'operator'; }
      break;
  }
  const ch = stream.next()!;
  if (ch === ',') { if (s.at !== 'key') s.at = 'field'; return 'separator'; }
  if (ch === '}' || ch === ')') { s.at = 'out'; return 'brace'; }
  return null;
}

function bibValue(stream: StringStream, s: BibState): string | null {
  const comment = s.kind === 'comment';
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === '\\') { stream.next(); continue; }
    if (ch === '{') s.depth++;
    else if (ch === '}') {
      if (s.quote && s.depth === 0) continue;
      s.depth--;
      if (s.depth === 0 && !s.quote) { s.at = comment ? 'out' : 'after'; break; }
    } else if (ch === '"' && s.quote && s.depth === 0) { s.quote = false; s.at = 'after'; break; }
  }
  return comment ? 'comment' : 'string';
}

export const bibtex = StreamLanguage.define<BibState>({
  name: 'bibtex',
  startState: () => ({ at: 'out', kind: '', depth: 0, quote: false }),
  token: bibToken,
  languageData: { commentTokens: { line: '%' } },
});
