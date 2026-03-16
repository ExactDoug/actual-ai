// Patch globalThis.fetch to work around undici SocketError on keep-alive connections.
// The Actual Budget server sometimes closes the keep-alive socket between requests,
// causing undici's connection pool to fail with "other side closed" on the next POST.
// This wrapper retries once on SocketError.
const origFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(url, opts) {
  try {
    return await origFetch(url, opts);
  } catch (err) {
    const cause = err?.cause;
    if (cause && cause.code === 'UND_ERR_SOCKET') {
      // Retry once — undici will open a fresh connection
      return origFetch(url, opts);
    }
    throw err;
  }
};
