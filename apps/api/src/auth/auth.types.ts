export type AuthPrincipal = {
  userId: string;
  username: string;
  role: 'user' | 'admin';
  sessionId: string;
  csrfSecret: string;
};

export const SESSION_COOKIE = 'csb_kb_session';
export const CSRF_COOKIE = 'csb_kb_csrf';
