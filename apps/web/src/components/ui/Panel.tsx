import type { HTMLAttributes, ReactNode } from 'react';

interface PanelProps extends HTMLAttributes<HTMLElement> {
  padded?: boolean;
  children: ReactNode;
}

export function Panel({ padded = true, className = '', children, ...props }: PanelProps) {
  return (
    <section className={`panel ${padded ? 'panel-pad' : ''} ${className}`} {...props}>
      {children}
    </section>
  );
}
