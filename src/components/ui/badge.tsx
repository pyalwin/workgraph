import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "bg-black text-white",
        secondary: "bg-[#f5f5f5] text-[#555]",
        success: "bg-[rgba(26,135,84,0.08)] text-[#1a8754]",
        destructive: "bg-[rgba(197,48,48,0.08)] text-[#c53030]",
        outline: "border border-black/[0.07] text-[#555]",
        source: "text-[0.63rem] font-bold uppercase tracking-[0.03em] px-[6px] py-[2px] rounded-[3px] text-white bg-black",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
