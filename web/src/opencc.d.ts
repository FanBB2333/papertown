// opencc-js ships no types; this is the one function the app uses
declare module 'opencc-js/cn2t' {
  export function Converter(opts: { from: 'cn'; to: 'tw' | 'twp' | 'hk' }): (s: string) => string;
}
