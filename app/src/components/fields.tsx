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

/**
 * The single place a form error is rendered. Always mounts, so the live
 * region exists in the accessibility tree before the message arrives —
 * `role="alert"` on an element that appears together with its text is
 * announced far less reliably. Empty, it is taken out of flow by
 * `.form-error:empty` and occupies nothing.
 *
 * Every error in the product goes through here; CI fails a bare
 * `className="field__error"` outside this file.
 */
export function FormError({
  message,
  id,
  className,
}: {
  message?: string | null;
  id?: string;
  className?: string;
}) {
  return (
    // A span, not a <p>: these regions live inside <label>, whose content
    // model is phrasing content only.
    <span
      id={id}
      role="alert"
      className={["form-error", "field__error", className ?? ""].filter(Boolean).join(" ")}
    >
      {/* `|| null` rather than `?? ""` — React renders an empty string as a
          text node, which would stop `:empty` matching and leave the region
          taking up a `gap` in every form that has no error. */}
      {message || null}
    </span>
  );
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
  // The id is stable whether or not there is an error, because the region is
  // always in the DOM. aria-errormessage may point at it unconditionally —
  // assistive technology only consults it while aria-invalid is true.
  const errorId = `${id}-error`;
  const describedBy = [providedDescription, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;
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
      <FormError id={errorId} message={error} />
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
  const errorId = `${id}-error`;
  const describedBy = [providedDescription, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;
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
      <FormError id={errorId} message={error} />
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
  const errorId = `${id}-error`;
  const describedBy = [providedDescription, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ") || undefined;
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
      <FormError id={errorId} message={error} />
    </label>
  );
}
