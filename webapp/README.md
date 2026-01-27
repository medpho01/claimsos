# Project Structure

The following directory structure has been implemented for the webapp:

```
src/
├── assets/          # Static assets (images, icons)
├── components/      # Shared components
│   ├── ui/          # Shadcn UI primitives (Button, Dialog, etc.)
│   ├── common/      # App-wide shared components (Skeleton, Loading, etc.)
│   ├── modals/      # All global or shared modals (AddHospital, Patient, etc.)
│   └── layout/      # Layout components (Sidebar, Navbar)
├── features/        # Feature-specific components
│   ├── dashboard/   # Dashboard widgets (DashboardOverview)
│   └── panels/      # Panel management (MasterPanelManagement)
├── pages/           # Route components
│   ├── auth/        # Login, Signup
│   ├── admin/       # Admin dashboard & related pages
│   ├── superadmin/  # Superadmin dashboard & hospital management
│   └── panels/      # Panel-specific pages
├── context/         # React Context providers
├── hooks/           # Custom hooks
├── services/        # API and external services
├── types/           # TypeScript definitions
└── utils/           # Helper functions
```
