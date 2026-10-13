import type { AnchorHTMLAttributes } from "react";

export function ExternalLink({
  children,
  className = "",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      target="_blank"
      rel="noopener noreferrer"
      className={`underline decoration-line decoration-2 underline-offset-4 hover:decoration-volt ${className}`}
      {...props}
    >
      {children}
    </a>
  );
}
