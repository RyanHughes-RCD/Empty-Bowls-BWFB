import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  perms?: string[];
  end?: boolean;
}

const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Dashboard',
    items: [
      { to: '/app', label: 'Overview', end: true },
      { to: '/app/tasks', label: 'My To Do List' },
    ],
  },
  {
    title: 'Donations',
    items: [
      { to: '/app/donations', label: 'All Donations', end: true },
      { to: '/app/approvals', label: 'Donation Approvals', perms: ['submissions.review'] },
      { to: '/app/approvals?mine=true', label: 'My Submissions', perms: ['submissions.create'] },
      { to: '/app/donations?preset=published', label: 'Published Donations' },
      { to: '/app/follow-ups', label: 'Follow-Ups', perms: ['tasks.view_all'] },
      { to: '/app/donations?preset=pickup', label: 'Pickup Tracking' },
      { to: '/app/donations?preset=thankyou', label: 'Thank-You Tracking' },
    ],
  },
  { title: 'Donors', items: [{ to: '/app/donors', label: 'Donor Directory', end: true }, { to: '/app/donors/duplicates', label: 'Duplicate Donors', perms: ['donors.merge'] }] },
  { title: 'Events', items: [{ to: '/app/events', label: 'Event Management' }] },
  {
    title: 'Reports',
    items: [
      { to: '/app/reports', label: 'Event Reports', perms: ['reports.view'] },
      { to: '/app/exports', label: 'Donation Exports', perms: ['exports.run'] },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/app/users', label: 'Users and Permissions', perms: ['users.manage', 'users.manage_all'] },
      { to: '/app/audit', label: 'Audit Log', perms: ['audit.view'] },
      { to: '/app/settings', label: 'Settings', perms: ['settings.manage'] },
    ],
  },
];

interface Notification {
  id: number;
  message: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export function AppLayout() {
  const { user, canAny, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<{ unread: number; rows: Notification[] }>({ unread: 0, rows: [] });
  const location = useLocation();
  const navigate = useNavigate();

  const loadNotifs = () => api.get<typeof notifs>('/api/notifications').then(setNotifs).catch(() => undefined);
  useEffect(() => {
    loadNotifs();
    const t = setInterval(loadNotifs, 60000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setMenuOpen(false);
    setNotifOpen(false);
  }, [location.pathname, location.search]);

  const isActive = (item: NavItem) => {
    const [path, query] = item.to.split('?');
    if (query) return location.pathname === path && location.search === `?${query}`;
    if (item.end) return location.pathname === path && (!location.search || !NAV.some((g) => g.items.some((i) => i.to.startsWith(`${path}?`) && `?${i.to.split('?')[1]}` === location.search)));
    return location.pathname.startsWith(path);
  };

  const openNotif = async (n: Notification) => {
    await api.post(`/api/notifications/${n.id}/read`).catch(() => undefined);
    loadNotifs();
    if (n.link) navigate(n.link);
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Main navigation">
        <Link to="/app" className="brand">
          <span aria-hidden="true">🥣</span> Empty Bowls
        </Link>
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.perms || canAny(...i.perms));
          if (!items.length) return null;
          return (
            <nav className="nav-group" key={group.title} aria-label={group.title}>
              <h2>{group.title}</h2>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} className={() => (isActive(i) ? 'active' : '')} end={i.end}>
                  {i.label}
                </NavLink>
              ))}
            </nav>
          );
        })}
        <nav className="nav-group" aria-label="Public pages">
          <h2>Public pages</h2>
          <a href="/gallery" target="_blank" rel="noreferrer">
            Donation Gallery ↗
          </a>
          <a href="/submit" target="_blank" rel="noreferrer">
            Donation Form ↗
          </a>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-secondary btn-sm menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
            ☰ Menu
          </button>
          <div />
          <div className="user">
            <button className="btn btn-secondary btn-sm" onClick={() => setNotifOpen((o) => !o)} aria-expanded={notifOpen} aria-label={`Notifications, ${notifs.unread} unread`}>
              🔔 {notifs.unread > 0 && <span className="nav-count">{notifs.unread}</span>}
            </button>
            <span className="small">
              <strong>{user?.name}</strong> <span className="muted">· {user?.roleLabel}</span>
            </span>
            <Link to="/change-password" className="small">
              Change password
            </Link>
            <button className="btn btn-secondary btn-sm" onClick={() => logout().then(() => navigate('/login'))}>
              Sign out
            </button>
          </div>
          {notifOpen && (
            <div className="notif-panel" role="region" aria-label="Notifications">
              <div className="row between" style={{ padding: '0.6rem 0.9rem' }}>
                <strong>Notifications</strong>
                <button className="btn-link small" onClick={() => api.post('/api/notifications/read-all').then(loadNotifs)}>
                  Mark all read
                </button>
              </div>
              {notifs.rows.length === 0 ? (
                <p className="muted" style={{ padding: '0 0.9rem' }}>
                  No notifications yet.
                </p>
              ) : (
                <ul>
                  {notifs.rows.map((n) => (
                    <li key={n.id} className={n.read_at ? '' : 'unread'}>
                      <button className="btn-link" style={{ textAlign: 'left', textDecoration: 'none', color: 'inherit' }} onClick={() => openNotif(n)}>
                        {n.message}
                      </button>
                      <div className="muted small">{dateTime(n.created_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
