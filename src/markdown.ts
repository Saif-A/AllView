import MarkdownIt from 'markdown-it';

export interface Heading { id: string; title: string; level: number }
export function renderMarkdown(source: string): { html: string; headings: Heading[] } {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: true });
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const tokens = md.parse(source, {});
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const title = tokens[i + 1]?.content ?? '';
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    const count = (used.get(base) ?? 0) + 1; used.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    tokens[i].attrSet('id', id);
    if (headings.length < 2000) headings.push({ id, title, level: Number(tokens[i].tag.slice(1)) });
  }
  // Files can describe remote images; viewing them must never fetch those URLs.
  md.renderer.rules.image = (parts, index) => `<span class="image-placeholder">[Image: ${md.utils.escapeHtml(parts[index].content || 'embedded reference')}]</span>`;
  return { html: md.renderer.render(tokens, md.options, {}), headings };
}
