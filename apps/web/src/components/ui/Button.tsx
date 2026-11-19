import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

const variants: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  quiet: 'btn-quiet',
  danger: 'btn-danger',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', icon, children, className = '', type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={`${variants[variant]} ${className}`} {...props}>
      {icon}
      {children}
    </button>
  );
}
