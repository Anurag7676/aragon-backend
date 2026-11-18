/** Load-test accounts all use this pattern, so they can be found and removed in one go. */
export const LOAD_TEST_EMAIL_DOMAIN = 'loadtest.example';
export const loadTestEmail = (runId: string, index: number) => `loadtest+${runId}-${index}@${LOAD_TEST_EMAIL_DOMAIN}`;
export const LOAD_TEST_EMAIL_PATTERN = `loadtest+%@${LOAD_TEST_EMAIL_DOMAIN}`;
