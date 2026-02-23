import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

type CardProps = HTMLAttributes<HTMLElement> & {
  elevated?: boolean
}

export function Card({ className, elevated = false, ...props }: CardProps) {
  return <section className={cn('oc-card', elevated && 'oc-card--elevated', className)} {...props} />
}
