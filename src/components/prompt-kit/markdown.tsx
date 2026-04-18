"use client"

import { cn } from "@/lib/utils"
import { marked } from "marked"
import { memo, useId, useMemo } from "react"
import ReactMarkdown, { Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { CodeBlock, CodeBlockCode } from "./code-block"

export type MarkdownProps = {
  children: string
  id?: string
  className?: string
  components?: Partial<Components>
}

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown)
  return tokens.map((token) => token.raw)
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext"
  const match = className.match(/language-(\w+)/)
  return match ? match[1] : "plaintext"
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line

    if (isInline) {
      return (
        <span
          className={cn(
            "bg-[#f0f0f0] rounded-sm px-1 font-mono text-[0.75rem] text-[#555]",
            className
          )}
        >
          {children}
        </span>
      )
    }

    const language = extractLanguage(className)

    return (
      <CodeBlock className={className}>
        <CodeBlockCode code={children as string} language={language} />
      </CodeBlock>
    )
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>
  },
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string
    components?: Partial<Components>
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    )
  },
  function propsAreEqual(prevProps, nextProps) {
    return prevProps.content === nextProps.content
  }
)

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock"

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  const generatedId = useId()
  const blockId = id ?? generatedId
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children])

  return (
    <div className={cn(
      "prose-sm max-w-none",
      "[&_h1]:text-[0.95rem] [&_h1]:font-semibold [&_h1]:text-[#333] [&_h1]:mt-3 [&_h1]:mb-1",
      "[&_h2]:text-[0.87rem] [&_h2]:font-semibold [&_h2]:text-[#333] [&_h2]:mt-3 [&_h2]:mb-1",
      "[&_h3]:text-[0.82rem] [&_h3]:font-semibold [&_h3]:text-[#333] [&_h3]:mt-2 [&_h3]:mb-1",
      "[&_h4]:text-[0.78rem] [&_h4]:font-semibold [&_h4]:text-[#333] [&_h4]:mt-2 [&_h4]:mb-1",
      "[&_p]:text-[0.78rem] [&_p]:text-[#555] [&_p]:leading-[1.6] [&_p]:mb-2",
      "[&_ul]:text-[0.78rem] [&_ul]:text-[#555] [&_ul]:pl-4 [&_ul]:mb-2 [&_ul]:list-disc",
      "[&_ol]:text-[0.78rem] [&_ol]:text-[#555] [&_ol]:pl-4 [&_ol]:mb-2 [&_ol]:list-decimal",
      "[&_li]:mb-0.5 [&_li]:leading-[1.5]",
      "[&_a]:text-[#2563eb] [&_a]:no-underline hover:[&_a]:underline",
      "[&_strong]:font-semibold [&_strong]:text-[#333]",
      "[&_blockquote]:border-l-2 [&_blockquote]:border-[#ddd] [&_blockquote]:pl-3 [&_blockquote]:text-[#777] [&_blockquote]:italic",
      "[&_hr]:border-black/[0.07] [&_hr]:my-2",
      "[&_table]:text-[0.75rem] [&_table]:w-full [&_table]:border-collapse",
      "[&_th]:text-left [&_th]:font-semibold [&_th]:text-[#333] [&_th]:border-b [&_th]:border-black/[0.07] [&_th]:pb-1 [&_th]:pr-3",
      "[&_td]:text-[#555] [&_td]:border-b [&_td]:border-black/[0.05] [&_td]:py-1 [&_td]:pr-3",
      className
    )}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
        />
      ))}
    </div>
  )
}

const Markdown = memo(MarkdownComponent)
Markdown.displayName = "Markdown"

export { Markdown }
