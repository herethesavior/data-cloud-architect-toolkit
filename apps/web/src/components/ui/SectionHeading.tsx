import type { ReactNode } from 'react';

interface SectionHeadingProps {
  title: string;
  description?: string;
  action?: ReactNode;
  id?: string;
}

export function SectionHeading({ title, description, action, id }: SectionHeadingProps) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-base font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description ? <p className="mt-1 break-words text-sm text-ink-soft">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
