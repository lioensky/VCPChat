import { compileRenderJob } from './renderWorkerRuntime.js';

self.onmessage = async ({ data }) => {
    const { id, job } = data;
    try {
        const result = await compileRenderJob(job);
        self.postMessage({ id, result });
    } catch (error) {
        self.postMessage({ id, error: String(error?.message || error) });
    }
};