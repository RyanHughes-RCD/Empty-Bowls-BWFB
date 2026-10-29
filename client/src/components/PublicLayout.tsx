import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';

export interface PublicSettings {
  charity_name: string;
  charity_contact_email: string;
  privacy_notice: string;
  recognition_notice: string;
  submission_confirmation_message: string;
  submissions_enabled: boolean;
  image_uploads_enabled: boolean;
  gallery_title: string;
  gallery_intro: string;
  gallery_show_totals: boolean;
}

export function usePublicSettings() {
  return useApi<PublicSettings>('/api/public/settings');
}

export function PublicLayout({ children, narrow, title, settings }: { children: ReactNode; narrow?: boolean; title: string; settings?: PublicSettings | null }) {
  useEffect(() => {
    document.title = `${title} · ${settings?.charity_name ?? 'Charity Auction'}`;
  }, [title, settings]);
  // Supports embedding (e.g. in an iframe on the charity website) with ?embed=1
  const embed = new URLSearchParams(window.location.search).get('embed') === '1';
  return (
    <div className="public">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      {!embed && (
        <header className="public-header">
          <div className="inner">
            <Link to="/gallery" className="brand">
              <span aria-hidden="true">🥣</span> {settings?.charity_name ?? 'Charity Auction'}
            </Link>
            <nav aria-label="Public">
              <Link to="/gallery">Auction Donations</Link>
              <Link to="/submit">Donate an item</Link>
              <Link to="/login">Staff sign in</Link>
            </nav>
          </div>
        </header>
      )}
      <main id="main" className={`public-main ${narrow ? 'narrow' : ''}`}>
        {children}
      </main>
      {!embed && (
        <footer className="public-footer">
          © {new Date().getFullYear()} {settings?.charity_name}
          {settings?.charity_contact_email && (
            <>
              {' '}
              · Questions? <a href={`mailto:${settings.charity_contact_email}`}>{settings.charity_contact_email}</a>
            </>
          )}
        </footer>
      )}
    </div>
  );
}
