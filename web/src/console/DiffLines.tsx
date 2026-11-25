// Unified diffs use the same line markings in the editor and the provenance record.
export function DiffLines({ text }: { text: string }) {
  return <pre>{text.split('\n').map((line, i) => {
    const change = line.startsWith('+') && !line.startsWith('+++') ? 'add'
      : line.startsWith('-') && !line.startsWith('---') ? 'del' : undefined;
    return <span key={i} className={change ?? (line.startsWith('@@') ? 'hunk' : undefined)}>
      {change ? <mark className="em-mark" data-tone={change === 'add' ? 'good' : 'bad'}>{line}</mark> : line}{'\n'}</span>;
  })}</pre>;
}
