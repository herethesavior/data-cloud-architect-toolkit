import { useId, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  items: TabItem[];
  label: string;
  /** Controlled selection for tabs that are reflected in the URL. */
  activeId?: string;
  onActiveChange?: (id: string) => void;
}

export function Tabs({ items, label, activeId, onActiveChange }: TabsProps) {
  const baseId = useId();
  const [internalActiveId, setInternalActiveId] = useState(items[0]?.id ?? '');
  const currentId = activeId ?? internalActiveId;
  const activeItem = items.find((item) => item.id === currentId) ?? items[0];

  if (!activeItem) return null;

  const select = (id: string) => {
    if (activeId === undefined) setInternalActiveId(id);
    onActiveChange?.(id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;

    event.preventDefault();
    const target = items[next]!;
    select(target.id);
    const element = document.getElementById(`${baseId}-tab-${target.id}`);
    element?.focus();
    element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5 border-b border-line pb-2">
        {items.map((item, index) => {
          const active = item.id === activeItem.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-controls={`${baseId}-panel-${item.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => select(item.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                active
                  ? 'bg-brand-soft text-brand'
                  : 'text-ink-soft hover:bg-surface-alt hover:text-ink'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${activeItem.id}`}
        aria-labelledby={`${baseId}-tab-${activeItem.id}`}
        tabIndex={0}
        className="pt-4"
      >
        {activeItem.content}
      </div>
    </div>
  );
}
