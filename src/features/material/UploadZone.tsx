"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Spinner } from "@/components/ui";

interface UploadResult {
  id?: string;
  original_name: string;
  status: "uploaded" | "failed" | "rejected";
  error?: string;
}

function uploadBatch(
  exhibitionId: string,
  files: File[],
  onProgress: (pct: number) => void,
): Promise<{ photos: UploadResult[]; uploaded: number; failed: number }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/exhibitions/${exhibitionId}/photos`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data?.error?.message ?? "上传失败"));
      } catch {
        reject(new Error("上传响应解析失败"));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误，上传失败"));
    xhr.send(fd);
  });
}

export function UploadZone({
  exhibitionId,
  onUploaded,
}: {
  exhibitionId: string;
  onUploaded: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;
      setUploading(true);
      setProgress(0);
      setError(null);
      setResults(null);
      try {
        const data = await uploadBatch(exhibitionId, accepted, setProgress);
        setResults(data.photos);
        onUploaded();
      } catch (err) {
        setError(err instanceof Error ? err.message : "上传失败");
      } finally {
        setUploading(false);
      }
    },
    [exhibitionId, onUploaded],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/webp": [".webp"] },
    maxSize: 10 * 1024 * 1024,
    disabled: uploading,
  });

  return (
    <div>
      <div
        {...getRootProps()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${
          isDragActive ? "border-gold bg-gold/5" : "border-ink-line hover:border-gold/40"
        }`}
      >
        <input {...getInputProps()} />
        {uploading ? (
          <Spinner label={`上传中 ${progress}%`} />
        ) : (
          <>
            <p className="text-sm text-text">把照片拖进来，或点击选择</p>
            <p className="text-xs text-muted">JPG / PNG / WEBP · 单张 ≤25MB · 一次 ≤60 张 · 原图仅存本地</p>
          </>
        )}
      </div>

      {uploading && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-ink-soft">
          <div className="h-full bg-gold transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && <p className="mt-3 text-sm text-error">{error}</p>}

      {results && (
        <ul className="mt-3 space-y-1 text-xs">
          {results.map((r, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className={r.status === "uploaded" ? "text-ok" : "text-error"}>
                {r.status === "uploaded" ? "✓" : "✕"}
              </span>
              <span className="text-muted">{r.original_name}</span>
              {r.error && <span className="text-error">{r.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}