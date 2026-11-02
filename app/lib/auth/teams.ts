// The fixed Team list for user accounts (Add/Edit user dropdown on User
// Management; the /api/admin/users routes accept only these, or no team).
export const TEAMS = ['Settlement Team', 'SL Team', 'SCT Team', 'Account Team', 'QA Team', 'ESS Team', 'Report Team'] as const;

export function isKnownTeam(value: string): boolean {
  return (TEAMS as readonly string[]).includes(value);
}
