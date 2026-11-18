import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
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

interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

export function ExportMenu({ items, label = 'Export', disabled = false, className = '' }: ExportMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0, width: 0 });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const getTrigger = () => wrapperRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') ?? null;

  const updatePosition = useCallback(() => {
    const trigger = getTrigger();
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const anchor = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 4;
    const edge = 8;
    const width = Math.max(menuRect.width, anchor.width);
    const left = Math.min(
      Math.max(edge, anchor.right - width),
      Math.max(edge, window.innerWidth - width - edge),
    );
    const fitsBelow = anchor.bottom + gap + menuRect.height <= window.innerHeight - edge;
    const top = fitsBelow
      ? anchor.bottom + gap
      : Math.max(edge, anchor.top - gap - menuRect.height);

    setPosition({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const events = ['pointerdown', 'mousedown', 'click'] as const;
    for (const event of events) document.addEventListener(event, handleOutside);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      for (const event of events) document.removeEventListener(event, handleOutside);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) getTrigger()?.focus();
  };

  const focusOutsideMenu = (backwards: boolean) => {
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const trigger = getTrigger();
    const triggerIndex = trigger ? focusables.indexOf(trigger) : -1;
    if (triggerIndex < 0) return;
    const candidates = backwards
      ? focusables.slice(0, triggerIndex).reverse()
      : focusables.slice(triggerIndex + 1);
    candidates.find((element) => !wrapperRef.current?.contains(element) && !menuRef.current?.contains(element))?.focus();
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
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        // Move focus outside the trigger and portalled items instead of trapping it.
        event.preventDefault();
        close(false);
        focusOutsideMenu(event.shiftKey);
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
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={label}
              onKeyDown={handleMenuKeyDown}
              style={{
                position: 'fixed',
                top: position.top,
                left: position.left,
                minWidth: position.width || undefined,
                maxWidth: 'calc(100vw - 16px)',
              }}
              className="animate-pop-in panel z-[70] max-h-[min(24rem,80vh)] overflow-y-auto p-1"
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
