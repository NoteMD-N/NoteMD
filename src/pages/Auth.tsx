import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ArrowRight, Mic, FileText, ShieldCheck } from "lucide-react";
import { BrandLockup, BrandLockupWhite } from "@/components/BrandLogo";

const FEATURES = [
  { icon: Mic, text: "Record consultations with real-time, medical-grade transcription" },
  { icon: FileText, text: "Generate structured clinical letters in seconds, in your own templates" },
  { icon: ShieldCheck, text: "UK-hosted, encrypted, and built around NHS documentation standards" },
];

type Mode = "login" | "signup" | "reset";

const Auth = () => {
  const [mode, setMode] = useState<Mode>("login");
  const isLogin = mode === "login";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        // Deliberately worded so it does not reveal whether the address is
        // registered — otherwise this becomes an account enumeration oracle.
        toast.success("If that address has an account, a reset link is on its way.");
        setMode("login");
      } else if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Logged in successfully");
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        toast.success("Account created! Check your email to confirm.");
      }
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Left panel — branding / hero */}
      <div className="relative hidden lg:flex lg:w-[480px] flex-col justify-between p-10 text-white overflow-hidden gradient-hero">
        {/* subtle decorative glow */}
        <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-white/5 blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-0 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />

        {/* Logo — white version directly on the gradient */}
        <div className="relative">
          <BrandLockupWhite className="h-20 w-auto object-contain" />
        </div>

        {/* Hero copy */}
        <div className="relative space-y-6">
          <h2 className="font-heading text-3xl font-bold leading-tight">
            Clinical documentation,
            <br />
            done in the room.
          </h2>
          <p className="max-w-sm text-sm leading-relaxed text-white/60">
            Record the consultation, review the transcript, and get a polished clinical
            letter — so you can spend less time writing and more time with patients.
          </p>

          <ul className="space-y-3 pt-2">
            {FEATURES.map((f, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <f.icon className="h-4 w-4 text-white" />
                </span>
                <span className="text-sm leading-snug text-white/80">{f.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/30">
          &copy; {new Date().getFullYear()} NoteMD. All rights reserved.
        </p>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 items-center justify-center bg-background p-6 sm:p-8">
        <div className="w-full max-w-sm animate-fade-in">
          {/* Logo for mobile (left panel hidden) */}
          <div className="mb-8 flex justify-center lg:hidden">
            <BrandLockup className="h-14 w-auto object-contain" />
          </div>

          <div className="mb-6">
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
              {mode === "reset"
                ? "Reset your password"
                : isLogin
                ? "Welcome back"
                : "Create your account"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {isLogin
                ? "Sign in to access your recordings and letters"
                : mode === "reset"
                ? "We'll email you a link to set a new password"
                : "Register to start documenting consultations"}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="fullName">Full Name</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="Dr. John Smith"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required={mode === "signup"}
                  className="h-11"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="doctor@nhs.net"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-11"
              />
            </div>
            {mode !== "reset" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="password">Password</Label>
                  {isLogin && (
                    <button
                      type="button"
                      onClick={() => setMode("reset")}
                      className="text-xs text-primary hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required={mode !== "reset"}
                  minLength={6}
                  className="h-11"
                />
              </div>
            )}

            {mode === "reset" && (
              <p className="text-sm text-muted-foreground">
                Enter your email address and we'll send you a link to set a new password.
              </p>
            )}
            <Button type="submit" className="h-11 w-full font-medium" disabled={loading}>
              {loading ? (
                "Please wait..."
              ) : (
                <span className="flex items-center gap-2">
                  {mode === "reset" ? "Send reset link" : isLogin ? "Sign In" : "Create Account"}
                  <ArrowRight className="h-4 w-4" />
                </span>
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "reset" ? (
              <button
                type="button"
                onClick={() => setMode("login")}
                className="font-medium text-primary hover:underline"
              >
                Back to sign in
              </button>
            ) : (
              <>
                {isLogin ? "Don't have an account? " : "Already have an account? "}
                <button
                  type="button"
                  onClick={() => setMode(isLogin ? "signup" : "login")}
                  className="font-medium text-primary hover:underline"
                >
                  {isLogin ? "Register" : "Sign in"}
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Auth;
