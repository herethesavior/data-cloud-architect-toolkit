import type { ReactNode } from 'react';

interface PageIntroProps {
  title: string;
  description: string;
  actions?: ReactNode;
  meta?: ReactNode;
}

export function PageIntro({ title, description, actions, meta }: PageIntroProps) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">{description}</p>
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div> : null}
    </div>
  );
}
