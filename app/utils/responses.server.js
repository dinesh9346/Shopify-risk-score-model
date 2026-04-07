/**
 * Creates a JSON response for route handlers
 * @param {*} data - The data to serialize as JSON
 * @param {Object} init - Response initialization options (status, headers, etc.)
 * @returns {Response} A Response object with JSON content type
 */
export function json(data, init = {}) {
  const status = init?.status || 200;
  const headers = new Headers(init?.headers);
  
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}
