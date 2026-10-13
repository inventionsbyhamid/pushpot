import type { ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const base =
  "inline-flex min-h-12 select-none items-center justify-center gap-2 rounded-[0.625rem] px-5 text-center font-display text-[1.375rem] leading-none font-extrabold tracking-[0.01em] disabled:cursor-not-allowed disabled:opacity-40";

const variants: Record<ButtonVariant, string> = {
  primary: "press bg-volt text-ink hover:bg-[#d9ff5e]",
  secondary:
    "press border border-line bg-raised text-chalk [--press-shade:var(--color-line)] hover:border-mute",
  ghost: "text-chalk hover:bg-raised active:bg-line",
  danger:
    "press border border-flare/50 bg-raised text-flare [--press-shade:color-mix(in_oklab,var(--color-flare)_35%,var(--color-ink))]",
};

export function buttonClass(variant: ButtonVariant = "primary", className = ""): string {
  return `${base} ${variants[variant]} ${className}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
}

export function ButtonLink({ variant, className, ...props }: ButtonLinkProps) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}
