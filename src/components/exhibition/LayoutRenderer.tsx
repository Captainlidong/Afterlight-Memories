import type { ExhibitionLayoutT } from "@/lib/agents/schemas";
import type { NarrativeDTO, PhotoAsset } from "@/types";
import { SECTION_REGISTRY, type RenderCtx } from "./sections";

/**
 * 布局渲染器（§8 / 提示词6）：读 layout.sections，经注册表 type→组件分发。
 * 两模板共用注册表，仅色板/主题类不同；文案实时来自叙事 plan，照片宽高比来自资产。
 * 也供阶段6 静态 HTML 导出（renderToStaticMarkup）复用。
 */
export function LayoutRenderer({
  layout,
  narrative,
  photos,
  exhibitionId,
}: {
  layout: ExhibitionLayoutT;
  narrative: NarrativeDTO;
  photos: PhotoAsset[];
  exhibitionId: string;
}) {
  const ctx: RenderCtx = {
    exhibitionId,
    photos: new Map(photos.map((p) => [p.id, p])),
    chapters: new Map(narrative.chapters.map((c) => [c.id, c])),
    narrative,
    template: layout.template,
  };
  return (
    <div
      className={`exhibition-root template-${layout.template}`}
      style={{ background: layout.background, color: layout.text_color }}
    >
      {layout.sections.map((s) => {
        const Section = SECTION_REGISTRY[s.type];
        return <Section key={s.id} section={s} ctx={ctx} />;
      })}
    </div>
  );
}