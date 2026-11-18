import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const tones: Record<BadgeTone, string> = {
  neutral: 'border-line bg-surface-alt text-ink-soft',
  brand: 'border-brand/20 bg-brand-soft text-brand',
  success: 'border-success/20 bg-success-soft text-success',
  warning: 'border-warning/20 bg-warning-soft text-warning',
  danger: 'border-danger/20 bg-danger-soft text-danger',
};

const dots: Record<BadgeTone, string> = {
  neutral: 'bg-ink-faint',
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = 'neutral', dot = false, children, className = '' }: BadgeProps) {
  return (
    <span className={`badge ${tones[tone]} ${className}`}>
      {dot ? <span aria-hidden="true" className={`size-1.5 rounded-full ${dots[tone]}`} /> : null}
      {children}
    </span>
  );
}
