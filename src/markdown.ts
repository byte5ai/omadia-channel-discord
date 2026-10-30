/**
 * Prose blocks after adapting LLM markdown to what Discord renders. Discord
 * has `#`–`###`, lists, quotes, code and masked links — but no rules, no
 * `####`+, and no inline images. Those become native components instead.
 */
export type ProseBlock =
  | { kind: 'text'; text: string }
  | { kind: 'separator' }
  | { kind: 'image'; url: string; alt: string };

const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const DEEP_HEADING = /^\s{0,3}#{4,6}\s+(.+?)\s*#*\s*$/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

export function toProseBlocks(markdown: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buf.join('\n').replace(/^\n+|\n+$/g, '');
    if (text.trim().length > 0) blocks.push({ kind: 'text', text });
    buf = [];
  };

  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) {
      buf.push(line);
      continue;
    }
    if (RULE.test(line)) {
      flush();
      // Collapse doubled rules and never open with one.
      if (blocks.length > 0 && blocks.at(-1)?.kind !== 'separator') {
        blocks.push({ kind: 'separator' });
      }
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image) {
      flush();
      blocks.push({ kind: 'image', alt: image[1] ?? '', url: image[2] ?? '' });
      continue;
    }
    const heading = DEEP_HEADING.exec(line);
    buf.push(heading ? `**${heading[1]}**` : line);
  }
  flush();
  if (blocks.at(-1)?.kind === 'separator') blocks.pop();
  return blocks;
}
