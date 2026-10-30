import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent.js";
export function MarkdownEditor({
  label,
  value,
  onChange,
  maxLength,
  rows,
  disabled = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  rows: number;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const wasPreview = useRef(false);
  useLayoutEffect(() => {
    if (wasPreview.current && !preview) input.current?.focus();
    wasPreview.current = preview;
  }, [preview]);
  return (
    <div className="markdown-editor">
      <label htmlFor={id}>{label}</label>
      <div
        className="markdown-editor-modes"
        role="group"
        aria-label={`${label} 모드`}
      >
        <button
          type="button"
          aria-label={`${label} 작성`}
          aria-pressed={!preview}
          disabled={disabled}
          onClick={() => {
            setPreview(false);
            if (!preview) input.current?.focus();
          }}
        >
          작성
        </button>
        <button
          type="button"
          aria-label={`${label} 미리보기`}
          aria-pressed={preview}
          disabled={disabled}
          onClick={() => {
            setPreview(true);
          }}
        >
          미리보기
        </button>
      </div>
      <textarea
        ref={input}
        id={id}
        hidden={preview}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        maxLength={maxLength}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
      />
      {preview && (
        <div
          role="region"
          aria-label={`${label} 미리보기`}
          className="markdown-preview"
        >
          {value ? (
            <MarkdownContent value={value} />
          ) : (
            <span className="muted">내용 없음</span>
          )}
        </div>
      )}
    </div>
  );
}
