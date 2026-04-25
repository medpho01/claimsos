import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Building2, LogOut, Home, Settings, Menu, X } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';

interface GlobalNavbarProps {
  hospitalName?: string;
  showHospitalContext?: boolean;
}

export const GlobalNavbar: React.FC<GlobalNavbarProps> = ({
  hospitalName,
  showHospitalContext = true,
}) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navigateTo = (path: string) => {
    navigate(path);
    setIsMobileMenuOpen(false);
  };

  const isAdminSection = location.pathname.includes('/superadmin') || location.pathname.includes('/admin');
  const isHospitalPortal = location.pathname.includes('/portal');

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-full mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Left Section: Logo & Branding */}
          <div className="flex items-center gap-3 min-w-0">
            {/* Logo */}
            <button
              onClick={() => {
                if (isAdminSection) {
                  navigate('/superadmin');
                } else if (isHospitalPortal) {
                  navigate('/');
                } else {
                  navigate('/');
                }
              }}
              className="flex items-center gap-2 hover:opacity-80 transition-opacity flex-shrink-0"
            >
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center shadow-md">
                <Building2 className="h-6 w-6 text-white" />
              </div>
              <span className="font-bold text-lg text-gray-900">Finclarity Claim OS</span>
            </button>
          </div>

          {/* Right Section: User Menu & Actions */}
          <div className="flex items-center gap-3 ml-auto">
            {/* User Profile Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 hover:opacity-80 transition-opacity px-2 py-1.5 rounded-lg hover:bg-gray-50">
                  <Avatar className="h-8 w-8 border border-gray-200">
                    <AvatarImage src="" />
                    <AvatarFallback className="bg-gradient-to-br from-blue-50 to-blue-100 text-blue-700 font-semibold text-xs">
                      {user?.first_name?.[0]}{user?.last_name?.[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="hidden sm:flex flex-col items-end min-w-0">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {user?.first_name}
                    </span>
                    <span className="text-xs text-gray-500 capitalize">
                      {user?.role}
                    </span>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="flex flex-col space-y-1">
                    <p className="font-medium text-gray-900">
                      {user?.first_name} {user?.last_name}
                    </p>
                    <p className="text-xs text-gray-500">{user?.email}</p>
                    <p className="text-xs text-gray-500 capitalize">
                      Role: {user?.role}
                    </p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />

                {/* Navigation Items for Mobile/Dropdown */}
                {isAdminSection && (
                  <>
                    <DropdownMenuItem onClick={() => navigateTo('/superadmin')}>
                      <Home className="h-4 w-4 mr-2" />
                      <span>Admin Dashboard</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}

                <DropdownMenuItem onClick={() => navigateTo('/')}>
                  <span>Hospital Directory</span>
                </DropdownMenuItem>

                {user?.role === 'super_admin' && (
                  <DropdownMenuItem onClick={() => navigateTo('/superadmin')}>
                    <Settings className="h-4 w-4 mr-2" />
                    <span>Admin Settings</span>
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />

                <DropdownMenuItem
                  onClick={handleLogout}
                  className="text-red-600 cursor-pointer"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Mobile Menu Trigger */}
            <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
              <SheetTrigger asChild className="md:hidden">
                <Button variant="ghost" size="icon">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 p-6">
                <div className="flex flex-col h-full">
                  {/* Mobile Menu Header */}
                  <div className="mb-8">
                    <div className="flex items-center gap-2">
                      <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center">
                        <Building2 className="h-6 w-6 text-white" />
                      </div>
                      <span className="font-bold text-lg">Finclarity Claim OS</span>
                    </div>
                  </div>

                  {/* Mobile Menu Items */}
                  <div className="flex-1 space-y-3">
                    {isAdminSection && (
                      <button
                        onClick={() => navigateTo('/superadmin')}
                        className="w-full text-left px-4 py-2 rounded-lg hover:bg-gray-100 text-gray-900"
                      >
                        <Home className="h-4 w-4 inline mr-3" />
                        Dashboard
                      </button>
                    )}

                    <button
                      onClick={() => navigateTo('/')}
                      className="w-full text-left px-4 py-2 rounded-lg hover:bg-gray-100 text-gray-900"
                    >
                      Hospital Directory
                    </button>

                    {user?.role === 'super_admin' && (
                      <button
                        onClick={() => navigateTo('/superadmin')}
                        className="w-full text-left px-4 py-2 rounded-lg hover:bg-gray-100 text-gray-900"
                      >
                        <Settings className="h-4 w-4 inline mr-3" />
                        Admin Settings
                      </button>
                    )}
                  </div>

                  {/* Mobile Menu Footer */}
                  <div className="border-t pt-4 space-y-3">
                    <div className="px-4">
                      <p className="text-sm font-medium text-gray-900">
                        {user?.first_name} {user?.last_name}
                      </p>
                      <p className="text-xs text-gray-500">{user?.email}</p>
                    </div>
                    <button
                      onClick={handleLogout}
                      className="w-full text-left px-4 py-2 rounded-lg hover:bg-red-50 text-red-600"
                    >
                      <LogOut className="h-4 w-4 inline mr-3" />
                      Sign out
                    </button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </nav>
  );
};
