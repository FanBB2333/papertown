// What the editor marks each token with: a class (pt-…) whose colour is one of the --tk-…
// variables the editor's theme sets (edthemes.ts, console.css).

import { tagHighlighter, tags as t } from '@lezer/highlight';
import { mathCmdTag, mathDelimTag, mathTag } from './latex';

export const highlighter = tagHighlighter([
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], class: 'pt-kw' },
  { tag: [t.controlKeyword], class: 'pt-ctl' },
  { tag: [t.self], class: 'pt-kw' },
  { tag: [t.string, t.docString, t.character, t.attributeValue, t.special(t.string)], class: 'pt-str' },
  { tag: [t.regexp, t.escape], class: 'pt-esc' },
  { tag: [t.number, t.integer, t.float], class: 'pt-num' },
  { tag: [t.bool, t.null, t.atom, t.unit, t.constant(t.variableName), t.standard(t.variableName)], class: 'pt-con' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'pt-com' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'pt-fn' },
  { tag: [t.typeName, t.className, t.namespace], class: 'pt-type' },
  { tag: [t.variableName], class: 'pt-var' },
  { tag: [t.propertyName], class: 'pt-prop' },
  { tag: [t.operator, t.definitionOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator, t.typeOperator, t.controlOperator, t.derefOperator], class: 'pt-op' },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.squareBracket, t.brace, t.angleBracket], class: 'pt-punc' },
  { tag: [t.tagName], class: 'pt-tag' },
  { tag: [t.macroName], class: 'pt-macro' },
  { tag: [t.attributeName], class: 'pt-attr' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], class: 'pt-head' },
  { tag: [t.link, t.url], class: 'pt-link' },
  { tag: [t.labelName], class: 'pt-label' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.documentMeta], class: 'pt-meta' },
  { tag: [t.invalid], class: 'pt-bad' },
  { tag: [t.emphasis], class: 'pt-em' },
  { tag: [t.strong], class: 'pt-strong' },
  { tag: [t.strikethrough], class: 'pt-strike' },
  { tag: [t.monospace], class: 'pt-mono' },
  { tag: [t.quote], class: 'pt-quote' },
  { tag: [t.list], class: 'pt-list' },
  { tag: [t.contentSeparator], class: 'pt-com' },
  { tag: [t.inserted], class: 'pt-ins' },
  { tag: [t.deleted], class: 'pt-del' },
  { tag: [mathTag], class: 'pt-math' },
  { tag: [mathCmdTag], class: 'pt-mathcmd' },
  { tag: [mathDelimTag], class: 'pt-mathdelim' },
]);
