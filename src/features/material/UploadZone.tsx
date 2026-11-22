"use client";

import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Spinner } from "@/components/ui";
import { apiUrl } from "@/lib/appBase";

interface UploadResult {
  id?: string;
  original_name: string;
  status: "uploaded" | "failed" | "rejected";
  error?: string;
}

const MAX_SIZE = 25 * 1024 * 1024;
/**
 * Qoder Sites 网关请求体上限实测约 10MB（>10MB 返回 413 "Request size limit exceeded"）。
 * 超过阈值的照片在上传前自动降采样（长边 ≤2560px、JPEG q85，仍超则逐级缩至 1600px），
 * 影展导出本身只使用 ≤1600px，画质无损于最终作品；EXIF 在重编码后移除（隐私更优）。
 */
const GATEWAY_LIMIT = 9.5 * 1024 * 1024;

async function encodeBitmap(bitmap: ImageBitmap, edge: number, quality: number): Promise<Blob | null> {
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, edge / long);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** 超过网关上限的照片自动压缩；压缩失败或无收益时原样上传（逐张报错，不阻断其余照片）。 */
async function maybeCompress(file: File): Promise<File> {
  if (file.size <= GATEWAY_LIMIT) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    let edge = 2560;
    let blob = await encodeBitmap(bitmap, edge, 0.85);
    while (blob && blob.size > GATEWAY_LIMIT && edge > 1600) {
      edge = Math.round(edge * 0.8);
      blob = await encodeBitmap(bitmap, edge, 0.85);
    }
    bitmap.close();
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.(jpe?g|png|webp)$/i, "");
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * 单张照片上传：边缘代理形态下每个请求只携带一张照片（≤25MB），
 * 避免整批塞进一个请求体触达平台网关未知上限；失败互不影响，进度按字节累计跨请求连续。
 */
function uploadOne(
  exhibitionId: string,
  file: File,
  onFraction: (fraction: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const fd = new FormData();
    fd.append("files", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(`/api/exhibitions/${exhibitionId}/photos`));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onFraction(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          const photo = data?.photos?.[0];
          resolve(
            photo ?? { original_name: file.name, status: "uploaded" },
          );
        } else {
          resolve({ original_name: file.name, status: "failed", error: data?.error?.message ?? "上传失败" });
        }
      } catch {
        resolve({ original_name: file.name, status: "failed", error: "上传响应解析失败" });
      }
    };
    xhr.onerror = () => resolve({ original_name: file.name, status: "failed", error: "网络错误，上传失败" });
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
        const total = accepted.reduce((sum, f) => sum + f.size, 0);
        let sentBefore = 0;
        const photos: UploadResult[] = [];
        for (const original of accepted) {
          const file = await maybeCompress(original);
          const baseBytes = sentBefore;
          sentBefore += file.size;
          const result = await uploadOne(exhibitionId, file, (fraction) => {
            setProgress(Math.round(((baseBytes + fraction * file.size) / Math.max(1, total)) * 100));
          });
          photos.push(result);
          setResults([...photos]);
        }
        onUploaded();
      } catch (err) {
        setError(err instanceof Error ? err.message : "上传失败");
      } finally {
        setUploading(false);
      }
    },
    [exhibitionId, onUploaded],
  );

  // react-dropzone 会在 onDrop 前静默过滤超限/类型不符文件；明确告知用户哪几张没被接收。
  const onRejected = useCallback((rejections: FileRejection[]) => {
    const reasons = rejections
      .map((r) => {
        const code = r.errors[0]?.code;
        const reason = code === "file-too-large" ? "超过 25MB" : code === "file-invalid-type" ? "格式不支持" : "读取失败";
        return `${r.file.name}（${reason}）`;
      })
      .join("、");
    setError(`有 ${rejections.length} 张照片未上传：${reasons}`);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected: onRejected,
    accept: { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/webp": [".webp"] },
    maxSize: MAX_SIZE,
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
            <p className="text-xs text-muted">JPG / PNG / WEBP · 单张 ≤25MB · 一次 ≤60 张 · 超过 9.5MB 自动压缩 · 原图仅存本地</p>
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
