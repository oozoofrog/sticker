import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resourceUrlSchema } from "../../../server/contracts/resources.js";

function safeUrl(value: string): string {
  try {
    return resourceUrlSchema.safeParse(value).success ? value : "";
  } catch {
    return "";
  }
}

// Bound work before the parser (including GFM's own recursive transforms).
// Complex documents remain fully readable/editable as source, never truncated.
function exceedsBudget(value: string): boolean {
  let punctuation = 0,
    brackets = 0,
    quoteCount = 0,
    indentation = 0,
    lines = 1;
  let leading = true;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const structural =
      (code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126);
    if (structural && ++punctuation > 1024) return true;
    if (char === "[" && ++brackets > 32) return true;
    if (char === "]") brackets = Math.max(0, brackets - 1);
    if (char === ">" && ++quoteCount > 32) return true;
    if (char === "\n" || char === "\r") {
      if (++lines > 512) return true;
      quoteCount = 0;
      indentation = 0;
      leading = true;
    } else if (leading && (char === " " || char === "\t")) {
      indentation += char === "\t" ? 4 : 1;
      if (indentation > 128) return true;
    } else leading = false;
  }
  return false;
}
function SourceFallback({ value }: { value: string }) {
  return (
    <div className="markdown-source">
      <span className="muted">원문 표시</span>
      <pre className="markdown-source-fallback" aria-label="마크다운 원문">
        {value}
      </pre>
    </div>
  );
}
class RenderBoundary extends React.Component<
  { value: string; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <SourceFallback value={this.props.value} />
    ) : (
      this.props.children
    );
  }
}

/** Inert source rendering: no raw HTML, remote media, or executable extensions. */
export function MarkdownContent({ value }: { value: string }) {
  return (
    <div className="issue-markdown">
      {exceedsBudget(value) ? (
        <SourceFallback value={value} />
      ) : (
        <RenderBoundary key={value} value={value}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            urlTransform={safeUrl}
            components={{
              h2: ({ children }) => <h2>{children}</h2>,
              li: ({ children, className }) => (
                <li className={className}>{children}</li>
              ),
              a: ({ href, children }) =>
                href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ) : (
                  <>{children}</>
                ),
              img: ({ alt }) => <span>{alt || "이미지"}</span>,
              input: ({ checked }) => (
                <input
                  type="checkbox"
                  checked={Boolean(checked)}
                  disabled
                  aria-label={checked ? "완료된 항목" : "미완료 항목"}
                />
              ),
              table: ({ children }) => (
                <div
                  className="markdown-table"
                  tabIndex={0}
                  role="region"
                  aria-label="표"
                >
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {value}
          </Markdown>
        </RenderBoundary>
      )}
    </div>
  );
}
