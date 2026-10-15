export interface GbrainSearchHit {
  slug?: string;
  score: number;
  snippet: string;
}

/** JSON preserves evidence when human output is Markdown; legacy CLIs can still return text. */
export function gbrainSearchHits(stdout: string, minScore: number, limit: number): GbrainSearchHit[] {
  const text = stdout.trim();
  if (text.startsWith('[')) {
    try {
      const rows: unknown = JSON.parse(text);
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row): GbrainSearchHit[] => {
        if (!row || typeof row !== 'object' || typeof row.chunk_text !== 'string' || !row.chunk_text.trim()) return [];
        if (typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < 0) return [];
        // Rank-only backends use zero as an uncalibrated score. Preserve their order.
        if (row.score > 0 && row.score < minScore) return [];
        if (row.result_type === 'cloud') return [{ score: row.score, snippet: row.chunk_text }];
        if (row.result_type || typeof row.slug !== 'string' || !row.slug) return [];
        return [{ slug: row.slug, score: row.score, snippet: row.chunk_text }];
      }).slice(0, limit);
    } catch { /* Older GBrain prints [score] slug -- snippet rather than JSON. */ }
  }
  return text.split('\n').flatMap((line): GbrainSearchHit[] => {
    const m = /^\[([\d.]+)\]\s+(\S+)\s+--\s+(.*)$/.exec(line);
    if (!m) return [];
    const score = Number(m[1]);
    return Number.isFinite(score) && score >= minScore ? [{ score, slug: m[2], snippet: m[3].trim() }] : [];
  }).slice(0, limit);
}
