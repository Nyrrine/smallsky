/* Minimal concurrency limiter — caps in-flight async tasks.
 * Use for fan-out API calls to avoid hammering BigSky + browser fetch queue. */

export function makeLimiter(max = 6) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(v => { active--; resolve(v); next(); },
            e => { active--; reject(e); next(); });
  };
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}
