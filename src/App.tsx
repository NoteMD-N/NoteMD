import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppLayout from "@/components/AppLayout";
import Auth from "./pages/Auth";
import Landing from "./pages/Landing";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import Record from "./pages/Record";
import LetterView from "./pages/LetterView";
import Recordings from "./pages/Recordings";
import Letters from "./pages/Letters";
import Settings from "./pages/Settings";
import Templates from "./pages/Templates";
import Billing from "./pages/Billing";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const AuthRedirect = () => {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/dashboard" replace />;
  return <Auth />;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<AuthRedirect />} />
            {/* Reached from the emailed recovery link; deliberately public. */}
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/recordings" element={<Recordings />} />
              <Route path="/letters" element={<Letters />} />
              <Route path="/record" element={<Record />} />
              {/* No :id — the letter identifier travels in the URL fragment,
                  which browsers never send to the server. See lib/letter-route.ts */}
              <Route path="/letter" element={<LetterView />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/billing" element={<Billing />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
