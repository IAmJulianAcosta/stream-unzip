import { ExtractionEventType, ZipChunkGroup } from "./StreamingZipExtractorEngine.ts";

type ChunkGroup = ZipChunkGroup;
type OnBlobDownloaded = (blob: Blob, label: string, index: number, time: number) => void;

/**
 * A queue that downloads chunks of a ZIP file in parallel, up to a maximum concurrency.
 *
 * Each chunk is fetched via HTTP Range requests, and as each completes, the provided
 * callback is invoked with the downloaded Blob, its label, index, and timing.
 *
 * The `done` promise resolves once all chunks have been processed.
 */
export class BlobFetchQueue {
    private readonly inFlight = new Set<number>();
    private nextIndex = 0;

    private _done!: () => void;
    /** Resolves when all chunks have finished downloading. */
    public readonly done: Promise<void> = new Promise<void>((resolve) => {
        this._done = resolve;
    });

    /**
     * @param zipUrl            URL of the ZIP file to download from.
     * @param groups            Array of chunk definitions with start/end byte offsets.
     * @param onBlobDownloaded  Callback invoked after each chunk is successfully fetched.
     * @param maxConcurrent     Maximum number of concurrent downloads.
     * @param onEvent           Optional event callback for high‑level status updates.
     * @param log               Optional logging function for debug output.
     * @param rangePadding      Number of extra bytes to include after each chunk end.
     */
    constructor(
        private readonly zipUrl: string,
        private readonly groups: ChunkGroup[],
        private readonly onBlobDownloaded: OnBlobDownloaded,
        private readonly maxConcurrent: number,
        private readonly onEvent?: (type: ExtractionEventType, message: string) => void,
        private readonly log?: (msg: string) => void,
        private readonly rangePadding: number = 0
    ) {}

    /**
     * Begins downloading chunks up to the configured concurrency.
     * Continues automatically until all groups have been fetched.
     */
    public start(): void {
        this.log?.(`[Download Queue] Starting fetch with concurrency = ${this.maxConcurrent}`);
        while (this.inFlight.size < this.maxConcurrent && this.nextIndex < this.groups.length) {
            this.fetchNext();
        }
    }

    /**
     * Fetches the next chunk in the queue.
     * Called recursively until all chunks are dispatched.
     */
    private async fetchNext(): Promise<void> {
        const index = this.nextIndex++;
        const group = this.groups[index];
        const totalChunks = this.groups.length;

        this.inFlight.add(index);
        this.log?.(`[Download Queue] Dispatching chunk ${index + 1}/${totalChunks} (inFlight = ${this.inFlight.size})`);

        try {
            const { label, blob, downloadTime } = await this.downloadChunk(index, totalChunks, this.zipUrl, group);
            this.log?.(`[Download Queue] Completed ${label}, size = ${blob.size} bytes, time = ${downloadTime.toFixed(1)}ms`);
            this.onBlobDownloaded(blob, label, index, downloadTime);
        } catch (err) {
            console.error(`Failed to fetch chunk ${index}:`, err);
            this.log?.(`[Download Queue] Error fetching chunk ${index}: ${(err as Error).message}`);
        } finally {
            this.inFlight.delete(index);
            this.log?.(`[Download Queue] Chunk ${index} removed from inFlight. Remaining: ${this.inFlight.size}`);

            if (this.nextIndex < this.groups.length) {
                // More to fetch
                this.fetchNext();
            } else if (this.inFlight.size === 0) {
                // All done
                this.log?.(`[Download Queue] All chunks processed`);
                this._done();
            }
        }
    }

    /**
     * Downloads a single chunk via HTTP Range request.
     *
     * @param index        Index of the chunk in the overall group list.
     * @param totalChunks  Total number of chunks.
     * @param zipUrl       URL of the ZIP file.
     * @param group        Byte‑range offsets for this chunk.
     * @returns            An object containing the chunk label, Blob, and download time.
     * @throws             If the HTTP response is not OK or partial content.
     */
    private async downloadChunk(
        index: number,
        totalChunks: number,
        zipUrl: string,
        group: ChunkGroup
    ): Promise<{ label: string; blob: Blob; downloadTime: number }> {
        const label = `chunk ${index + 1}/${totalChunks}`;
        this.log?.(`[Download Queue] Starting download for ${label}`);
        this.onEvent?.(ExtractionEventType.ChunkDownloadStarted, `Downloading ${label}`);

        const dlStart = performance.now();
        const response = await fetch(zipUrl, {
            headers: {
                Range: `bytes=${group.start}-${group.end + this.rangePadding}`
            }
        });

        if (!response.ok && response.status !== 206) {
            throw new Error(`Chunk fetch failed (HTTP ${response.status})`);
        }

        this.onEvent?.(ExtractionEventType.ChunkDownloadFinished, `Downloaded ${label}`);
        const blob = await response.blob();
        this.log?.(`[Download Queue] Download finished for ${label}`);
        const downloadTime = performance.now() - dlStart;

        return { label, blob, downloadTime };
    }
}
