// Timestamped logging to stdout. log.once(key, msg) prints a message only the first time.
export function createLog({ debug = false, out = console.log } = {}) {
  const seen = new Set();
  const line = (...a) => out(new Date().toISOString(), ...a);
  return {
    info: line,
    debug: (...a) => { if (debug) line('[debug]', ...a); },
    once: (key, ...a) => { if (!seen.has(key)) { seen.add(key); line(...a); } },
  };
}
