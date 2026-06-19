/**
 * Authenticated fetch wrapper that handles 401 responses globally.
 * On 401, clears the auth token from localStorage and redirects to /login.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const token = localStorage.getItem('vps_token');

  const headers = new Headers(init?.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(input, { ...init, headers });

  if (response.status === 401) {
    // Token is expired or invalid — clear state and redirect to login
    localStorage.removeItem('vps_token');
    // Only redirect if we're not already on the login page
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }

  return response;
}
