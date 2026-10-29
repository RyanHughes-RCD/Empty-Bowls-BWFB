import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PublicLayout, usePublicSettings } from '../../components/PublicLayout';
import { EmptyState, ErrorAlert, Spinner } from '../../components/ui';
import { CATEGORIES, CATEGORY_LABELS, SUBCATEGORIES, SUBCATEGORY_LABELS, money } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { qs } from '../../lib/api';

interface GalleryItem {
  id: number;
  event_name: string;
  category: string;
  subcategory: string | null;
  title: string | null;
  description: string;
  quantity: number | null;
  estimated_value_cad: number | null;
  donor_name: string | null;
  donor_website: string | null;
  images: { id: string; alt: string | null }[];
}
interface GalleryResponse {
  summary: { count: number; disclosed_value: number; donor_count: number };
  donations: GalleryItem[];
  page: number;
  pageSize: number;
}

const ICONS: Record<string, string> = { bowls: '🥣', food: '🍲', auction: '🏷️', door_prize: '🎁', other: '✨' };

export default function Gallery() {
  const [params, setParams] = useSearchParams();
  const { data: settings } = usePublicSettings();
  const { data: events } = useApi<{ id: number; code: string; name: string; gallery_enabled: boolean }[]>('/api/public/events');
  const galleryEvents = (events ?? []).filter((e) => e.gallery_enabled);
  const event = params.get('event') ?? '';
  const category = params.get('category') ?? '';
  const subcategory = params.get('subcategory') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const url = `/api/public/gallery${qs({ event, category, subcategory: category === 'food' ? subcategory : '', q: debouncedQ, page_size: 100 })}`;
  const { data, error, loading } = useApi<GalleryResponse>(url);

  const update = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'category') next.delete('subcategory');
    setParams(next, { replace: true });
  };

  const grouped = useMemo(() => {
    const g: Record<string, GalleryItem[]> = {};
    for (const d of data?.donations ?? []) (g[d.category] ??= []).push(d);
    return CATEGORIES.filter((c) => g[c]?.length).map((c) => ({ category: c, items: g[c] }));
  }, [data]);

  return (
    <PublicLayout title={settings?.gallery_title ?? 'Auction Donations'} settings={settings}>
      <section className="hero">
        <h1>{settings?.gallery_title ?? 'Our Generous Donors'}</h1>
        <p>{settings?.gallery_intro}</p>
        {settings?.gallery_show_totals && data && data.summary.count > 0 && (
          <div className="hero-stats" aria-label="Summary">
            <div>
              <strong>{data.summary.count}</strong> donations
            </div>
            {data.summary.disclosed_value > 0 && (
              <div>
                <strong>{money(data.summary.disclosed_value)}</strong> in estimated value
              </div>
            )}
          </div>
        )}
        <p style={{ marginTop: '1rem' }}>
          <Link to={`/submit${event ? `?event=${event}` : ''}`} className="btn btn-secondary">
            Donate an item
          </Link>
        </p>
      </section>

      <div className="stack">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor="gallery-search">Search donations</label>
            <input id="gallery-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by item or donor" />
          </div>
          {galleryEvents.length > 1 && (
            <div className="field" style={{ flex: '0 1 260px' }}>
              <label htmlFor="gallery-event">Event</label>
              <select id="gallery-event" value={event} onChange={(e) => update('event', e.target.value)}>
                <option value="">All events</option>
                {galleryEvents.map((e) => (
                  <option key={e.id} value={e.code}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="chips" role="group" aria-label="Filter by category">
          <button className="chip" aria-pressed={!category} onClick={() => update('category', '')}>
            All
          </button>
          {CATEGORIES.map((c) => (
            <button key={c} className="chip" aria-pressed={category === c} onClick={() => update('category', c)}>
              {ICONS[c]} {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
        {category === 'food' && (
          <div className="chips" role="group" aria-label="Filter food by type">
            <button className="chip" aria-pressed={!subcategory} onClick={() => update('subcategory', '')}>
              All food
            </button>
            {SUBCATEGORIES.map((s) => (
              <button key={s} className="chip" aria-pressed={subcategory === s} onClick={() => update('subcategory', s)}>
                {SUBCATEGORY_LABELS[s]}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <ErrorAlert error={error} />}
      {loading && !data ? (
        <Spinner />
      ) : grouped.length === 0 ? (
        <EmptyState title={q || category ? 'No donations match your search' : 'Donations are on their way!'}>
          {q || category ? 'Try a different search or category.' : 'Our team is reviewing donations now. Check back soon to see what will be up for auction.'}
        </EmptyState>
      ) : (
        grouped.map((g) => (
          <section key={g.category} className="category-section" aria-labelledby={`cat-${g.category}`}>
            <h2 id={`cat-${g.category}`}>
              <span aria-hidden="true">{ICONS[g.category]}</span> {CATEGORY_LABELS[g.category]} <span className="muted small">({g.items.length})</span>
            </h2>
            <div className="gallery">
              {g.items.map((d) => (
                <article key={d.id} className="gcard">
                  <div className="gcard-img">
                    {d.images[0] ? <img src={`/api/public/media/${d.images[0].id}`} alt={d.images[0].alt ?? ''} loading="lazy" /> : <span aria-hidden="true">{ICONS[d.category]}</span>}
                  </div>
                  <div className="gcard-body">
                    <h3>{d.title || CATEGORY_LABELS[d.category]}</h3>
                    <div className="gcard-meta">
                      <span className="badge badge-neutral">{CATEGORY_LABELS[d.category]}</span>
                      {d.subcategory && <span className="badge badge-amber">{SUBCATEGORY_LABELS[d.subcategory]}</span>}
                      {d.quantity && d.quantity > 1 && <span className="badge badge-blue">Qty {d.quantity}</span>}
                      {d.estimated_value_cad !== null && <span className="badge badge-green">Value {money(d.estimated_value_cad)}</span>}
                    </div>
                    <p>{d.description}</p>
                    {galleryEvents.length > 1 && !event && <p className="muted small">{d.event_name}</p>}
                    {d.donor_name && (
                      <div className="gcard-donor">
                        Donated by{' '}
                        {d.donor_website ? (
                          <a href={d.donor_website} target="_blank" rel="noopener noreferrer nofollow">
                            {d.donor_name}
                          </a>
                        ) : (
                          d.donor_name
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))
      )}
    </PublicLayout>
  );
}
