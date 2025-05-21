export class UnzipWorker {
    private worker: Worker;
    private pendingJobs: Map<number, (value: any) => void> = new Map();
    private log?: (msg: string) => void;
    private jobIdCounter: number = 0;

    constructor(
        log?: (msg: string) => void,
        writePause: number = 100,
    ) {
        (window as any).workerAmount++;
        this.log = log;

        const workerSource = `
            importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');
        
            // ★ configurable pause between writes (in milliseconds)
            const WRITE_PAUSE_MS = ${writePause};
        
            async function sleep(ms) {
                return new Promise((r) => { setTimeout(r, ms); });
            }
        
            async function writeFile(handle, bytes) {
                const writable = await handle.createWritable();
                await writable.write(bytes);
                await writable.close();
                // ★ give SmartScreen/Defender a moment before the next file
                if (WRITE_PAUSE_MS > 0) {
                    await sleep(WRITE_PAUSE_MS);
                }
            }
        
            self.onmessage = async function (e) {
                const { id, type, compressed, fileHandle, bytes } = e.data;
                try {
                    if (type === 'inflate') {
                        const result = fflate.inflateSync(new Uint8Array(compressed));
                        self.postMessage({ id, data: result }, [result.buffer]);
                    } else if (type === 'write') {
                        await writeFile(fileHandle, new Uint8Array(bytes));
                        self.postMessage({ id });
                    }
                } catch (err) {
                    self.postMessage({ id, error: err.message });
                }
            };
        `;

        const blobURL: string = URL.createObjectURL(
            new Blob([workerSource], {type: "application/javascript"})
        );

        this.worker = new Worker(blobURL);

        this.log && this.log(`Created a new worker, amount ${(window as any).workerAmount}`);

        this.worker.onmessage = (e: MessageEvent) => {
            const {id, data, error} = e.data;
            const resolve = this.pendingJobs.get(id);
            if (resolve === undefined) {
                return;
            }
            this.pendingJobs.delete(id);
            if (error !== undefined) {
                this.log?.(`[UnzipWorker] Job ${id} failed: ${error}`);
                resolve(Promise.reject(new Error(error)) as unknown as Uint8Array);
            } else {
                resolve(data);
            }
        };

        this.log?.("[UnzipWorker] Initialized");
    }

    public async decompress(input: Uint8Array): Promise<Uint8Array> {
        return await this.enqueue("inflate", {compressed: input}, [input.buffer]);
    }

    public async writeFile(
        handle: FileSystemFileHandle,
        data: Uint8Array
    ): Promise<void> {
        await this.enqueue("write", {fileHandle: handle, bytes: data}, [data.buffer]);
        return;
    }

    private enqueue(
        type: "inflate" | "write",
        payload: Record<string, unknown>,
        transfers: Transferable[]
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const id: number = this.jobIdCounter++;
            this.pendingJobs.set(id, resolve);
            try {
                this.worker.postMessage({id, type, ...payload}, transfers);
            } catch (err) {
                this.pendingJobs.delete(id);
                reject(err);
            }
        });
    }

    public terminate(): void {
        this.worker.terminate();
        this.pendingJobs.clear();
        this.log?.("[UnzipWorker] Terminated");
    }
}
