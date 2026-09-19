import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/**
 * The lesson renderer: GitHub-flavoured Markdown plus `$...$` / `$$...$$` maths.
 *
 * The pipeline is remark-math (parse the dollars into math nodes) then rehype-katex (render
 * them to KaTeX HTML at *render* time, not runtime MathML), so equations are real typeset
 * mathematics and not images. `katex/dist/katex.min.css` is imported once in `main.tsx`.
 *
 * Element styling lives here rather than in a typography plugin: this app has exactly one
 * body-text surface, and hand-mapping a dozen tags is less machinery than a preset to fight.
 * Blockquotes get the callout treatment, because in this curriculum every blockquote is one
 * ("Where is this in the code?", "What to measure").
 */

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-ink mt-0 mb-4 text-3xl font-semibold tracking-tight text-balance">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="border-rule text-ink mt-10 mb-3 border-t pt-6 text-xl font-semibold tracking-tight">
      {children}
    </h2>
  ),
  h3: ({ children }) => <h3 className="text-ink mt-6 mb-2 text-base font-semibold">{children}</h3>,
  p: ({ children }) => <p className="my-4 leading-7">{children}</p>,
  ul: ({ children }) => <ul className="my-4 list-disc space-y-2 pl-5 leading-7">{children}</ul>,
  ol: ({ children }) => <ol className="my-4 list-decimal space-y-2 pl-5 leading-7">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ children, href }) => (
    <a
      className="decoration-rule underline underline-offset-4 hover:decoration-current"
      href={href}
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ children, className }) =>
    className?.includes('language-') ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="bg-sunk border-rule rounded border px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="bg-sunk border-rule my-5 overflow-x-auto rounded-md border p-4 font-mono text-[0.8125rem] leading-6">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-ink bg-surface my-6 border-l-2 py-1 pl-4 [&>p]:my-2 [&>p:first-child>strong]:mb-1 [&>p:first-child>strong]:block [&>p:first-child>strong]:font-mono [&>p:first-child>strong]:text-[0.6875rem] [&>p:first-child>strong]:tracking-[0.12em] [&>p:first-child>strong]:uppercase">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="border-rule my-5 overflow-x-auto rounded-md border">
      <table className="readout w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-sunk">{children}</thead>,
  th: ({ children }) => (
    <th className="border-rule border-b px-3 py-2 text-xs font-semibold tracking-wide">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-rule border-b px-3 py-2 align-top">{children}</td>,
  hr: () => <hr className="border-rule my-8" />,
};

export interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={className} data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Prompts and explanations: same pipeline, no vertical rhythm of its own. */
export function InlineMarkdown({ children, className }: MarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ ...components, p: ({ children: kids }) => <span>{kids}</span> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
