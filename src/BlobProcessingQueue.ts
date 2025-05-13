import {ExtractionEventType, ZipChunkGroup, ZipEntryMetadata} from "./StreamingZipExtractorEngine";
import {getNestedFileHandle} from "./FsUtils";
import flate from "./wasm-flate/wasm-flate";
import {decompressSync} from 'fflate';
import {UnzipWorker} from "./UnzipWorker";

/**
 * Manages parallel decompression of downloaded ZIP chunk groups using a fixed pool of Web Workers.
 *
 * Each chunk group is enqueued and processed by one of the available workers, up to the configured pool size.
 * Progress updates and completion events are emitted via the provided callbacks.
 */
export class BlobProcessingQueue {
    private workers: UnzipWorker[] = [];
    private bytesDone: number = 0;

    private activeTasks: Set<Promise<void>> = new Set();
    private taskQueue: Array<() => Promise<void>> = [];

    private remainingTasks: number;
    private _done!: () => void;
    public readonly done: Promise<void>;

    private static MAXIMUM_ALLOWED_WORKERS = Math.max(4, Math.floor(navigator.hardwareConcurrency / 1.5));

    private order: Array<"worker" | "wasm" | "sync">

    /**
     * @param onProgress        Callback invoked after each file entry is unzipped to report progress.
     * @param onEvent           Callback for emitting high-level events like FileUnzipped.
     * @param log               Optional logger for debug output.
     * @param workerPoolSize    Number of concurrent workers to use for decompression.
     * @param expectedUnzipTasks
     * @param preferredMethod
     */
    constructor(
        private readonly onProgress: (currentBytes: number, filename: string) => void,
        private readonly onEvent: (type: ExtractionEventType, message: string) => void,
        private readonly log: (msg: string) => void,
        expectedUnzipTasks: number,
        preferredMethod = "worker",
        workerPoolSize?: number,
    ) {
        this.remainingTasks = expectedUnzipTasks;

        if (typeof workerPoolSize === "number") {
            if (workerPoolSize > BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS) {
                workerPoolSize = BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS;
                console.warn(`workerPoolSize (${workerPoolSize}) larger then the maximum ${BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS}`);
            }
        } else {
            workerPoolSize = BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS;
        }
        workerPoolSize = Math.max(1, workerPoolSize); // Ensure it's not 0

        this.log(`workerPoolSize set to ${workerPoolSize}`);

        for (let i = 0; i < workerPoolSize; i++) {
            this.workers.push(new UnzipWorker(log));
        }


        this.done = new Promise<void>((resolve) => {
            this._done = resolve;
        });

        this.order = (() => {
            if (preferredMethod === "wasm") {
                return ["wasm", "worker", "sync"];
            }
            if (preferredMethod === "sync") {
                return ["sync", "worker", "wasm"];
            }
            return ["worker", "wasm", "sync"]; // default
        })();

        this.log?.(`Preferred method: ${this.order}`);
    }

    /**
     * Queues a group of ZIP entries for decompression and returns a promise
     * that resolves once the entire group has been processed.
     */
    public processGroupBlob(
        blob: Blob,
        group: ZipChunkGroup,
        index: number,
        totalChunks: number,
        outputDir: FileSystemDirectoryHandle,
    ): Promise<void> {
        const label = `chunk ${index + 1}/${totalChunks}`;
        const uzStart = performance.now();

        let resolveTask!: () => void;
        const externalPromise = new Promise<void>((resolve) => {
            resolveTask = resolve;
        });

        const task = async () => {
            this.log(`[UNZIP] Unzip starting for ${label}`);

            const workerSlots: Promise<void>[] = this.workers.map(() => Promise.resolve());

            for (const entry of group.entries) {
                // wait until the first worker slot finishes; get its index
                const slotIndex: number = await Promise.race(
                    workerSlots.map((p, i) => p.then(() => i)),
                );

                // launch the new task in that slot
                workerSlots[slotIndex] = this.processEntry(
                    entry,
                    blob,
                    group.start,
                    outputDir,
                    (bytes) => {
                        this.bytesDone += bytes;
                        this.onProgress(bytes, entry.filename);
                    },
                    this.workers[slotIndex],
                );
            }

            // wait for the last wave of worker slots to finish
            await Promise.all(workerSlots);

            const uzTime = performance.now() - uzStart;
            this.log(`[UNZIP] Unzip complete for ${label}`);
            (window as any).benchmarkTimes.push({step: `Unzip ${label}`, timeMs: uzTime});

            resolveTask();
        };

        this.taskQueue.push(task);
        this.scheduleNextTask();

        return externalPromise;
    }

