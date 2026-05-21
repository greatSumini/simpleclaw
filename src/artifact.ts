export interface Artifact {
  kind: 'file' | 'url';
  /** Absolute path on disk — only for kind=file */
  path?: string;
  /** URL string — only for kind=url */
  url?: string;
  /** Optional human-readable label shown alongside the attachment */
  caption?: string;
}

export const SIMPLECLAW_ARTIFACT_MARKER = '__SIMPLECLAW_ARTIFACT__';

/**
 * Parse and strip artifact markers from Claude/Codex response text.
 *
 * Format:
 *   __SIMPLECLAW_ARTIFACT__ {"kind":"file","path":"/abs/path","caption":"..."}
 *   __SIMPLECLAW_ARTIFACT__ {"kind":"url","url":"https://...","caption":"..."}
 *
 * Lines containing the marker are removed; malformed JSON lines are kept as-is.
 */
export function extractArtifacts(text: string): { text: string; artifacts: Artifact[] } {
  const artifacts: Artifact[] = [];
  const cleanLines: string[] = [];

  for (const line of text.split('\n')) {
    const idx = line.indexOf(SIMPLECLAW_ARTIFACT_MARKER);
    if (idx === -1) {
      cleanLines.push(line);
      continue;
    }
    const jsonPart = line.slice(idx + SIMPLECLAW_ARTIFACT_MARKER.length).trim();
    try {
      const obj = JSON.parse(jsonPart) as Record<string, unknown>;
      if (obj['kind'] === 'file' && typeof obj['path'] === 'string') {
        artifacts.push({
          kind: 'file',
          path: obj['path'],
          caption: typeof obj['caption'] === 'string' ? obj['caption'] : undefined,
        });
      } else if (obj['kind'] === 'url' && typeof obj['url'] === 'string') {
        artifacts.push({
          kind: 'url',
          url: obj['url'],
          caption: typeof obj['caption'] === 'string' ? obj['caption'] : undefined,
        });
      } else {
        cleanLines.push(line);
      }
    } catch {
      // malformed JSON — keep the line as-is
      cleanLines.push(line);
    }
  }

  return { text: cleanLines.join('\n').trimEnd(), artifacts };
}
