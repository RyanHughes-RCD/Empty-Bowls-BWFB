/**
 * Role-based access control.
 *
 * Each role has a default permission set. Super Admins may grant or revoke
 * individual permissions per user (user_permissions table). All checks are
 * enforced on the server in route handlers and the service layer.
 */
export const ROLES = ['super_admin', 'admin', 'owner', 'volunteer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  owner: 'Record Owner',
  volunteer: 'Volunteer',
};

export const PERMISSIONS = {
  'donors.view_all': 'View all donor records and contact information',
  'donors.create': 'Create donor records',
  'donors.edit': 'Edit any donor record',
  'donors.merge': 'Review and merge duplicate donors',
  'donors.delete': 'Archive or permanently delete donor records',
  'donations.view_all': 'View all donations',
  'donations.create': 'Add donations directly (no approval step)',
  'donations.edit_all': 'Edit any donation',
  'donations.edit_assigned': 'Edit permitted fields on assigned/shared donations',
  'donations.assign': 'Assign and share donations with users',
  'donations.receive': 'Record items as received',
  'donations.thank_you': 'Prepare and record thank-you messages',
  'donations.archive': 'Archive and restore donations',
  'contacts.view_assigned': 'See donor contact and pickup details on assigned/shared records',
  'notes.view_all': 'Read internal notes on all donations',
  'notes.assigned': 'Read and add notes on assigned/shared donations',
  'submissions.create': 'Submit donations on behalf of donors (goes to approval)',
  'submissions.review': 'Review, approve, decline and request info on submissions',
  'publication.manage': 'Publish and unpublish donations on the public gallery',
  'events.manage': 'Create and manage auction events',
  'tasks.view_all': 'View all users’ follow-up tasks',
  'tasks.manage': 'Create, reassign and manage tasks for any user',
  'reports.view': 'View dashboards and event reports',
  'exports.run': 'Export records to CSV',
  'users.manage': 'Add and manage Record Owner and Volunteer accounts',
  'users.manage_all': 'Manage all users, roles and permissions',
  'audit.view': 'View the activity / audit log',
  'settings.manage': 'Configure application settings and statuses',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  super_admin: ALL_PERMISSIONS,
  admin: [
    'donors.view_all',
    'donors.create',
    'donors.edit',
    'donors.merge',
    'donations.view_all',
    'donations.create',
    'donations.edit_all',
    'donations.edit_assigned',
    'donations.assign',
    'donations.receive',
    'donations.thank_you',
    'contacts.view_assigned',
    'notes.view_all',
    'notes.assigned',
    'submissions.create',
    'submissions.review',
    'events.manage',
    'tasks.view_all',
    'tasks.manage',
    'reports.view',
    'exports.run',
    'users.manage',
    // 'publication.manage' is deliberately NOT a default for Admins: a Super
    // Admin grants it ("publish and unpublish donations if granted permission").
  ],
  owner: [
    'donations.edit_assigned',
    'donations.receive',
    'donations.thank_you',
    'contacts.view_assigned',
    'notes.assigned',
    'submissions.create',
  ],
  volunteer: ['donations.edit_assigned', 'notes.assigned'],
};

/** Permissions that may never be granted to non-admin roles. */
const ADMIN_ONLY: Permission[] = ['users.manage_all', 'settings.manage', 'audit.view', 'donors.delete'];

export function canGrant(role: Role, permission: Permission): boolean {
  if (role === 'super_admin') return true;
  if (ADMIN_ONLY.includes(permission)) return false;
  if (permission === 'users.manage' && role !== 'admin') return false;
  return true;
}

export function effectivePermissions(role: Role, overrides: { permission: string; granted: boolean }[]): Set<Permission> {
  const set = new Set<Permission>(ROLE_DEFAULTS[role]);
  if (role === 'super_admin') return set; // super admin can never be reduced
  for (const o of overrides) {
    if (!(o.permission in PERMISSIONS)) continue;
    const p = o.permission as Permission;
    if (o.granted && canGrant(role, p)) set.add(p);
    if (!o.granted) set.delete(p);
  }
  return set;
}

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  permissions: Set<Permission>;
  mustChangePassword: boolean;
}

export function can(user: AuthUser | undefined | null, permission: Permission): boolean {
  return Boolean(user && user.permissions.has(permission));
}