    /**
     * Internal scheduler that runs queued tasks as workers become available.
     */
    private scheduleNextTask(): void {
        if (this.activeTasks.size >= this.workers.length) {
            return;
        }

        const task = this.taskQueue.shift();
        if (task) {
            const workerPromise = task().finally(() => {
                this.activeTasks.delete(workerPromise);
                this.scheduleNextTask();
            });
            this.activeTasks.add(workerPromise);
        }
    }

    /**
     * Decompresses a single ZIP entry and writes it to the file system.
     */
    private async processEntry(
        entry: ZipEntryMetadata,
        blob: Blob,
        baseOffset: number,
        outputDir: FileSystemDirectoryHandle,
        onComplete: (decompressedBytes: number) => void,
        worker: UnzipWorker,
    ): Promise<void> {
        if (entry.directory) {
            this.log(`[UNZIP] Skipping directory: ${entry.filename}`);
            onComplete(0);
            return;
        }

        const offset = entry.offset - baseOffset;
        const headerBlob = blob.slice(offset, offset + 30);
        const headerArray = await headerBlob.arrayBuffer();
        const headerView = new DataView(headerArray);
        const filenameLength = headerView.getUint16(26, true);
        const extraFieldLength = headerView.getUint16(28, true);
        const headerLength = 30 + filenameLength + extraFieldLength;

        const compSize = entry.compressedSize;
        const dataStart = offset + headerLength;
        const dataEnd = dataStart + compSize;
        const sliceBlob = blob.slice(offset, dataEnd);
        const sliceBuffer = new Uint8Array(await sliceBlob.arrayBuffer());

        const decompressed = await this.extractDeflateStream(sliceBuffer, compSize, worker);
        const decompressedLength = decompressed.length;

        const fileHandle = await getNestedFileHandle(outputDir, entry.filename);

        await worker.writeFile(fileHandle, decompressed);

        onComplete(decompressedLength);

        this.remainingTasks--;
        if (this.remainingTasks === 0) {
            this._done();
        }
        this.onEvent(ExtractionEventType.FileUnzipped, entry.filename);
    }

    /**
     * Extracts raw DEFLATE data from a ZIP entry buffer.
     */
    private async extractDeflateStream(
        buffer: Uint8Array,
        fallbackCompressedSize: number,
        worker: UnzipWorker,
    ): Promise<Uint8Array> {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

        const signature = view.getUint32(0, true);
        if (signature !== 0x04034b50) {
            throw new Error("Invalid local file header signature");
        }

        const compressionMethod = view.getUint16(8, true);
        if (compressionMethod !== 8 && compressionMethod !== 0) {
            throw new Error(`Unsupported compression method: ${compressionMethod}`);
        }

        let compressedSize = view.getUint32(18, true);
        if (compressedSize === 0) {
            compressedSize = fallbackCompressedSize;
        }

        const filenameLength   = view.getUint16(26, true);
        const extraFieldLength = view.getUint16(28, true);
        const dataStart        = 30 + filenameLength + extraFieldLength;

        if (buffer.length < dataStart + compressedSize) {
            throw new Error("Sliced blob is too small for expected compressed data");
        }

        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

        if (compressionMethod === 0) {
            return compressed;
        }

        for (const method of this.order) {
            try {
                if (method === "worker") {
                    return await worker.decompress(compressed);
                }
                if (method === "wasm") {
                    return await flate.deflate_decode_raw(compressed);
                }
                // "sync"
                return decompressSync(compressed);
            } catch (err) {
                this.log?.(`[UNZIP] ${method} inflate failed: ${(err as Error).message}`);
                // continue to next method in order array
            }
        }

        throw new Error("All inflate methods failed");
    }


    /**
     * Terminates all active workers immediately.
     */
    public terminate(): void {
        this.workers.forEach((worker) => {
            this.log(`Terminating worker... ${worker}`);
            worker.terminate();
            this.log(`Worker ${worker} terminated`);
        });
    }

}
