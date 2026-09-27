/*
 * Hosts that are never blocked, in any mode, because unrelated services need them. Each
 * entry also covers its subdomains. They must not appear in any service's `domains`.
 *
 * - accounts.youtube.com: a step of Google's sign-in flow (accounts.google.com →
 *   CheckCookie → accounts.youtube.com/accounts/SetSID). Blocking it stalls the login to
 *   Google Classroom, Drive and Docs whenever YouTube, the video category or a
 *   punishment is active. It only sets cookies; it serves no videos.
 *
 * The extension allows them with a higher-priority allow rule (its YouTube rule matches
 * subdomains of youtube.com), and whitelist mode allows them on top of the study sites.
 */
export const ALWAYS_ALLOWED_HOST_DATA: readonly string[] = ['accounts.youtube.com'];
