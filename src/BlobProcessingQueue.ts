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
    public readonly done: Promise<void>

    private static MAXIMUM_ALLOWED_WORKERS = Math.max(4, Math.floor(navigator.hardwareConcurrency / 1.5));

    /**
     * @param onProgress        Callback invoked after each file entry is unzipped to report progress.
     * @param onEvent           Callback for emitting high-level events like FileUnzipped.
     * @param log               Optional logger for debug output.
     * @param workerPoolSize    Number of concurrent workers to use for decompression.
     * @param expectedUnzipTasks
     */
    constructor(
        private readonly onProgress: (currentBytes: number, filename: string) => void,
        private readonly onEvent: (type: ExtractionEventType, message: string) => void,
        private readonly log: (msg: string) => void,
        expectedUnzipTasks: number,
        workerPoolSize?: number,
    ) {
        this.remainingTasks = expectedUnzipTasks;

        if (typeof workerPoolSize === "number") {
            if (workerPoolSize > BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS) {
                workerPoolSize = BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS;
            }
            workerPoolSize = Math.max(1, workerPoolSize); // Ensure it's not 0
            console.warn(`workerPoolSize (${workerPoolSize}) larger then the maximum ${BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS}`)
        } else {
            workerPoolSize = BlobProcessingQueue.MAXIMUM_ALLOWED_WORKERS;
        }

        console.log(`workerPoolSize set to ${workerPoolSize}`)

        for (let i = 0; i < workerPoolSize; i++) {
            this.workers.push(new UnzipWorker(log));
        }

        this.done = new Promise<void>((resolve) => {
            this._done = resolve;
        });
    }

    /**
     * Queues a group of ZIP entries for decompression and returns a promise
     * that resolves once the entire group has been processed.
     *
     * @param blob        The downloaded chunk blob containing compressed entries.
     * @param group       Metadata describing the offset and entries in the chunk.
     * @param index       Zero-based index of this chunk in the full sequence.
     * @param totalChunks Total number of chunks to process.
     * @param outputDir   FileSystemDirectoryHandle where decompressed files are written.
     * @returns           Promise that resolves when this chunk group is fully unzipped.
     */
    public processGroupBlob(
        blob: Blob,
        group: ZipChunkGroup,
        index: number,
        totalChunks: number,
        outputDir: FileSystemDirectoryHandle
    ): Promise<void> {
        const label = `chunk ${index + 1}/${totalChunks}`;
        const uzStart = performance.now();

        let resolveTask!: () => void;
        const externalPromise = new Promise<void>((resolve) => {
            resolveTask = resolve;
        });

        const task = async () => {
            this.log(`[UNZIP] Unzip starting for ${label}`);
            const extractTasks: Promise<void>[] = [];

            for (const entry of group.entries) {
                const t = this.processEntry(
                    entry,
                    blob,
                    group.start,
                    outputDir,
                    (bytes) => {
                        this.bytesDone += bytes;
                        this.onProgress(bytes, entry.filename);
                    }
                );
                extractTasks.push(t);
            }

            await Promise.all(extractTasks);

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
     * Ensures no more than one task per worker is active at once.
     */
    private scheduleNextTask(): void {
        if (this.activeTasks.size >= this.workers.length) return;

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
     *
     * @param entry        Metadata for the ZIP entry (offsets, filename, sizes).
     * @param blob         The blob containing the compressed data for this group.
     * @param baseOffset   Offset within the blob where this group begins.
     * @param outputDir    Directory handle for writing the decompressed file.
     * @param onComplete   Callback invoked with the number of bytes written.
     */
    private async processEntry(
        entry: ZipEntryMetadata,
        blob: Blob,
        baseOffset: number,
        outputDir: FileSystemDirectoryHandle,
        onComplete: (decompressedBytes: number) => void
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

        const decompressed = await this.extractDeflateStream(sliceBuffer, compSize);

        const fileHandle = await getNestedFileHandle(outputDir, entry.filename);
        const writable = await fileHandle.createWritable();
        await writable.write(decompressed);
        await writable.close();

        onComplete(decompressed.length);

        this.remainingTasks--;
        if (this.remainingTasks === 0) {
            this._done();
        }
        this.onEvent(ExtractionEventType.FileUnzipped, entry.filename);
    }

    /**
     * Extracts raw DEFLATE data from a ZIP entry buffer.
     * Tries the pool of Web Workers first, then falls back to wasm-flate, then fflate.
     *
     * @param buffer                 Full entry buffer (including local header + compressed data).
     * @param fallbackCompressedSize Expected compressedSize from metadata if header field is zero.
     * @returns                      Decompressed bytes.
     */
        // Add this at the top of your class:
    private nextWorkerIndex: number = 0;

    private async extractDeflateStream(
        buffer: Uint8Array,
        fallbackCompressedSize: number
    ): Promise<Uint8Array> {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

        const signature = view.getUint32(0, true);
        if (signature !== 0x04034b50) {
            throw new Error("Invalid local file header signature");
        }

        const compressionMethod = view.getUint16(8, true);
        if (compressionMethod !== 8) {
            throw new Error(`Unsupported compression method: ${compressionMethod}`);
        }

        let compressedSize = view.getUint32(18, true);
        if (compressedSize === 0) {
            compressedSize = fallbackCompressedSize;
        }

        const filenameLength = view.getUint16(26, true);
        const extraFieldLength = view.getUint16(28, true);
        const dataStart = 30 + filenameLength + extraFieldLength;

        if (buffer.length < dataStart + compressedSize) {
            throw new Error("Sliced blob is too small for expected compressed data");
        }

        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

        // Round‑robin selection of the next worker
        const worker = this.workers[this.nextWorkerIndex];
        this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

        try {
            return await worker.decompress(compressed);
        } catch (workerErr) {
            this.log(`[UNZIP] Worker inflate failed: ${(workerErr as Error).message}`);
        }

        try {
            const decompressed = await flate.deflate_decode_raw(compressed);
            return decompressed;
        } catch (wasmErr) {
            this.log(`[UNZIP] WASM flate failed: ${(wasmErr as Error).message}`);
        }

        return decompressSync(compressed);
    }

    /**
     * Terminates all active workers immediately.
     */
    public terminate(): void {
        this.workers.forEach((worker) => {
            console.log(`Terminating worker... ${worker}`);
            worker.terminate();
            console.log(`Worker ${worker} terminated`);
        });
    }

}
