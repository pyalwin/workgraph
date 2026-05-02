"use client"

import { cn } from "@/lib/utils"
import React from "react"

export type CodeBlockProps = {
  children?: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-black/[0.07] bg-[#fafafa] text-[#333] rounded-xl",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type CodeBlockCodeProps = {
  code: string
  language?: string
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlockCode({
  code,
  language = "text",
  className,
  ...props
}: CodeBlockCodeProps) {
  return (
    <div
      className={cn(
        "w-full overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-4",
        className
      )}
      {...props}
    >
      <pre className="bg-transparent">
        <code className="font-mono text-[0.78rem] text-[#555] leading-relaxed">{code}</code>
      </pre>
    </div>
  )
}

export { CodeBlockCode, CodeBlock }
