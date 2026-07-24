export type AuthPrincipal = {
  userId: string;
  username: string;
  role: 'user' | 'admin';
  sessionId: string;
  csrfSecret: string;
};

export const SESSION_COOKIE = 'pi_rag_session';
export const CSRF_COOKIE = 'pi_rag_csrf';
