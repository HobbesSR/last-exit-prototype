/**
 * Binds an arena server to an ephemeral loopback port and returns its base URL.
 *
 * Callers own creating and closing the server.
 */
export async function listen(server) {
  await new Promise(resolve => server.http.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.http.address().port}`;
}
