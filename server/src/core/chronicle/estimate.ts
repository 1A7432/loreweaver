// A rough, deterministic token estimate for fold accounting.
//
// The fullness meter is the provider's own count where one is reported; this estimate
// sizes what the engine has to size itself — the replayed history a fold would stop
// sending, and a prompt whose provider reported nothing. CJK ideographs and punctuation
// run about one token per character while Latin prose runs about four characters per
// token, so a flat characters/4 rule would under-count a Chinese campaign four-fold and
// fold far too late. Characters are counted in code points.

function isCjk(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, Kangxi, kana, Extension A, Unified Ideographs
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation (inside the range above; stated for the reader)
    (code >= 0xff00 && code <= 0xffef) || // fullwidth forms
    (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
  );
}

/** 0 for empty text, else at least 1: CJK code points count one each, the rest one per four (rounded up). */
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (isCjk(character.codePointAt(0) ?? 0)) cjk++;
    else other++;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}
