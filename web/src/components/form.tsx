// Small pieces shared by every TanStack Form in the app: inline field errors and a form-level server error.

import type { AnyFieldApi } from "@tanstack/react-form";
import { type CSSProperties, type InputHTMLAttributes, useCallback, useState } from "react";
import { ApiError } from "../api";

/** The field's first error, once the user has touched it or tried to submit. */
export function FieldError({ field }: { field: AnyFieldApi }) {
  const { errors, isTouched } = field.state.meta;
  const attempted = field.form.state.submissionAttempts > 0;
  const first = errors.find((e) => e !== undefined && e !== null && e !== "");
  if (!first || !(isTouched || attempted)) return null;
  return (
    <div className="field-error" role="alert">
      {String(first)}
    </div>
  );
}

/** Whether a field should render as invalid (red border). */
export const invalid = (field: AnyFieldApi) =>
  field.state.meta.errors.some(Boolean) &&
  (field.state.meta.isTouched || field.form.state.submissionAttempts > 0);

/**
 * A form-level error from the server. Kept outside the form's own error map, which would make `canSubmit`
 * false and block a retry.
 */
export function useServerError() {
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)),
    [],
  );
  const clear = useCallback(() => setError(null), []);
  return { error, fail, clear };
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="note down form-error" role="alert">
      {error}
    </div>
  );
}

// ---------- validators ----------

const DEC = /^\d+(\.\d+)?$|^\.\d+$/;

/** A positive decimal string, or an error message. */
export function positive(v: string, what = "Amount"): string | undefined {
  if (!v.trim()) return `${what} is required`;
  if (!Number.isFinite(Number(v))) return `${what} must be a number`;
  if (!(Number(v) > 0)) return `${what} must be more than 0`;
  if (!DEC.test(v.trim())) return `${what} must be a plain decimal`;
  return undefined;
}

export const decimals = (v: string) => (v.includes(".") ? v.split(".")[1]!.length : 0);

/** A decimal string as an integer count of 10^-d units. */
function units(v: string, d: number): bigint {
  const [i = "0", f = ""] = v.trim().split(".");
  return BigInt((i || "0") + f.padEnd(d, "0").slice(0, d));
}

/** Whether `v` is a whole multiple of `step` (both decimal strings), exactly. */
export function multipleOf(v: string, step: string): boolean {
  if (!DEC.test(v.trim()) || !DEC.test(step.trim())) return false;
  const d = Math.max(decimals(v), decimals(step));
  const b = units(step, d);
  return b > 0n && units(v, d) % b === 0n;
}

/** A text input bound to a field, with its inline error underneath. */
export function Input({
  field,
  className = "",
  wrap,
  transform,
  ...rest
}: { field: AnyFieldApi; wrap?: CSSProperties; transform?: (v: string) => string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onBlur"
>) {
  return (
    <div className="field-wrap" style={wrap}>
      <input
        {...rest}
        className={`input ${className} ${invalid(field) ? "bad" : ""}`}
        value={field.state.value as string}
        onChange={(e) => field.handleChange(transform ? transform(e.target.value) : e.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={invalid(field)}
      />
      <FieldError field={field} />
    </div>
  );
}
