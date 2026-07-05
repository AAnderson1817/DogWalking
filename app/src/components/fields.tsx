// Form field primitives (spec 05): Input, Textarea, Select — labelled,
// 44px touch targets, shared error styling.
import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";

interface FieldChrome {
  label?: string;
  error?: string;
}

export function Input({
  label,
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & FieldChrome) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <input
        id={id}
        className={["field__control", className ?? ""].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error && <span className="field__error">{error}</span>}
    </label>
  );
}

export function Textarea({
  label,
  error,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldChrome) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <textarea
        id={id}
        className={["field__control", "field__control--textarea", className ?? ""]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error && <span className="field__error">{error}</span>}
    </label>
  );
}

export function Select({
  label,
  error,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & FieldChrome) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <select
        id={id}
        className={["field__control", className ?? ""].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        {...rest}
      >
        {children}
      </select>
      {error && <span className="field__error">{error}</span>}
    </label>
  );
}
