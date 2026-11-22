import { apiUrl } from "@/lib/appBase";
import type { PhotoAsset } from "@/types";

/**
 * 影展图片（§6.6 / 提示词6）：用原图宽高比设 aspect-ratio（无 CLS），object-fit:contain 不裁主体，
 * lazy 加载。加载失败时隐藏 img 露出底层胶片占位（纯 DOM，无 hook → 服务端静态导出可复用）。
 * 原图仅经 /api/files 本地路由读取。
 */
export function ExhibitionImage({
  photo,
  exhibitionId,
  variant = "original",
  className = "",
  alt,
  fill = false,
}: {
  photo: PhotoAsset | undefined;
  exhibitionId: string;
  variant?: "thumb" | "original";
  className?: string;
  alt?: string;
  fill?: boolean;
}) {
  const w = photo?.width ?? 3;
  const h = photo?.height ?? 2;
  const label = alt ?? photo?.original_name ?? "照片";
  const frameStyle = fill ? { height: "100%", width: "100%" } : { aspectRatio: `${w} / ${h}` };

  if (!photo) {
    return (
      <div
        className={`img-frame img-placeholder ${className}`}
        style={frameStyle}
        role="img"
        aria-label={`${label}（图片缺失）`}
      >
        <span className="text-xs opacity-60">▦ {label}</span>
      </div>
    );
  }

  return (
    <div className={`img-frame ${className}`} style={frameStyle}>
      <span className="img-placeholder img-fallback" aria-hidden="true">
        <span className="text-xs opacity-60">▦ {label}</span>
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="exhibition-img"
        src={apiUrl(`/api/files/${exhibitionId}/${photo.id}?variant=${variant}`)}
        alt={label}
        loading="lazy"
        decoding="async"
        onError={(e) => {
          e.currentTarget.style.visibility = "hidden";
        }}
      />
    </div>
  );
}