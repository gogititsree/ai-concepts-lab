import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '../src/components/Markdown';
import { getLesson } from '../src/content/static';

describe('Markdown renderer', () => {
  it('typesets inline and display maths with KaTeX', () => {
    const { container } = render(
      <Markdown>{'Inline $z = w x + b$ and display:\n\n$$\n\\sigma(z)\n$$\n'}</Markdown>,
    );
    // KaTeX leaves its own class names on the output; MathML is how it stays accessible.
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.katex-display')).not.toBeNull();
    // KaTeX renders the accessible MathML twin alongside the visual HTML.
    expect(container.innerHTML).toContain('katex-mathml');
  });

  it('renders GFM tables', () => {
    render(<Markdown>{'| a | b |\n| - | - |\n| 1 | 2 |\n'}</Markdown>);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'a' })).toBeInTheDocument();
  });

  it('renders a real lesson, maths and callout included', () => {
    const lesson = getLesson('neural-networks', 'the-forward-pass')!.lesson;
    const { container } = render(<Markdown>{lesson.bodyMd}</Markdown>);

    expect(
      screen.getByRole('heading', { level: 1, name: /computation graph/i }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('.katex').length).toBeGreaterThan(5);
    expect(container.querySelector('blockquote')?.textContent).toContain(
      'Where is this in the code?',
    );
    // The worked example's numbers are the ones nn-core asserts to 1e-9.
    expect(container.textContent).toContain('0.751365069552');
  });
});
