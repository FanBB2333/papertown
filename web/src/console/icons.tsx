// Line icons for the console, drawn on a 24px grid with the stroke in currentColor.

const PATHS = {
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  lens: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20',
  code: 'M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15',
  flask: 'M9.5 3.5h5M10.5 3.5v5.2L5 18.3A1.5 1.5 0 0 0 6.3 20.5h11.4a1.5 1.5 0 0 0 1.3-2.2l-5.5-9.6V3.5M7.6 14h8.8',
  table: 'M4 5.5h16v13H4zM4 10h16M4 14.5h16M10 5.5v13',
  doc: 'M6.5 3.5h7.5l4 4v13h-11.5zM13.5 3.5v4.5h4.5M9 12.5h6M9 16h6',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.8 20a6.2 6.2 0 0 1 12.4 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.2 13.6A6.2 6.2 0 0 1 21.2 20',
  spark: 'M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9zM18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  shield: 'M12 3.5l7 2.6v5.4c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6.1zM9 12l2.2 2.2L15.5 10',
  lock: 'M6.5 11h11v9h-11zM9 11V8a3 3 0 0 1 6 0v3',
  plug: 'M9 3.5v4M15 3.5v4M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 16.5v4',
  books: 'M4.5 4.5h4v15h-4zM8.5 6.5h4v13h-4zM13.6 6.9l3.8-1.2 3.6 13.4-3.8 1.1z',
  folder: 'M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.6l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v9.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9.5l6 6 6-6',
  left: 'M14.5 6l-6 6 6 6',
  right: 'M9.5 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  branch: 'M7 4.5v15M7 15.5a8 8 0 0 0 8-8M17 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM7 21.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  play: 'M7.5 5v14l11.5-7z',
  term: 'M4.5 6.5 10 12l-5.5 5.5M12.5 18h7',
  save: 'M5 4.5h11.5l3 3v12H5zM8 4.5v5h7v-5M8 19.5v-6h8.5v6',
  split: 'M4 5h16v14H4zM12 5v14',
  sidebar: 'M4 5h16v14H4zM9.5 5v14',
  diff: 'M7 4v8M3 8h8M13 18h8M17.5 3.5v9M14 7l3.5-3.5L21 7',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5zM10 20.5a2.2 2.2 0 0 0 4 0',
  ext: 'M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 13.5v6h-13v-13h6',
  gpu: 'M3.5 7h17v10h-17zM7 17v2.5M11 17v2.5M15 17v2.5M8.5 12a2 2 0 1 0 0-.01M15.5 12a2 2 0 1 0 0-.01',
  file: 'M6.5 3.5h7.5l4 4v13h-11.5zM13.5 3.5v4.5h4.5',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z',
  copy: 'M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4',
  rows: 'M4 6h16M4 12h16M4 18h16',
  cards: 'M4 4.5h7v7H4zM13 4.5h7v7h-7zM4 13.5h7v6H4zM13 13.5h7v6h-7z',
  board: 'M4 4.5h4.5v15H4zM10 4.5h4.5v10H10zM16 4.5h4v6.5h-4z',
  stack: 'M4 5h16v4.5H4zM7 13h13M7 17.5h13M4.5 13v4.5',
  dots: 'M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4z',
  wand: 'M5 19 15.5 8.5M14 4.5v3M17.5 6.5l2-2M19.5 10h-3M12 4.5l-1.2-1.2',
  person: 'M12 11.5a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6zM4.8 20.5a7.2 7.2 0 0 1 14.4 0',
  chat: 'M4.5 5.5h15v10.5h-8.2L7 19.5v-3.5H4.5zM8.5 10.8h.01M12 10.8h.01M15.5 10.8h.01',
  target: 'M12 19.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  sideR: 'M4 5h16v14H4zM14.5 5v14',
  compose: 'M12 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-6M17.5 3.5l3 3-8 8H9.5v-3z',
  send: 'M12 19V5.5M6 11l6-6 6 6',
  stop: 'M7.5 7.5h9v9h-9z',
  quote: 'M5 12.5h4.5v5H5zM5 12.5c0-3 1-5 3.5-6.5M14.5 12.5H19v5h-4.5zM14.5 12.5c0-3 1-5 3.5-6.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  sliders: 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4',
  map: 'M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2zM9 4.5v13M15 6.5v13',
  cube: 'M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7zM4.5 7.7 12 12l7.5-4.3M12 12v8.5',
  palette: 'M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.7-.7 1.7-1.6 0-1.1-.9-1.4-.9-2.4 0-.9.7-1.5 1.6-1.5h1.9a4.2 4.2 0 0 0 4.2-4.2c0-4-3.8-7.3-8.5-7.3zM7.6 12.2h.01M9.2 8.1h.01M13.6 7.4h.01M16.6 10.3h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ n, size = 18, className = '' }: { n: IconName; size?: number; className?: string }) {
  return (
    <svg className={`ic ${className}`} width={size} height={size} style={{ ['--s' as string]: `${size}px` }} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[n]} />
    </svg>
  );
}
