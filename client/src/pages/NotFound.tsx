import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export default function NotFound({ forbidden }: { forbidden?: boolean }) {
  return (
    <div className="content">
      <EmptyState title={forbidden ? 'You do not have access to this page' : 'Page not found'} icon={forbidden ? '🔒' : '🔍'}>
        <p>{forbidden ? 'Ask an administrator if you need access.' : 'The page you were looking for does not exist.'}</p>
        <Link to="/app">Go to the dashboard</Link>
      </EmptyState>
    </div>
  );
}
