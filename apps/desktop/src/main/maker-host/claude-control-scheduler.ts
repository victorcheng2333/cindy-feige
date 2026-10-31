/** Bound background CLI reads; interactive login and task execution never wait here. */
function queue(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < limit) running++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try { return await task(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

export const runClaudeControlRead = queue(2);
// A model probe first checks login status. Separate slots avoid nested-queue deadlock.
export const runClaudeModelProbe = queue(1);
