import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import ApprovalDetail from './pages/ApprovalDetail';
import Approvals from './pages/Approvals';
import AuditLog from './pages/AuditLog';
import ChangePassword from './pages/ChangePassword';
import Dashboard from './pages/Dashboard';
import DonationDetail from './pages/DonationDetail';
import DonationForm from './pages/DonationForm';
import Donations from './pages/Donations';
import DonorDetail from './pages/DonorDetail';
import Donors from './pages/Donors';
import Duplicates from './pages/Duplicates';
import Events from './pages/Events';
import Exports from './pages/Exports';
import Gallery from './pages/public/Gallery';
import Login from './pages/Login';
import MoreInfo from './pages/public/MoreInfo';
import NotFound from './pages/NotFound';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Submit from './pages/public/Submit';
import Tasks from './pages/Tasks';
import Users from './pages/Users';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** UI-level gate only; every API call is also authorized on the server. */
function Gate({ perms, children }: { perms: string[]; children: ReactNode }) {
  const { canAny } = useAuth();
  if (!canAny(...perms)) return <NotFound forbidden />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/gallery" replace />} />
      <Route path="/gallery" element={<Gallery />} />
      <Route path="/submit" element={<Submit />} />
      <Route path="/submit/more-info/:token" element={<MoreInfo />} />
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="tasks" element={<Tasks scope="mine" />} />
        <Route path="follow-ups" element={<Gate perms={['tasks.view_all']}><Tasks scope="all" /></Gate>} />
        <Route path="donations" element={<Donations />} />
        <Route path="donations/new" element={<Gate perms={['donations.create', 'submissions.create']}><DonationForm /></Gate>} />
        <Route path="donations/:id" element={<DonationDetail />} />
        <Route path="approvals" element={<Gate perms={['submissions.review', 'submissions.create']}><Approvals /></Gate>} />
        <Route path="approvals/:id" element={<Gate perms={['submissions.review', 'submissions.create']}><ApprovalDetail /></Gate>} />
        <Route path="donors" element={<Donors />} />
        <Route path="donors/duplicates" element={<Gate perms={['donors.merge']}><Duplicates /></Gate>} />
        <Route path="donors/:id" element={<DonorDetail />} />
        <Route path="events" element={<Events />} />
        <Route path="reports" element={<Gate perms={['reports.view']}><Reports /></Gate>} />
        <Route path="exports" element={<Gate perms={['exports.run']}><Exports /></Gate>} />
        <Route path="users" element={<Gate perms={['users.manage', 'users.manage_all']}><Users /></Gate>} />
        <Route path="audit" element={<Gate perms={['audit.view']}><AuditLog /></Gate>} />
        <Route path="settings" element={<Gate perms={['settings.manage']}><Settings /></Gate>} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
