import type { ReactNode } from "react"

// A tiny, XSS-safe markdown-to-JSX renderer. It only produces React elements
// (never dangerouslySetInnerHTML), so untrusted KP text can never inject HTML.
// Supports **bold**, __bold__, *italic*, _italic_, `code`, paragraphs (blank
// line) and hard line breaks. That is enough for KP narration.

const INLINE =
  /(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)|(`([^`]+)`)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  INLINE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    if (match[2] != null) nodes.push(<strong key={`${keyPrefix}-${key++}`}>{match[2]}</strong>)
    else if (match[4] != null) nodes.push(<strong key={`${keyPrefix}-${key++}`}>{match[4]}</strong>)
    else if (match[6] != null) nodes.push(<em key={`${keyPrefix}-${key++}`}>{match[6]}</em>)
    else if (match[8] != null) nodes.push(<em key={`${keyPrefix}-${key++}`}>{match[8]}</em>)
    else if (match[10] != null) nodes.push(<code key={`${keyPrefix}-${key++}`}>{match[10]}</code>)
    last = INLINE.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function MiniMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/)
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split("\n")
        return (
          <p key={bi} className="md-p">
            {lines.flatMap((line, li) =>
              li === 0
                ? renderInline(line, `${bi}-${li}`)
                : [<br key={`br-${bi}-${li}`} />, ...renderInline(line, `${bi}-${li}`)],
            )}
          </p>
        )
      })}
    </>
  )
}
