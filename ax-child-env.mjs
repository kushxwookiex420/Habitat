const SAFE_ENV_KEYS = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR"
]);

/**
 * Child processes never inherit credentials. Only the keys an interpreter needs to start are passed
 * through; a check's own `env` is filtered for credential-shaped names as well.
 */
export function filteredEnv(extra = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key)) safe[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (!/token|secret|passw|api[_-]?key|authorization|credential|cookie|session/i.test(key)) safe[key] = String(value);
  }
  safe.NO_COLOR = "1";
  return safe;
}
