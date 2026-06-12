import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { User, Shield, Save, Loader2, Users, Mail, Plus, X, UserPlus } from "lucide-react";
import { toast } from "sonner";

const Settings = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [fullName, setFullName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [hospitalOrg, setHospitalOrg] = useState("");
  const [dictationEngine, setDictationEngine] = useState<"fast" | "accurate">("accurate");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Secretary management
  const [secretaryEmail, setSecretaryEmail] = useState("");

  // Email auto-send
  const [autoSendEnabled, setAutoSendEnabled] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [newRecipient, setNewRecipient] = useState("");

  const { data: profile, isLoading } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: async () => {
      if (!user) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", user.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  // Secretaries assigned to this clinician
  const { data: secretaries = [] } = useQuery({
    queryKey: ["secretaries", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("clinician_id", user.id);
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });

  // Sync profile data into local state when loaded
  useEffect(() => {
    if (profile?.full_name && !fullName) {
      setFullName(profile.full_name);
    }
    if (profile) {
      setAutoSendEnabled(profile.auto_send_enabled ?? false);
      setRecipients(profile.auto_send_recipients ?? []);
      if (!roleTitle) setRoleTitle((profile as any).role_title ?? "");
      if (!hospitalOrg) setHospitalOrg((profile as any).hospital_organisation ?? "");
      setDictationEngine(((profile as any).dictation_engine as "fast" | "accurate") ?? "accurate");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const isSecretary = !!profile?.clinician_id;

  const profileMutation = useMutation({
    mutationFn: async (updates: { full_name?: string; role_title?: string | null; hospital_organisation?: string | null }) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await supabase
        .from("profiles")
        .update(updates)
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Profile updated successfully");
    },
    onError: () => {
      toast.error("Failed to update profile");
    },
  });

  const dictationEngineMutation = useMutation({
    mutationFn: async (engine: "fast" | "accurate") => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await supabase
        .from("profiles")
        .update({ dictation_engine: engine } as any)
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Dictation engine updated");
    },
    onError: () => toast.error("Failed to update dictation engine"),
  });

  const passwordMutation = useMutation({
    mutationFn: async (password: string) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated successfully");
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to update password");
    },
  });

  // Secretary mutations
  const addSecretaryMutation = useMutation({
    mutationFn: async (email: string) => {
      const { data, error } = await supabase.functions.invoke("manage-secretary", {
        body: { action: "add", email },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secretaries"] });
      setSecretaryEmail("");
      toast.success("Secretary added");
    },
    onError: (err: any) => toast.error(err.message || "Failed to add secretary"),
  });

  const removeSecretaryMutation = useMutation({
    mutationFn: async (secretaryUserId: string) => {
      const { data, error } = await supabase.functions.invoke("manage-secretary", {
        body: { action: "remove", secretary_user_id: secretaryUserId },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secretaries"] });
      toast.success("Secretary removed");
    },
    onError: (err: any) => toast.error(err.message || "Failed to remove secretary"),
  });

  // Email settings mutation
  const emailSettingsMutation = useMutation({
    mutationFn: async ({ enabled, list }: { enabled: boolean; list: string[] }) => {
      if (!user) throw new Error("Not authenticated");
      const { error } = await supabase
        .from("profiles")
        .update({ auto_send_enabled: enabled, auto_send_recipients: list })
        .eq("user_id", user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      toast.success("Email settings saved");
    },
    onError: () => toast.error("Failed to save email settings"),
  });

  const handleProfileSave = () => {
    if (!fullName.trim()) {
      toast.error("Name cannot be empty");
      return;
    }
    profileMutation.mutate({
      full_name: fullName.trim(),
      role_title: roleTitle.trim() || null,
      hospital_organisation: hospitalOrg.trim() || null,
    });
  };

  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  const handleAddRecipient = () => {
    const email = newRecipient.trim();
    if (!isValidEmail(email)) {
      toast.error("Enter a valid email address");
      return;
    }
    if (recipients.includes(email)) {
      toast.error("That address is already in the list");
      return;
    }
    const updated = [...recipients, email];
    setRecipients(updated);
    setNewRecipient("");
    emailSettingsMutation.mutate({ enabled: autoSendEnabled, list: updated });
  };

  const handleRemoveRecipient = (email: string) => {
    const updated = recipients.filter((r) => r !== email);
    setRecipients(updated);
    emailSettingsMutation.mutate({ enabled: autoSendEnabled, list: updated });
  };

  const handleToggleAutoSend = (enabled: boolean) => {
    setAutoSendEnabled(enabled);
    emailSettingsMutation.mutate({ enabled, list: recipients });
  };

  const handlePasswordChange = () => {
    if (newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    passwordMutation.mutate(newPassword);
  };

  const displayName = fullName || profile?.full_name || user?.user_metadata?.full_name || "User";
  const initials = displayName
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="space-y-3">
      <div className="px-1 pt-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account and preferences</p>
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList>
          <TabsTrigger value="profile" className="gap-2">
            <User className="h-4 w-4" />
            Profile
          </TabsTrigger>
          {!isSecretary && (
            <TabsTrigger value="team" className="gap-2">
              <Users className="h-4 w-4" />
              Team
            </TabsTrigger>
          )}
          {!isSecretary && (
            <TabsTrigger value="email" className="gap-2">
              <Mail className="h-4 w-4" />
              Email
            </TabsTrigger>
          )}
          <TabsTrigger value="security" className="gap-2">
            <Shield className="h-4 w-4" />
            Security
          </TabsTrigger>
        </TabsList>

        {/* Team / Secretaries Tab */}
        {!isSecretary && (
          <TabsContent value="team" className="space-y-6">
            <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
              <CardHeader>
                <CardTitle>Secretary Access</CardTitle>
                <CardDescription>
                  Give a secretary read-only access to your recordings, letters, and audio so they
                  can review your dictations. They must have a NoteMD account first.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    type="email"
                    value={secretaryEmail}
                    onChange={(e) => setSecretaryEmail(e.target.value)}
                    placeholder="secretary@example.com"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && secretaryEmail.trim()) {
                        addSecretaryMutation.mutate(secretaryEmail.trim());
                      }
                    }}
                  />
                  <Button
                    onClick={() => addSecretaryMutation.mutate(secretaryEmail.trim())}
                    disabled={addSecretaryMutation.isPending || !secretaryEmail.trim()}
                    className="gap-2 shrink-0"
                  >
                    {addSecretaryMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <UserPlus className="h-4 w-4" />
                    )}
                    Add
                  </Button>
                </div>

                <Separator />

                {secretaries.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">
                    No secretaries assigned yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {secretaries.map((s: any) => (
                      <div
                        key={s.user_id}
                        className="flex items-center justify-between gap-4 p-3 rounded-lg border bg-card"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="bg-primary/10 text-primary text-xs">
                              {(s.full_name || "S").slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium truncate">
                            {s.full_name || "Secretary"}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeSecretaryMutation.mutate(s.user_id)}
                          disabled={removeSecretaryMutation.isPending}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950 gap-1.5 shrink-0"
                        >
                          <X className="h-3.5 w-3.5" />
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Email Tab */}
        {!isSecretary && (
          <TabsContent value="email" className="space-y-6">
            <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
              <CardHeader>
                <CardTitle>Automatic Email Delivery</CardTitle>
                <CardDescription>
                  Automatically email each generated letter to a fixed set of addresses. You can
                  also send any letter manually from the letter view.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                  <div>
                    <p className="font-medium text-sm">Auto-send letters</p>
                    <p className="text-xs text-muted-foreground">
                      Send each new letter to the recipients below as soon as it's generated.
                    </p>
                  </div>
                  <Switch checked={autoSendEnabled} onCheckedChange={handleToggleAutoSend} />
                </div>

                <div className="space-y-2">
                  <Label>Recipient addresses</Label>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      value={newRecipient}
                      onChange={(e) => setNewRecipient(e.target.value)}
                      placeholder="recipient@nhs.net"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddRecipient();
                        }
                      }}
                    />
                    <Button
                      onClick={handleAddRecipient}
                      disabled={!newRecipient.trim()}
                      variant="outline"
                      className="gap-2 shrink-0"
                    >
                      <Plus className="h-4 w-4" />
                      Add
                    </Button>
                  </div>
                  {recipients.length === 0 ? (
                    <p className="text-xs text-muted-foreground pt-1">
                      No recipients added yet.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2 pt-2">
                      {recipients.map((r) => (
                        <Badge
                          key={r}
                          variant="secondary"
                          className="gap-1.5 pl-3 pr-1.5 py-1.5 text-sm"
                        >
                          {r}
                          <button
                            onClick={() => handleRemoveRecipient(r)}
                            className="rounded-full hover:bg-muted-foreground/20 p-0.5"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="text-xs text-muted-foreground bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-3">
                  <strong>Note:</strong> Clinical letters contain patient-identifiable
                  information. Only send to secure addresses (e.g. nhs.net). Email delivery
                  activates once the sending domain is configured.
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Profile Tab */}
        <TabsContent value="profile" className="space-y-6">
          <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
            <CardHeader>
              <CardTitle>Profile Information</CardTitle>
              <CardDescription>Update your personal details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {isLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-16 w-16 rounded-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : (
                <>
                  {/* Avatar */}
                  <div className="flex items-center gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarFallback className="bg-primary/10 text-primary text-lg font-semibold">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{displayName}</p>
                      <p className="text-sm text-muted-foreground">{user?.email}</p>
                    </div>
                  </div>

                  <Separator />

                  {/* Full Name */}
                  <div className="space-y-2">
                    <Label htmlFor="fullName">Full Name</Label>
                    <Input
                      id="fullName"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Enter your full name"
                    />
                  </div>

                  {/* Email (read-only) */}
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      value={user?.email || ""}
                      disabled
                      className="bg-muted"
                    />
                  </div>

                  {/* Role / Title */}
                  <div className="space-y-2">
                    <Label htmlFor="roleTitle">Role / Title</Label>
                    <Input
                      id="roleTitle"
                      value={roleTitle}
                      onChange={(e) => setRoleTitle(e.target.value)}
                      placeholder="e.g. Consultant Neurologist, GP, Specialist Nurse"
                    />
                    <p className="text-xs text-muted-foreground">
                      Appears in the signature of generated letters.
                    </p>
                  </div>

                  {/* Hospital / Organisation */}
                  <div className="space-y-2">
                    <Label htmlFor="hospitalOrg">Hospital / Organisation</Label>
                    <Input
                      id="hospitalOrg"
                      value={hospitalOrg}
                      onChange={(e) => setHospitalOrg(e.target.value)}
                      placeholder="e.g. Royal Free London NHS Foundation Trust"
                    />
                    <p className="text-xs text-muted-foreground">
                      Appears alongside your name in letter headers and signatures.
                    </p>
                  </div>

                  {/* Dictation Engine preference */}
                  <div className="space-y-2 rounded-lg border border-border/60 p-3">
                    <Label>Dictation Transcription Engine</Label>
                    <p className="text-xs text-muted-foreground -mt-1">
                      Choose how dictation is transcribed. You can change this any time.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setDictationEngine("fast");
                          dictationEngineMutation.mutate("fast");
                        }}
                        className={`text-left rounded-lg border p-3 transition-colors ${
                          dictationEngine === "fast"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-border/80"
                        }`}
                      >
                        <p className="font-medium text-sm">Fast (live)</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Near real-time transcript. Best for speed.
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDictationEngine("accurate");
                          dictationEngineMutation.mutate("accurate");
                        }}
                        className={`text-left rounded-lg border p-3 transition-colors ${
                          dictationEngine === "accurate"
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-border/80"
                        }`}
                      >
                        <p className="font-medium text-sm">Accurate (medical)</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Medical-domain model. Best for clinical terminology.
                        </p>
                      </button>
                    </div>
                  </div>

                  <Button
                    onClick={handleProfileSave}
                    disabled={profileMutation.isPending}
                    className="gap-2"
                  >
                    {profileMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Save Changes
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security Tab */}
        <TabsContent value="security" className="space-y-6">
          <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
            <CardHeader>
              <CardTitle>Change Password</CardTitle>
              <CardDescription>Update your password to keep your account secure</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                />
              </div>
              <Button
                onClick={handlePasswordChange}
                disabled={passwordMutation.isPending || !newPassword}
                className="gap-2"
              >
                {passwordMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Shield className="h-4 w-4" />
                )}
                Update Password
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Settings;
