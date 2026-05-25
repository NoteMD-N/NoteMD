import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Identify the calling clinician
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action, email, secretary_user_id } = body;
    if (!action) throw new Error("action is required");

    // Service-role client for admin lookups + cross-user profile updates
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (action === "add") {
      if (!email) throw new Error("email is required");

      // Find the user by email
      const { data: list, error: listErr } = await admin.auth.admin.listUsers();
      if (listErr) throw listErr;

      const target = list.users.find(
        (u) => u.email?.toLowerCase() === String(email).toLowerCase()
      );
      if (!target) {
        throw new Error(
          "No NoteMD account found with that email. Ask them to sign up first, then add them."
        );
      }
      if (target.id === user.id) {
        throw new Error("You cannot add yourself as a secretary.");
      }

      // Link the secretary to this clinician
      const { error: updErr } = await admin
        .from("profiles")
        .update({ clinician_id: user.id, role: "secretary" })
        .eq("user_id", target.id);
      if (updErr) throw updErr;

      return new Response(
        JSON.stringify({ success: true, secretary_email: target.email }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "remove") {
      if (!secretary_user_id) throw new Error("secretary_user_id is required");

      // Only unlink if this secretary actually belongs to the calling clinician
      const { data: prof } = await admin
        .from("profiles")
        .select("clinician_id")
        .eq("user_id", secretary_user_id)
        .single();
      if (!prof || prof.clinician_id !== user.id) {
        throw new Error("That user is not your secretary.");
      }

      const { error: updErr } = await admin
        .from("profiles")
        .update({ clinician_id: null, role: "clinician" })
        .eq("user_id", secretary_user_id);
      if (updErr) throw updErr;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Unknown action");
  } catch (error) {
    console.error("manage-secretary error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
