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
  id: providedId,
  "aria-describedby": providedDescription,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & FieldChrome) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [providedDescription, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <input
        id={id}
        className={["field__control", className ?? ""].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-errormessage={errorId}
        {...rest}
      />
      {error && <span id={errorId} className="field__error">{error}</span>}
    </label>
  );
}

export function Textarea({
  label,
  error,
  className,
  id: providedId,
  "aria-describedby": providedDescription,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldChrome) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [providedDescription, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <textarea
        id={id}
        className={["field__control", "field__control--textarea", className ?? ""]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-errormessage={errorId}
        {...rest}
      />
      {error && <span id={errorId} className="field__error">{error}</span>}
    </label>
  );
}

export function Select({
  label,
  error,
  className,
  children,
  id: providedId,
  "aria-describedby": providedDescription,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & FieldChrome) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [providedDescription, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <label className="field" htmlFor={id}>
      {label && <span className="field__label">{label}</span>}
      <select
        id={id}
        className={["field__control", className ?? ""].filter(Boolean).join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-errormessage={errorId}
        {...rest}
      >
        {children}
      </select>
      {error && <span id={errorId} className="field__error">{error}</span>}
    </label>
  );
}
