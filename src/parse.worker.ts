import { renderMarkdown } from './markdown';
self.onmessage = (event: MessageEvent<string>) => {
  try { self.postMessage({ ok: true, ...renderMarkdown(event.data) }); }
  catch { self.postMessage({ ok: false, error: 'This Markdown document could not be rendered. You can view its source instead.' }); }
};
