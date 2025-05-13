// StreamingZipExtractorEngine.ts
// v2 – Adds an **internal 20‑worker pool** so each file can be decompressed in parallel.
// Existing logic, variable names and explicit‑brace style are preserved.

import {Entry, HttpReader, ZipReader} from "@zip.js/zip.js";
import {BlobFetchQueue} from "./BlobFetchQueue";
import {BlobProcessingQueue} from "./BlobProcessingQueue";

(window as any).benchmarkTimes = (window as any).benchmarkTimes || [];

export enum ExtractionEventType {
    MetadataDownloaded = "MetadataDownloaded",
    ChunkDownloadStarted = "ChunkDownloadStarted",
    ChunkDownloadFinished = "ChunkDownloadFinished",
    FileUnzipped = "FileUnzipped",
    Info = "Info"
}

export type ZipEntryMetadata = {
    filename: string;
    offset: number;
    compressedSize: number;
    uncompressedSize: number;
    directory: boolean;
};

export type ZipChunkGroup = {
    start: number;
    end: number;
    entries: ZipEntryMetadata[];
};

export type StreamingZipExtractorOptions = {
    chunkSize?: number;
    rangePadding?: number;
    headerOverhead?: number;
    verbosity?: boolean;
    workerPoolSize?: number;
};

export default class StreamingZipExtractorEngine {
    private onProgress: (
        currentBytes: number,
        totalBytes: number,
        filename: string,
        percent: number
    ) => void;
    private onEvent?: (type: ExtractionEventType, message: string) => void;
    private outputDirHandle?: FileSystemDirectoryHandle;

    private chunkSize: number;
    private rangePadding: number;
    private headerOverhead: number;
    private verbosity: boolean;

    private blobFetchQueue!: BlobFetchQueue;
    private blobProcessingQueue!: BlobProcessingQueue;

    private totalBytes: number = 0;
    private bytesDone: number = 0;
    private workerPoolSize?: number;

    constructor(
        onProgress: (
            currentBytes: number,
            totalBytes: number,
            filename: string,
            percent: number
        ) => void,
        onEvent: (type: ExtractionEventType, message: string) => void,
        outputDirHandle: FileSystemDirectoryHandle,
        options?: StreamingZipExtractorOptions
    ) {
        this.onProgress = onProgress;
        this.onEvent = onEvent;
        this.outputDirHandle = outputDirHandle;
        this.chunkSize = options?.chunkSize ?? 10 * 1024 * 1024;
        this.rangePadding = options?.rangePadding ?? 1023;
        this.headerOverhead = options?.headerOverhead ?? 128;
        this.verbosity = options?.verbosity ?? false;
        this.workerPoolSize = options?.workerPoolSize;
    }

    public updateProgress = (currentBytes: number, filename: string) => {
        // Update the internal state of the Engine
        this.bytesDone += currentBytes;
        const percent = Math.floor((this.bytesDone / this.totalBytes) * 100);

        // Call the original onProgress passed from the Engine to update the UI
        this.onProgress?.(this.bytesDone, this.totalBytes, filename, percent);
    };

    private log(message: string): void {
        if (!this.verbosity) {
            return;
        }
        const now = new Date();
        const timestamp = now.toISOString().replace("T", " ").replace("Z", "");
        const ms = now.getMilliseconds().toString().padStart(3, "0");
        console.log(`[${timestamp}.${ms}] [Extractor] ${message}`);
    }

