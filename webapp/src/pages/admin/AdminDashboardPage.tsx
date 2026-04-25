import React, { useState, useEffect } from "react";
import { data, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { GlobalNavbar } from "@/components/Navbar";
import apiService from "../../services/api";
import { Hospital } from "../../types";

// Shadcn UI Imports (Adjust paths based on your project structure)
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Lucide Icons (Standard with Shadcn)
import {
  LayoutDashboard,
  LogOut,
  Phone,
  ChevronRight,
  Building2,
  AlertCircle
} from "lucide-react";

const AdminDashboardPage: React.FC = () => {
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [loading, setLoading] = useState(true);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchHospitals = async () => {
      if (!user?.id) return;
      try {
        setLoading(true);
        const response = await apiService.getAdminHospitals(user.id);
        setHospitals(response.data.data.map((elem : any)=>{
          return {
            "id":elem.hospital_id,
            "admin_id":elem.admin_id,
            "name":elem.name,
            "city":elem.city
          };
        }));
      } catch (err) {
        console.error("Failed to load hospitals", err);
      } finally {
        setLoading(false);
      }
    };
    fetchHospitals();
  }, [user]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const getInitials = (firstName?: string, lastName?: string) => {
    const first = firstName?.charAt(0) || "";
    const last = lastName?.charAt(0) || "";
    return `${first}${last}`.toUpperCase();
  };

  return (
    <>
      <GlobalNavbar showHospitalContext={false} />
      <div className="flex h-[calc(100vh-64px)] bg-background w-full">
        {/* Sidebar */}
      <aside className="hidden w-64 flex-col border-r bg-muted/10 md:flex">
        <div className="flex h-14 items-center border-b px-4 lg:h-[60px] lg:px-6">
          <a href="/" className="flex items-center gap-2 font-semibold">
            <Building2 className="h-6 w-6" />
            <span className="">Admin Panel</span>
          </a>
        </div>
        
        <div className="flex-1">
          <nav className="grid items-start px-2 text-sm font-medium lg:px-4 mt-4">
            <div className="px-3 py-2 text-muted-foreground text-xs uppercase tracking-wider">
              Overview
            </div>
            <Button 
              variant="secondary" 
              className="w-full justify-start gap-3 mb-1"
            >
              <LayoutDashboard className="h-4 w-4" />
              My Hospitals
              <span className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                {hospitals.length}
              </span>
            </Button>
          </nav>
        </div>

        <div className="mt-auto border-t p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 overflow-hidden">
              <Avatar className="h-9 w-9 border">
                <AvatarFallback>{getInitials(user?.first_name, user?.last_name)}</AvatarFallback>
              </Avatar>
              <div className="grid gap-0.5 text-xs">
                <span className="font-medium truncate">
                  {user?.first_name} {user?.last_name}
                </span>
                <span className="text-muted-foreground">Admin</span>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={handleLogout} title="Logout">
              <LogOut className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <header className="flex h-14 items-center gap-4 border-b bg-muted/40 px-6 lg:h-[60px] md:hidden">
          <span className="font-semibold">My Hospitals</span>
          {/* Add Mobile Sidebar Trigger here if needed */}
        </header>

        <main className="flex-1 overflow-auto p-4 md:p-6 lg:p-8 bg-slate-50/50 dark:bg-background">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
              <p className="text-muted-foreground">Manage your assigned hospitals</p>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex flex-col space-y-3">
                  <Skeleton className="h-[200px] w-full rounded-xl" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-[250px]" />
                    <Skeleton className="h-4 w-[200px]" />
                  </div>
                </div>
              ))}
            </div>
          ) : hospitals.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[400px] text-center border-2 border-dashed rounded-lg bg-muted/10">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
                <AlertCircle className="h-10 w-10 text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">No hospitals assigned</h3>
              <p className="mb-4 text-sm text-muted-foreground max-w-sm">
                Contact the superadmin to get hospitals assigned to your account.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {hospitals.map((hospital) => (
                <Card 
                  key={hospital.id} 
                  className="group hover:shadow-lg transition-all duration-200 cursor-pointer hover:-translate-y-1 border-slate-200 dark:border-slate-800"
                  onClick={() => navigate(`/hospital/${hospital.id}`)}
                >
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <Avatar className="h-12 w-12 border-2 border-primary/10">
                      <AvatarFallback className="bg-primary/5 text-primary font-bold">
                        {getInitials(hospital.name)}
                      </AvatarFallback>
                    </Avatar>
                  </CardHeader>
                  
                  <CardContent className="pt-4">
                    <h3 className="font-semibold text-lg leading-none truncate mb-1">
                      {hospital.name}
                    </h3>
                  </CardContent>
                  
                  <CardFooter className="pt-2 flex items-center justify-between border-t bg-muted/5 p-4">
                    <div className="flex items-center text-sm text-muted-foreground">
                      {hospital.city || "No city"}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </main>
      </div>
      </div>
    </>
  );
};

export default AdminDashboardPage;