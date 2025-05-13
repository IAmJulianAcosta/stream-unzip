export class UnzipWorker {
    private worker: Worker;
    private jobIdCounter: number = 0;
    private pendingJobs: Map<number, (data: Uint8Array) => void> = new Map();
    private log?: (msg: string) => void;

    constructor(log?: (msg: string) => void) {
        this.log = log;

        const workerSource = `
            importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');
            self.onmessage = function(e) {
                const { id, compressed } = e.data;
                try {
                    const decompressed = fflate.decompressSync(new Uint8Array(compressed));
                    self.postMessage({ id, data: decompressed }, [decompressed.buffer]);
                } catch (err) {
                    self.postMessage({ id, error: err.message });
                }
            };
        `;
        const blobURL = URL.createObjectURL(
            new Blob([workerSource], { type: "application/javascript" })
        );

        this.worker = new Worker(blobURL);
        this.worker.onmessage = (e: MessageEvent) => {
            const { id, data, error } = e.data;
            const resolve = this.pendingJobs.get(id);
            if (!resolve) return;

            this.pendingJobs.delete(id);
            if (error) {
                this.log?.(`[UnzipWorker] Decompression failed for id=${id}: ${error}`);
                resolve(Promise.reject(new Error(error)) as unknown as Uint8Array);
            } else {
                // this.log?.(`[UnzipWorker] Decompression succeeded for id=${id}`);
                resolve(data);
            }
        };

        this.log?.(`[UnzipWorker] Initialized`);
    }

    public async decompress(input: Uint8Array): Promise<Uint8Array> {
        return await this.decompressWithWorker(input);
    }

    private decompressWithWorker(compressed: Uint8Array): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const id = this.jobIdCounter++;
            this.pendingJobs.set(id, resolve);
            try {
                this.worker.postMessage({ id, compressed }, [compressed.buffer]);
            } catch (err) {
                this.pendingJobs.delete(id);
                reject(err);
            }
        });
    }

    public terminate(): void {
        this.worker.terminate();
        this.pendingJobs.clear();
        this.log?.(`[UnzipWorker] Terminated`);
    }
}
