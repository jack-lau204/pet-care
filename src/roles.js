export const ROLES = Object.freeze(['customer', 'staff', 'admin']);

export function hasStaffAccess(role) {
  return role === 'staff' || role === 'admin';
}

export function hasAdminAccess(role) {
  return role === 'admin';
}
