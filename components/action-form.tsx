"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { ActionState } from "@/app/actions/users";

type Props = {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  confirm?: string;
};

export function ActionForm({ action, children, submitLabel, variant = "primary", className = "stack", confirm }: Props) {
  const [state, formAction, pending] = useActionState(action, { ok: false, message: "" });
  const buttonClass = variant === "primary" ? undefined : variant === "danger" ? "danger secondary" : "secondary";
  return (
    <form action={formAction} className={className} onSubmit={confirm ? (event) => { if (!window.confirm(confirm)) event.preventDefault(); } : undefined}>
      {children}
      {state.message && <p role={state.ok ? "status" : "alert"} className={state.ok ? "success" : "error"}>{state.message}</p>}
      <button type="submit" className={buttonClass} disabled={pending}>{pending ? "Procesando…" : submitLabel}</button>
    </form>
  );
}
