import type { ReactNode } from 'react';

interface SectionHeadingProps {
  title: string;
  description?: string;
  action?: ReactNode;
  id?: string;
  as?: 'h2' | 'h3' | 'h4';
}

export function SectionHeading({ title, description, action, id, as: Heading = 'h2' }: SectionHeadingProps) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <Heading id={id} className="text-base font-semibold tracking-tight text-ink">
          {title}
        </Heading>
        {description ? <p className="mt-1 break-words text-sm text-ink-soft">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
