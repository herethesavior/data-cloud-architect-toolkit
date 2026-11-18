import { useEffect, useRef, useState } from 'react';
import { Button } from './Button.tsx';
import { Icon } from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';

interface CopyButtonProps {
  value: string;
  label: string;
  icon?: IconName;
  className?: string;
}

/** Copies metadata only; the app never has credentials or session material to copy. */
export function CopyButton({ value, label, icon = 'copy', className = '' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button
      variant="quiet"
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : label}
      className={`px-2 py-1 text-xs ${className}`}
    >
      <Icon name={copied ? 'check' : icon} size={14} />
      <span>{copied ? 'Copied' : label}</span>
    </Button>
  );
}
