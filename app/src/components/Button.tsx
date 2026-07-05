import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "accent" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  full?: boolean;
}

export function Button({ variant = "primary", full, className, ...rest }: ButtonProps) {
  const classes = ["btn", `btn--${variant}`, full ? "btn--full" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <button className={classes} {...rest} />;
}
