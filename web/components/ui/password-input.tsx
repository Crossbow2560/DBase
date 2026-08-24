"use client";

import * as React from "react";
import { Lock, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Shared by every password field in the (auth) flow (login, register, password-reset confirm) —
// same leading-lock-icon layout those pages already used inline, plus a show/hide toggle none of
// them had at all.
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">
>(({ className, ...props }, ref) => {
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <Lock
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input ref={ref} type={visible ? "text" : "password"} className={cn("pl-9 pr-9", className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={visible ? "Hide password" : "Show password"}
        // Password managers/autofill UIs sometimes inject their own icon in this same corner —
        // tabIndex -1 keeps this toggle out of the way of normal tab order through the form
        // (email -> password -> submit), consistent with it being a convenience control, not a
        // form field itself.
        tabIndex={-1}
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";
