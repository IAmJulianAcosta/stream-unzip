import React, { useState } from "react";
import StreamingZipExtractorEngine, {
    ExtractionEventType
} from "../src/StreamingZipExtractorEngine";

interface StreamingZipExtractorProps {
    zipUrl: string;
}

const StreamingZipExtractor: React.FC<StreamingZipExtractorProps> = ({ zipUrl }) => {
    const [status, setStatus] = useState<string>("");
    const [progressText, setProgressText] = useState<string>("");
    const [progressPercent, setProgressPercent] = useState<number>(0);
    const [totalBytes, setTotalBytes] = useState<number>(0);
    const [bytesDone, setBytesDone] = useState<number>(0);
    const [duration, setDuration] = useState<number | null>(null);
    const [averageDuration, setAverageDuration] = useState<number | null>(null);
    const iterations = 1;

    const handleExtractClick = async () => {
        let cumulativeDuration = 0;

        let outputDir: FileSystemDirectoryHandle;
        try {
            outputDir = await window.showDirectoryPicker();
            outputDir.requestPermission({ mode: "readwrite" })
            console.log(outputDir);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setStatus("Folder selection cancelled: " + msg);
            return;
        }

        for (let i = 0; i < iterations; i++) {
            setStatus(`Iteration ${i + 1}/${iterations}`);
            setProgressText("");
            setProgressPercent(0);
            setTotalBytes(0);
            setBytesDone(0);

            const engine = new StreamingZipExtractorEngine(
                (currentBytes, totalBytes, filename, percent) => {
                    setTotalBytes(totalBytes);
                    setBytesDone(currentBytes);
                    setProgressText(prev => `${filename}\n${prev}`);
                    setProgressPercent(percent);
                },
                (eventType, message) => {
                    switch (eventType) {
                        case ExtractionEventType.MetadataDownloaded:
                        case ExtractionEventType.ChunkDownloadStarted:
                        case ExtractionEventType.ChunkDownloadFinished:
                        case ExtractionEventType.Info: {
                            setStatus(message);
                            break;
                        }
                        default: {
                            break;
                        }
                    }
                },
                outputDir,
                {
                    chunkSize: 1024*1024*20,
                    verbosity: true,
                }
            );

            console.time(`Iteration ${i + 1} total time`);
            const startTime = performance.now();

            try {
                await engine.extract(zipUrl);
                const endTime = performance.now();
                const iterationDuration = (endTime - startTime) / 1000;
                console.timeEnd(`Iteration ${i + 1} total time`);
                console.log(`Iteration ${i + 1} duration: ${iterationDuration.toFixed(2)}s`);
                cumulativeDuration += iterationDuration;
                setDuration(iterationDuration);
                setStatus(`Iteration ${i + 1}/${iterations} completed.`);
            } catch (err) {
                console.log(err);
                console.error(err);
                const msg = err instanceof Error ? err.message : String(err);
                setStatus("Error: " + msg);
                return;
            }
        }

        const avg = cumulativeDuration / iterations;
        console.log(`Average duration over ${iterations} runs: ${avg.toFixed(2)}s`);
        setAverageDuration(avg);
        setStatus("All iterations completed successfully!");
    };

    return (
        <div style={{ border: "1px solid #ccc", padding: "1em", margin: "1em", width: 500 }}>
            <h3>Streaming ZIP Extractor</h3>
            <p>{status}</p>
            {progressText && (
                <div style={{ height: 200, overflow: "auto" }}>
                    <p style={{ whiteSpace: "pre-wrap" }}>{progressText}</p>
                </div>
            )}
            {status && progressPercent >= 0 && (
                <progress value={progressPercent} max={100} style={{ width: "100%" }} />
            )}
            <p>
                {Math.round(bytesDone / 1024)} KB of {Math.round(totalBytes / 1024)} KB extracted
            </p>
            {duration !== null && (
                <p><strong>Last run completed in {duration.toFixed(2)} seconds</strong></p>
            )}
            {averageDuration !== null && (
                <p><strong>Average duration over {iterations} runs: {averageDuration.toFixed(2)} seconds</strong></p>
            )}
            <button onClick={handleExtractClick}>Extract ZIP (Streaming, 20 runs)</button>
        </div>
    );
};

export default StreamingZipExtractor;
