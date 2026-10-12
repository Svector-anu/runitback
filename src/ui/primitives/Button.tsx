import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "default" | "outline" | "secondary" | "destructive" | "destructive-outline" | "ghost" | "text";
export type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Accessible name for icon-only buttons. */
  label?: string;
  /** Hover/focus tooltip. Defaults to `label`; pass `false` when the caller already wraps the button in a Tooltip. */
  tooltip?: ReactNode | false;
}

const SIZE_CLASS: Record<ButtonSize, string> = { default: "", sm: "btn--sm", lg: "btn--lg", icon: "btn--icon", "icon-lg": "btn--icon-lg" };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "default", label, tooltip, className, type = "button", children, ...rest }, ref,
): ReactNode {
  const classes = ["btn", `btn--${variant}`, SIZE_CLASS[size], className].filter(Boolean).join(" ");
  const button = (
    <button ref={ref} type={type} className={classes} aria-label={label} {...rest}>
      {children}
    </button>
  );
  const tip = tooltip === undefined ? label : tooltip;
  return tip && !rest.disabled ? <Tooltip content={tip} delay={400}>{button}</Tooltip> : button;
});
