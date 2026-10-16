import { parentPort, workerData } from 'node:worker_threads';
import { initVehicleDb } from './price_db.js';

try {
  const db = initVehicleDb(workerData.filename, { market: 'SK' });
  parentPort.on('message', ({ id, method, args }) => {
    try {
      if (!['health','estimatePrice','findComps'].includes(method)) throw Error('Invalid price worker method');
      parentPort.postMessage({ id, result: db[method](...args) });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
  parentPort.postMessage({ ready: true });
} catch (error) {
  parentPort.postMessage({ startupError: error.message });
  parentPort.close();
}
