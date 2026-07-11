import { isValidElement, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { Icon } from './Icon';

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span>{language || 'code'}</span>
        <button className={`copy-btn${copied ? ' copied' : ''}`} type="button" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ alt, ...props }) => <img {...props} alt={alt || ''} className="inline-image" />,
  pre: ({ children }) => {
    if (isValidElement(children)) {
      const element = children as ReactElement<{ className?: string; children?: ReactNode }>;
      const language = element.props.className?.replace(/^language-/, '') || '';
      const code = String(element.props.children || '').replace(/\n$/, '');
      return <CodeBlock code={code} language={language} />;
    }
    return <pre>{children}</pre>;
  },
  code: ({ children, ...props }) => <code {...props}>{children}</code>,
  table: ({ children }) => (
    <div className="table-wrapper">
      <table>{children}</table>
    </div>
  ),
  input: (props) => <input {...props} disabled />,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={markdownComponents}
    >
      {children}
    </ReactMarkdown>
  );
}

export function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`message-copy-btn${copied ? ' copied' : ''}`}
      type="button"
      aria-label="复制消息"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} width={12} height={12} />
    </button>
  );
}
