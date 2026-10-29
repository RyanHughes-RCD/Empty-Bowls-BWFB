import { useApi } from './useApi';

export interface EventRow {
  id: number;
  code: string;
  name: string;
  event_date: string | null;
  description: string | null;
  location: string | null;
  status: string;
  accepting_submissions: boolean;
  gallery_enabled: boolean;
  donation_count?: number | null;
  approved_value?: number | null;
  pending_submissions?: number | null;
}
export interface UserOption {
  id: number;
  name: string;
  role: string;
}
export interface StatusRow {
  code: string;
  label: string;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  publishable: boolean;
  counts_as_approved: boolean;
}

export const useEvents = () => useApi<EventRow[]>('/api/events');
export const useUserOptions = () => useApi<UserOption[]>('/api/users/options');
export const useStatuses = () => useApi<StatusRow[]>('/api/donations/statuses');

const KEY = 'eb.currentEvent';
export function getStoredEvent(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}
export function storeEvent(id: number | null) {
  try {
    if (id) localStorage.setItem(KEY, String(id));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
