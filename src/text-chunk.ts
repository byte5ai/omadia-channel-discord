// Line-boundary chunking that keeps fenced code blocks balanced. Carried over
// from 0.1.x render.ts; the limit is now the caller's (TextDisplay: 4000,
// plain-content fallback: 2000).

function lastFenceLang(chunk: string): string {
  const matches = [...chunk.matchAll(/^```(\w*)/gm)];
  return matches.at(-1)?.[1] ?? '';
}

/**
 * Split prose into ≤`limit`-char chunks on line boundaries, keeping fenced code
 * blocks intact: an unbalanced ``` is closed at the end of a chunk and
 * reopened (with its language) at the start of the next.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const rawChunks: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    const candidate = buf.length === 0 ? line : `${buf}\n${line}`;
    if (candidate.length <= limit) {
      buf = candidate;
      continue;
    }
    if (buf.length > 0) {
      rawChunks.push(buf);
      buf = '';
    }
    if (line.length <= limit) {
      buf = line;
      continue;
    }
    // A single line longer than the limit: hard-split it.
    for (let i = 0; i < line.length; i += limit) {
      const piece = line.slice(i, i + limit);
      if (i + limit >= line.length) buf = piece;
      else rawChunks.push(piece);
    }
  }
  if (buf.length > 0) rawChunks.push(buf);

  // Re-balance code fences across boundaries.
  const balanced: string[] = [];
  let carry: string | null = null;
  for (const raw of rawChunks) {
    let chunk: string = carry !== null ? `${carry}\n${raw}` : raw;
    const fenceCount = chunk.match(/^```/gm)?.length ?? 0;
    if (fenceCount % 2 === 1) {
      carry = `\`\`\`${lastFenceLang(chunk)}`;
      chunk = `${chunk}\n\`\`\``;
    } else {
      carry = null;
    }
    balanced.push(chunk);
  }
  return balanced;
}
