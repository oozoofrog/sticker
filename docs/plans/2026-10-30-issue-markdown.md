# STK-68: Issue Markdown

## Goal and scope

Render issue descriptions and comments as Markdown while retaining their original strings for agents, editing, history, and API clients. Add concise 작성/미리보기 controls, not a rich-text document model. No migration, permission change, comment editing feature, or change to the resource renderer.

Canonical issue: STK-68 (`06c84e27-8af8-41fe-b106-3807b0500d00`). Initial base `74ff9775de608f4b391c2f88c5d1ca982c091d79`; GitHub selector main `af81491b0cb09e5109e5859a6bfad8ae7e54ad11` integrated before final verification.

## Design choices

- A maintained CommonMark/GFM parser instead of extending the limited custom resource renderer or introducing WYSIWYG storage. `react-markdown` 10.1.0 and `remark-gfm` 4.0.1 are exact-locked, MIT licensed; React >=18 peer support includes this application's React19. Registry metadata and official repositories checked 2026-10-30. Existing dependency versions are unchanged.
- Issue-only `MarkdownContent` renders headings, paragraphs, emphasis, lists, quotes, code, tables and disabled task checkboxes. Raw HTML is inert text. Images render alt text, never network-backed media. Only credential-free HTTP(S) URLs up to4096characters are links, with noopener/noreferrer. No raw HTML plugin, generated heading/footnote IDs, or unsafe DOM property spreading.
- `MarkdownEditor` owns unique label associations, selected-state buttons and a retained controlled textarea. Preview cannot submit or change source. Returning to writing restores focus/selection. Busy and existing template fieldset state remain authoritative.
- Description capacity matches the existing100,000character server limit. Comment20,000limit and existing server trim behavior remain unchanged. Save/cancel/CAS behavior is owned by the existing parent editor; preview never changes persistence.
- Paragraph soft line breaks remain visible. Tables and fenced code scroll locally; plain text wraps within375px layouts.

## Bounded parsing

Deeply nested valid Markdown can exceed parser recursion limits, and delimiter floods can monopolize the main thread. Before parsing, a linear scan falls back to the complete inert source when ASCII punctuation exceeds1024characters, line-break characters (CR or LF) exceed511, bracket nesting exceeds32, a line contains more than32quote markers, or leading indentation exceeds128columns. This intentionally favors source readability over formatting for pathological or very large structured documents, including code snippets that meet these conservative limits. No source is truncated or rewritten. An error boundary preserves source for unexpected render failures and resets when source changes.

## Implementation and verification sequence

1. RED tests for missing formatting/preview, then reader/editor implementation.
2. Real synthetic HTTP fixture checks save/readback, comment normalization, stale-revision rejection and failed-comment draft preservation. Existing template/resource regressions remain unchanged.
3. Independent review reproduced deep quote stack overflow and100kdelimiter delay. Regression payloads now use complete-source fallback; duplicate footnote IDs removed.
4. Local full unit/API/DOM suite, typecheck, lint, build and format checks. Build warnings (existing Zod annotations and bundle chunk-size advisory) remain visible rather than suppressed.
5. Hosted browser gate: desktop/375px save, edit, preview, focus, comment, reload, zero image requests, panel/editor/preview geometry. Local browser execution is not evidence for this change; browser results are required separately before release.

## Files

- `client/features/markdown/MarkdownContent.tsx`: inert rendering, parsing budget and fallback.
- `client/features/markdown/MarkdownEditor.tsx`: controlled source/preview interaction.
- `client/IssuePanel.tsx`, `client/editors.tsx`: issue-only integration.
- `client/styles.css`: scoped content/editor layout.
- `tests/ui/markdown.test.tsx`, `tests/ui/markdown.spec.ts`: source/security/API and browser regressions.

## References

- https://github.com/remarkjs/react-markdown
- https://github.com/remarkjs/remark-gfm
