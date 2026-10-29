import { Link } from 'react-router-dom';
import { EmptyState, ErrorAlert, PageHeader, Spinner } from '../components/ui';
import { useApi } from '../lib/useApi';

export default function Duplicates() {
  const { data, error, loading } = useApi<{ a: { id: number; name: string }; b: { id: number; name: string }; reasons: string[] }[]>('/api/donors/duplicates');
  return (
    <div className="stack">
      <PageHeader title="Duplicate Donors" subtitle="Donor records that share an email address, phone number or name. Open one to review and merge safely." />
      <ErrorAlert error={error} />
      {loading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState title="No likely duplicates found" icon="✨" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Donor A</th>
                <th>Donor B</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={`${p.a.id}-${p.b.id}`}>
                  <td>
                    <Link to={`/app/donors/${p.a.id}`}>
                      {p.a.name} (#{p.a.id})
                    </Link>
                  </td>
                  <td>
                    <Link to={`/app/donors/${p.b.id}`}>
                      {p.b.name} (#{p.b.id})
                    </Link>
                  </td>
                  <td>{p.reasons.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
