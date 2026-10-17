/**
 * The NEEDS_ASIDE: Darwin download pitch. The full canonical phrase counts anywhere unless a negation precedes it; the
 * short forms count only at the start of a sentence, bullet or quote, so narration such as "no download pitch applies"
 * or "you can download it at aside.com" is not a pitch.
 */
const ASIDE_DOWNLOAD_PITCH = String.raw`(?:^|[.!?;:]\s*|\n)\s*(?:[>*-]\s*)*["\u201C]?download (?:it|Aside) at aside\.com\b|(?<!(?:\bnot|\bnever|n['\u2019]t)\s+)download Aside \(macOS 15\+\) at aside\.com\b`;
export const asideDownloadPitch = new RegExp(ASIDE_DOWNLOAD_PITCH, 'im');
export const asideDownloadPitchCount = (text: string): number => [...text.matchAll(new RegExp(ASIDE_DOWNLOAD_PITCH, 'gim'))].length;

/** Inspect lettered consent options, not narration that quotes an unavailable option. */
export function asideDriveOptions(text: string): string[] {
  const options: string[] = [];
  let current: string | undefined;
  for (const line of text.replaceAll('**', '').split('\n')) {
    const option = line.match(/^[ \t]*(?:[-*+][ \t]+)?[A-D][).][ \t]+(.*)$/);
    if (option) {
      if (current !== undefined) options.push(current);
      current = option[1];
    } else if (current !== undefined && /^[ \t]+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else if (current !== undefined) {
      options.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) options.push(current);
  return options.filter(option => {
    const currentOffer = option.replace(
      /\b(?:I|we)(?:['’]ll| will) (?:re[- ]?ask|ask again)(?: (?:you|this question))? with (?:the )?(?:"[^"]+"|“[^”]+”|[\w -]+?) option(?: included)?\b/gi,
      '',
    );
    return /\bAside\b/.test(option) && /\b(?:drive|driving|browse|browsing|navigate|click)\b/i.test(currentOffer);
  });
}
