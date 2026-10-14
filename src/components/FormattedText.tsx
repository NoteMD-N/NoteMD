/**
 * Renders the small amount of Markdown the summariser produces.
 *
 * Only used for read-only text. Editable clinical text has its Markdown
 * stripped instead, because a letter is pasted into record systems, emailed
 * and printed, and a `**` is noise in all three. Here the text is only ever
 * read, so the headings are worth showing as headings.
 *
 * Deliberately not a Markdown library. This builds React elements directly —
 * there is no `dangerouslySetInnerHTML`, so model output cannot inject markup
 * however it is shaped — and it adds nothing to the bundle. The grammar is
 * exactly what the summariser's prompt asks for: bold runs, bullet lines, and
 * paragraphs.
 */

import { Fragment, type ReactNode } from "react";

/** Splits one line into plain and bold runs. */
function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Paired markers only, with non-space content, so an asterisk used as a
  // footnote marker is left as an asterisk.
  const pattern = /\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) nodes.push(line.slice(last, match.index));
    nodes.push(
      <strong key={`${keyPrefix}-b${i++}`} className="font-semibold">
        {match[1]}
      </strong>,
    );
    last = match.index + match[0].length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes.length > 0 ? nodes : [line];
}

interface Props {
  text: string;
  className?: string;
}

export default function FormattedText({ text, className }: Props) {
  if (!text) return null;

  const lines = text.split("\n");

  return (
    <div className={className}>
      {lines.map((line, index) => {
        const trimmed = line.trim();

        // A blank line is a paragraph break, and carries that meaning only
        // when something follows it.
        if (!trimmed) return <div key={index} className="h-2" aria-hidden />;

        // A line that is entirely bold is a heading in the summariser's
        // output, and reads better with space above it.
        const wholeLineBold = /^\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*$/.exec(trimmed);
        if (wholeLineBold) {
          return (
            <p key={index} className="font-semibold mt-3 first:mt-0">
              {wholeLineBold[1]}
            </p>
          );
        }

        const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
        if (bullet) {
          return (
            <p key={index} className="pl-4 -indent-3">
              <span aria-hidden>• </span>
              {renderInline(bullet[1], String(index))}
            </p>
          );
        }

        return (
          <p key={index}>
            {renderInline(line, String(index)).map((node, i) => (
              <Fragment key={i}>{node}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
