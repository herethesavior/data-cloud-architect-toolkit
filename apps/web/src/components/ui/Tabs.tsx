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
}

export function Tabs({ items, label }: TabsProps) {
  const baseId = useId();
  const [activeId, setActiveId] = useState(items[0]?.id ?? '');
  const activeItem = items.find((item) => item.id === activeId) ?? items[0];

  if (!activeItem) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;

    event.preventDefault();
    setActiveId(items[next]!.id);
    document.getElementById(`${baseId}-tab-${items[next]!.id}`)?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
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
              onClick={() => setActiveId(item.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'border-brand text-brand'
                  : 'border-transparent text-ink-soft hover:border-line-strong hover:text-ink'
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
