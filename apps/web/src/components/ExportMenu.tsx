import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { Button } from './ui/index.ts';

export interface ExportMenuItem {
  id: string;
  label: string;
  description?: string;
  icon?: IconName;
  onSelect: () => void;
}

export interface ExportMenuProps {
  items: ExportMenuItem[];
  label?: string; // default "Export"
  disabled?: boolean;
  className?: string;
}

export function ExportMenu({ items, label = 'Export', disabled = false, className = '' }: ExportMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent | PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const events = ['pointerdown', 'mousedown', 'click'] as const;
    for (const event of events) document.addEventListener(event, handleOutside);
    return () => {
      for (const event of events) document.removeEventListener(event, handleOutside);
    };
  }, [open]);

  const focusTrigger = () => {
    wrapperRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) focusTrigger();
  };

  const moveFocus = (index: number) => {
    if (items.length === 0) return;
    const next = ((index % items.length) + items.length) % items.length;
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(items.length - 1);
        break;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        close(true);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={wrapperRef} className={`relative inline-flex ${className}`}>
      <Button
        variant="secondary"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (disabled) return;
          if (open) {
            close(false);
          } else {
            setActiveIndex(0);
            setOpen(true);
          }
        }}
        icon={<Icon name="download" size={16} />}
      >
        <span className="flex items-center gap-1.5">
          {label}
          <Icon name="chevronDown" size={14} className="text-ink-faint" />
        </span>
      </Button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          className="animate-pop-in panel absolute top-full right-0 z-30 mt-1 min-w-56 p-1"
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => { itemRefs.current[index] = element; }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => {
                item.onSelect();
                close(true);
              }}
              className="flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left text-sm text-ink hover:bg-surface-alt focus:bg-brand-soft focus:text-brand"
            >
              {item.icon ? <Icon name={item.icon} size={16} className="mt-0.5 text-ink-soft" /> : null}
              <span className="min-w-0">
                <span className="block font-medium">{item.label}</span>
                {item.description ? <span className="mt-0.5 block text-xs text-ink-soft">{item.description}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
