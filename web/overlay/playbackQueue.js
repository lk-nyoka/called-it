export function createPlaybackQueue(show, durations = { "called-it": 5_000, "hall-of-cap": 3_000 }) {
  const pending = [];
  let current;
  let timer;

  function advance() {
    if (current || !pending.length) return;
    current = pending.shift();
    show(current);
    const duration = durations[current.type];
    if (duration) timer = setTimeout(() => finish(), duration);
  }

  function enqueue(event) {
    pending.push(event);
    advance();
  }

  function finish(type, callId) {
    if (!current || (type && current.type !== type) || (callId !== undefined && current.callId !== callId)) {
      const index = pending.findIndex((item) => (!type || item.type === type) && (callId === undefined || item.callId === callId));
      if (index < 0) return false;
      pending.splice(index, 1);
      return true;
    }
    clearTimeout(timer);
    timer = undefined;
    current = undefined;
    show(null);
    advance();
    return true;
  }

  function update(event) {
    if (current?.type === event.type && current.callId === event.callId) {
      current = { ...current, ...event };
      return true;
    }
    const queued = pending.find((item) => item.type === event.type && item.callId === event.callId);
    if (queued) Object.assign(queued, event);
    return Boolean(queued);
  }

  return { enqueue, finish, update, get current() { return current; }, get pending() { return [...pending]; } };
}