    public async extract(zipUrl: string): Promise<void> {
        this.log(`Starting extraction from: ${zipUrl}`);
        this.onEvent?.(ExtractionEventType.Info, "Fetching metadata and selecting output folder...");

        const [metadata, outputDirHandle] = await Promise.all([
            this.getZipEntryMetadata(zipUrl),
            this.outputDirHandle
                ? Promise.resolve(this.outputDirHandle)
                : window.showDirectoryPicker()
        ]);

        this.log(`Metadata fetched, ${metadata.length} entries total`);
        this.onEvent?.(ExtractionEventType.MetadataDownloaded, `${metadata.length} entries found`);

        const fileEntries = metadata.filter(entry => !entry.directory);
        this.totalBytes = fileEntries.reduce((sum, e) => sum + e.uncompressedSize, 0);
        this.bytesDone = 0;

        const groups = this.groupZipEntriesByChunkSize(metadata, this.chunkSize);
        const totalChunks = groups.length;

        this.blobFetchQueue = new BlobFetchQueue(
            zipUrl,
            groups,
            (blob, _, index) => {
                try {
                    this.unzipBlog(blob, groups[index], index, totalChunks, outputDirHandle)
                }
                catch (error) {
                    this.log(`Error in chunk ${index}: ${error}`)
                }
            },
            6,
            this.onEvent,
            this.log.bind(this),
            this.rangePadding
        );

        this.blobProcessingQueue = new BlobProcessingQueue(
            this.updateProgress.bind(this),
            this.onEvent!,
            this.log.bind(this),
            fileEntries.length,
            this.workerPoolSize,
        );

        this.blobFetchQueue.start();

        await Promise.all([
            this.blobFetchQueue.done,
            this.blobProcessingQueue.done,
        ]);

        this.blobProcessingQueue.terminate();

        this.log("All chunks processed");
        this.onEvent?.(ExtractionEventType.Info, "Extraction complete!");
    }

    private async unzipBlog(
        blob: Blob,
        group: ZipChunkGroup,
        index: number,
        totalChunks: number,
        outputDir: FileSystemDirectoryHandle
    ): Promise<void> {
        // Await the promise returned by processGroupBlob
        await this.blobProcessingQueue.processGroupBlob(blob, group, index, totalChunks, outputDir); // Ensure we await this operation before proceeding
    }

    private async getZipEntryMetadata(zipUrl: string): Promise<ZipEntryMetadata[]> {
        const reader = new HttpReader(zipUrl, { useRangeHeader: true });
        const zipReader = new ZipReader(reader);
        const entries = await zipReader.getEntries();

        const metadata = entries.map((e: Entry) => ({
            filename: e.filename,
            offset: e.offset,
            compressedSize: e.compressedSize,
            uncompressedSize: e.uncompressedSize,
            directory: e.directory
        }));

        await zipReader.close();
        this.log(`Closed zip reader, total entries: ${metadata.length}`);
        return metadata;
    }

    private groupZipEntriesByChunkSize(
        entries: ZipEntryMetadata[],
        desiredChunkSize: number
    ): ZipChunkGroup[] {
        const groups: ZipChunkGroup[] = [];
        const fileEntries = entries.filter(e => !e.directory).sort((a, b) => a.offset - b.offset);

        let currentGroup: ZipEntryMetadata[] = [];
        let currentSize = 0;
        let groupStart = 0;

        for (const entry of fileEntries) {
            const totalEntrySize = entry.compressedSize + this.headerOverhead;

            if (totalEntrySize >= desiredChunkSize) {
                if (currentGroup.length > 0) {
                    const last = currentGroup[currentGroup.length - 1];
                    groups.push({
                        start: groupStart,
                        end: last.offset + last.compressedSize + this.headerOverhead,
                        entries: [...currentGroup]
                    });
                    currentGroup = [];
                    currentSize = 0;
                }
                groups.push({
                    start: entry.offset,
                    end: entry.offset + totalEntrySize,
                    entries: [entry]
                });
                continue;
            }

            if (currentSize + totalEntrySize > desiredChunkSize) {
                const last = currentGroup[currentGroup.length - 1];
                groups.push({
                    start: groupStart,
                    end: last.offset + last.compressedSize + this.headerOverhead,
                    entries: [...currentGroup]
                });
                currentGroup = [];
                currentSize = 0;
            }

            if (currentGroup.length === 0) {
                groupStart = entry.offset;
            }

            currentGroup.push(entry);
            currentSize += totalEntrySize;
        }

        if (currentGroup.length > 0) {
            const last = currentGroup[currentGroup.length - 1];
            groups.push({
                start: groupStart,
                end: last.offset + last.compressedSize + this.headerOverhead,
                entries: [...currentGroup]
            });
        }

        this.log(`Grouped into ${groups.length} chunks`);
        return groups;
    }
}
