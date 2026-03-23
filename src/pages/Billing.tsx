import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Check, CreditCard, Zap } from "lucide-react";
import { startOfMonth } from "date-fns";

const FREE_LIMITS = {
  recordings: 25,
  letters: 25,
};

const Billing = () => {
  const { data: recordings = [] } = useQuery({
    queryKey: ["recordings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recordings")
        .select("id, created_at")
        .gte("created_at", startOfMonth(new Date()).toISOString());
      if (error) throw error;
      return data;
    },
  });

  const { data: letters = [] } = useQuery({
    queryKey: ["letters-billing"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("letters")
        .select("id, created_at")
        .gte("created_at", startOfMonth(new Date()).toISOString());
      if (error) throw error;
      return data;
    },
  });

  const recUsage = recordings.length;
  const letUsage = letters.length;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h2 className="font-heading text-2xl font-bold text-foreground">Billing</h2>
        <p className="text-sm text-muted-foreground">Manage your subscription and usage</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Current Plan */}
        <Card className="shadow-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="font-heading text-lg">Current Plan</CardTitle>
              <Badge variant="secondary" className="bg-primary/10 text-primary">Free</Badge>
            </div>
            <CardDescription>Your current subscription details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                {FREE_LIMITS.recordings} recordings / month
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                {FREE_LIMITS.letters} letters / month
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                Medical transcription (MedASR)
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                AI letter generation
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* Usage */}
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="font-heading text-lg">This Month's Usage</CardTitle>
            <CardDescription>Your resource usage for the current billing period</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Recordings</span>
                <span className="font-medium">{recUsage} / {FREE_LIMITS.recordings}</span>
              </div>
              <Progress value={(recUsage / FREE_LIMITS.recordings) * 100} className="h-2" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Letters</span>
                <span className="font-medium">{letUsage} / {FREE_LIMITS.letters}</span>
              </div>
              <Progress value={(letUsage / FREE_LIMITS.letters) * 100} className="h-2" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Upgrade CTA */}
      <Card className="shadow-card border-primary/20 bg-gradient-to-br from-primary/5 to-accent/5">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <CardTitle className="font-heading text-lg">Upgrade to Pro</CardTitle>
          </div>
          <CardDescription>Unlock unlimited access to all features</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            <li className="flex items-center gap-2">
              <Check className="h-4 w-4 text-accent" />
              Unlimited recordings
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-4 w-4 text-accent" />
              Unlimited letters
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-4 w-4 text-accent" />
              Priority transcription
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-4 w-4 text-accent" />
              Custom letter templates
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-4 w-4 text-accent" />
              Team collaboration
            </li>
            <li className="flex items-center gap-2">
              <Check className="h-4 w-4 text-accent" />
              Priority support
            </li>
          </ul>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <span className="text-2xl font-bold">$49</span>
              <span className="text-sm text-muted-foreground"> / month</span>
            </div>
            <Button disabled className="gap-2">
              <CreditCard className="h-4 w-4" />
              Coming Soon
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Billing;
