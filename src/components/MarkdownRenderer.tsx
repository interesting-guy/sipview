"use client";

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MarkdownRendererProps {
  content: string;
}

// Custom components to style markdown elements with Tailwind CSS
const customComponents: Components = {
  h1: ({node, ...props}) => <h1 className="font-headline text-3xl font-bold mt-6 mb-4" {...props} />,
  h2: ({node, ...props}) => <h2 className="font-headline text-2xl font-bold mt-5 mb-3 border-b pb-2" {...props} />,
  h3: ({node, ...props}) => <h3 className="font-headline text-xl font-semibold mt-4 mb-2" {...props} />,
  h4: ({node, ...props}) => <h4 className="font-headline text-lg font-semibold mt-3 mb-1" {...props} />,
  p: ({node, ...props}) => <p className="mb-4 leading-relaxed" {...props} />,
  ul: ({node, ...props}) => <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />,
  ol: ({node, ...props}) => <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />,
  li: ({node, ...props}) => <li className="mb-1" {...props} />,
  blockquote: ({node, ...props}) => <blockquote className="pl-4 italic border-l-4 border-muted-foreground/50 text-muted-foreground mb-4" {...props} />,
  code: ({node, inline, className, children, ...props}) => {
    const match = /language-(\w+)/.exec(className || '')
    return !inline && match ? (
      <pre className="bg-muted p-4 rounded-md overflow-x-auto mb-4 font-code text-sm">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    ) : (
      <code className="bg-muted/50 px-1 py-0.5 rounded-sm font-code text-sm" {...props}>
        {children}
      </code>
    )
  },
  a: ({node, ...props}) => <a className="text-accent hover:underline" {...props} />,
  table: ({node, ...props}) => <table className="w-full border-collapse border border-border mb-4" {...props} />,
  thead: ({node, ...props}) => <thead className="bg-muted/50" {...props} />,
  th: ({node, ...props}) => <th className="border border-border px-4 py-2 text-left font-semibold" {...props} />,
  td: ({node, ...props}) => <td className="border border-border px-4 py-2" {...props} />,
};

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="prose dark:prose-invert max-w-none">
      <ReactMarkdown components={customComponents} remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
