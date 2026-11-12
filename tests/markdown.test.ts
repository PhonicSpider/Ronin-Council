import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../src/markdown';

const html = (md: string) =>
  renderToStaticMarkup(createElement('div', null, ...renderMarkdown(md, (t) => t)));

describe('markdown renderer', () => {
  it('renders emphasis, code, strike and links', () => {
    const h = html('**bold** and *it* and `x < y` and ~~old~~ and [site](https://example.com/a)');
    expect(h).toContain('<strong>bold</strong>');
    expect(h).toContain('<em>it</em>');
    expect(h).toContain('<code class="md-code">x &lt; y</code>');
    expect(h).toContain('<del>old</del>');
    expect(h).toContain('href="https://example.com/a"');
  });
  it('renders headings, lists, quotes, rules and tables', () => {
    const h = html('# Title\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    expect(h).toContain('<h1 class="md-h md-h1">Title</h1>');
    expect(h).toContain('<ul class="md-list"><li>a');
    expect(h).toContain('<ol class="md-list" start="1"><li>one');
    expect(h).toContain('<blockquote');
    expect(h).toContain('<hr');
    expect(h).toContain('<th>A</th>');
    expect(h).toContain('<td>2</td>');
  });
  it('never emits raw HTML or unsafe links', () => {
    const h = html('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://ok.com)');
    expect(h).not.toContain('<script');
    expect(h).not.toContain('<img');
    expect(h).not.toContain('href="javascript');
    expect(h).toContain('&lt;script&gt;');
  });
  it('keeps snake_case and math-like asterisks literal, and terminates on odd input', () => {
    const h = html('my_var_name and 2 * 3 * 4 and ** and `` and ___');
    expect(h).toContain('my_var_name');
    expect(h).not.toContain('<em>');
    expect(() => html('|\n|-|\n> \n- \n1. \n#')).not.toThrow();
  });
});
