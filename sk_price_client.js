import { Worker } from 'node:worker_threads';
import path from 'node:path';

export async function initSkPriceClient(filename, { timeoutMs = 85000 } = {}) {
  const worker = new Worker(new URL('./sk_price_worker.js', import.meta.url), {
    workerData: { filename: path.resolve(filename) },
  });
  const pending = new Map();
  let ready = false, nextId = 0;
  let resolveReady, rejectReady;
  const startup = new Promise((resolve, reject) => { resolveReady=resolve; rejectReady=reject; });
  function fail(error) {
    ready = false;
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  worker.on('error', fail);
  worker.on('exit', code => fail(Error('SK price worker stopped ('+code+')')));
  worker.on('message', message => {
    if (message.startupError) { fail(Error(message.startupError)); return; }
    if (message.ready) { ready=true; resolveReady(); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(Error(message.error));
    else request.resolve(message.result);
  });
  await startup;
  function call(method, args) {
    if (!ready) return Promise.reject(Error('SK price worker is unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = Error('SK price query timed out');
        error.code = 'price_query_timeout';
        reject(error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, method, args }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  return {
    get ready() { return ready; },
    health: () => call('health', []),
    estimatePrice: input => call('estimatePrice', [input]),
    findComps: (input, limit) => call('findComps', [input, limit]),
    close: async () => { ready=false; await worker.terminate(); },
  };
}
