import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { HardHat, KeyRound, MailCheck, ShieldCheck, ArrowLeft } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorNote } from "@/components/ui/primitives";

type Step = "email" | "code" | "password" | "done";

/**
 * Forgot password — 3 steps over an emailed 6-digit code.
 *
 *   1. email      → server mails a code (hashed at rest, 10 minutes, single use)
 *   2. code       → checked before asking for a password, so a typo costs one field
 *   3. password   → code is consumed and the new password is saved
 *
 * When SMTP is not configured the server cannot deliver the code; it says so and
 * (outside production) returns the code so the flow stays testable. That code is
 * shown in a clearly-labelled testing notice — never as if it had been emailed.
 */
export default function ForgotPassword() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  const request = trpc.auth.requestPasswordReset.useMutation();
  const verify = trpc.auth.verifyResetCode.useMutation();
  const reset = trpc.auth.resetPassword.useMutation();

  async function onRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setDevCode(null);
    try {
      const res = await request.mutateAsync({ email: email.trim() });
      if (res.sent) {
        setNotice(`We emailed a 6-digit code to ${email.trim()}. It expires in ${res.expiresInMinutes ?? 10} minutes.`);
      } else if (res.status === "not_configured") {
        setNotice("Email is not configured on the server, so the code could not be sent.");
        setDevCode(res.devCode ?? null);
      } else if (res.status === "failed") {
        setNotice("The mail server rejected the message, so the code could not be sent.");
      } else {
        // Unknown address: same message as the success path would give, so this
        // screen cannot be used to find out who has an account.
        setNotice(`If an account exists for ${email.trim()}, a 6-digit code has been sent to it.`);
      }
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request a code.");
    }
  }

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    try {
      await verify.mutateAsync({ email: email.trim(), code: code.trim() });
      setStep("password");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code is not valid.");
    }
  }

  async function onReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Your new password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    try {
      await reset.mutateAsync({ email: email.trim(), code: code.trim(), password });
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset the password.");
    }
  }

  const busy = request.isPending || verify.isPending || reset.isPending;

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <HardHat className="h-6 w-6" />
          </div>
          <div>
            <p className="font-bold">Equipment Rental</p>
            <p className="text-xs text-sidebar-muted">Management System</p>
          </div>
        </div>
        <div className="space-y-6">
          <h1 className="text-3xl font-bold leading-tight">Reset your password with a code sent to your email.</h1>
          <ul className="space-y-3 text-sm text-sidebar-foreground/80">
            <li className="flex items-center gap-3">
              <MailCheck className="h-4 w-4 text-accent" /> A 6-digit code, valid for 10 minutes
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-4 w-4 text-accent" /> Single use, and stored hashed — never in plain text
            </li>
            <li className="flex items-center gap-3">
              <KeyRound className="h-4 w-4 text-accent" /> Then choose a new password and sign in
            </li>
          </ul>
        </div>
        <p className="text-xs text-sidebar-muted">Codes are rate-limited — request a new one if yours expires.</p>
      </div>

      <main className="flex items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">
              {step === "done" ? "Password updated" : "Forgot password?"}
            </CardTitle>
            <CardDescription>
              {step === "email" && "Enter your email and we'll send you a 6-digit code."}
              {step === "code" && "Enter the 6-digit code from your email."}
              {step === "password" && "Choose a new password."}
              {step === "done" && "You can now log in with your new password."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === "email" && (
              <form onSubmit={onRequest} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                {error && <ErrorNote>{error}</ErrorNote>}
                <Button type="submit" className="w-full" disabled={busy}>
                  {request.isPending ? "Sending…" : "Send reset code"}
                </Button>
              </form>
            )}

            {step === "code" && (
              <form onSubmit={onVerify} className="space-y-4">
                {notice && (
                  <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">{notice}</p>
                )}
                {devCode && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                    <p className="font-semibold">Email is not configured — test code</p>
                    <p>
                      Your code is <span className="font-mono text-base font-bold tracking-widest">{devCode}</span>
                    </p>
                    <p className="text-xs opacity-80">Shown only while SMTP is unset. Configure SMTP_HOST/SMTP_USER/SMTP_PASS to email it instead.</p>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="code">6-digit code</Label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    className="text-center font-mono text-lg tracking-[0.4em]"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    required
                  />
                </div>
                {error && <ErrorNote>{error}</ErrorNote>}
                <Button type="submit" className="w-full" disabled={busy || code.length < 6}>
                  {verify.isPending ? "Checking…" : "Continue"}
                </Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => setStep("email")} disabled={busy}>
                  Use a different email
                </Button>
              </form>
            )}

            {step === "password" && (
              <form onSubmit={onReset} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">At least 8 characters.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm">Confirm new password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </div>
                {error && <ErrorNote>{error}</ErrorNote>}
                <Button type="submit" className="w-full" disabled={busy}>
                  {reset.isPending ? "Saving…" : "Set new password"}
                </Button>
              </form>
            )}

            {step === "done" && (
              <div className="space-y-4">
                <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                  Your password has been changed. Log in with it now.
                </p>
                <Button className="w-full" onClick={() => navigate("/login")}>
                  Go to login
                </Button>
              </div>
            )}

            {step !== "done" && (
              <p className="mt-4 text-center text-sm text-muted-foreground">
                <Link to="/login" className="inline-flex items-center gap-1 font-medium text-primary underline">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back to login
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
