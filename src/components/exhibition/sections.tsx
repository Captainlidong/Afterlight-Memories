import type { ComponentType } from "react";
import type { LayoutSectionT, ChapterT, TemplateT } from "@/lib/agents/schemas";
import type { NarrativeDTO, PhotoAsset } from "@/types";
import { ExhibitionImage } from "./ExhibitionImage";
import { Reveal } from "./Reveal";

/** 渲染上下文：照片/章节查找表 + 叙事（文案实时读取）+ 模板。两模板共用本注册表，仅主题不同。 */
export interface RenderCtx {
  exhibitionId: string;
  photos: Map<string, PhotoAsset>;
  chapters: Map<string, ChapterT>;
  narrative: NarrativeDTO;
  template: TemplateT;
}

export interface SectionProps {
  section: LayoutSectionT;
  ctx: RenderCtx;
}

const SPACING: Record<"small" | "medium" | "large", string> = {
  small: "py-6 md:py-10",
  medium: "py-12 md:py-20",
  large: "py-20 md:py-36",
};
const GAP: Record<"small" | "medium" | "large", string> = {
  small: "gap-2 md:gap-3",
  medium: "gap-4 md:gap-6",
  large: "gap-8 md:gap-12",
};
const SIZE: Record<"medium" | "large" | "full", string> = {
  medium: "max-w-2xl",
  large: "max-w-4xl",
  full: "max-w-6xl",
};

function HeroSection({ section, ctx }: SectionProps) {
  if (section.type !== "hero") return null;
  const photo = ctx.photos.get(section.photo_id);
  return (
    <section id={section.id} className="exhibition-section relative flex items-center justify-center" style={{ height: section.height }}>
      <ExhibitionImage photo={photo} exhibitionId={ctx.exhibitionId} fill className="absolute inset-0" alt={ctx.narrative.title} />
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 p-6 pt-16 md:p-12 md:pt-24 ${section.caption_position === "bottom-left" ? "text-left" : "text-center"}`}
        style={{ color: "#f5f1e8", background: "linear-gradient(to top, rgba(16,17,20,0.85), rgba(16,17,20,0.55) 55%, rgba(16,17,20,0))" }}
      >
        <h1 className="font-display text-3xl md:text-5xl" style={{ textShadow: "0 2px 24px rgba(0,0,0,0.55)" }}>{ctx.narrative.title}</h1>
        {ctx.narrative.subtitle && (
          <p className="mt-3 max-w-xl text-sm md:text-base opacity-80" style={{ textShadow: "0 1px 12px rgba(0,0,0,0.6)" }}>{ctx.narrative.subtitle}</p>
        )}
      </div>
    </section>
  );
}

function ChapterIntroSection({ section, ctx }: SectionProps) {
  if (section.type !== "chapter_intro") return null;
  const ch = ctx.chapters.get(section.chapter_id);
  if (!ch) return null;
  return (
    <Reveal id={section.id} className={`exhibition-section ${SPACING[section.spacing]} px-6`}>
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="font-display text-2xl md:text-4xl">{ch.title}</h2>
        {ch.description && <p className="mx-auto mt-4 max-w-prose text-sm md:text-base leading-relaxed opacity-70">{ch.description}</p>}
      </div>
    </Reveal>
  );
}

function SingleImageSection({ section, ctx }: SectionProps) {
  if (section.type !== "single_image") return null;
  const photo = ctx.photos.get(section.photo_id);
  return (
    <Reveal id={section.id} className={`exhibition-section ${SPACING[section.spacing]} px-4 md:px-6`}>
      <ExhibitionImage photo={photo} exhibitionId={ctx.exhibitionId} className={`mx-auto w-full ${SIZE[section.size]}`} />
    </Reveal>
  );
}

function ImagePairSection({ section, ctx }: SectionProps) {
  if (section.type !== "image_pair") return null;
  const [a, b] = section.photo_ids;
  return (
    <Reveal id={section.id} className={`exhibition-section ${SPACING.medium} px-4 md:px-6`}>
      <div className={`mx-auto grid max-w-5xl grid-cols-5 items-center ${GAP[section.gap]}`}>
        <ExhibitionImage photo={ctx.photos.get(a)} exhibitionId={ctx.exhibitionId} className="col-span-3 w-full" />
        <ExhibitionImage photo={ctx.photos.get(b)} exhibitionId={ctx.exhibitionId} className="col-span-2 w-full" />
      </div>
    </Reveal>
  );
}

function ImageGroupSection({ section, ctx }: SectionProps) {
  if (section.type !== "image_group") return null;
  const cols = Math.min(4, section.photo_ids.length);
  return (
    <Reveal id={section.id} className={`exhibition-section ${SPACING.medium} px-4 md:px-6`}>
      <div className={`mx-auto grid max-w-5xl grid-cols-2 ${GAP[section.gap]}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {section.photo_ids.map((id) => (
          <ExhibitionImage key={id} photo={ctx.photos.get(id)} exhibitionId={ctx.exhibitionId} variant="thumb" className="w-full" />
        ))}
      </div>
    </Reveal>
  );
}

function SpacerSection({ section }: SectionProps) {
  if (section.type !== "spacer") return null;
  return <div id={section.id} className={`exhibition-section ${SPACING[section.size]}`} aria-hidden="true" />;
}

function StatementSection({ section, ctx }: SectionProps) {
  if (section.type !== "statement") return null;
  const text = section.text_override ?? ctx.narrative.curatorial_statement;
  return (
    <Reveal id={section.id} className={`exhibition-section ${SPACING.large} px-6`}>
      <p className="mx-auto max-w-prose text-center font-display text-lg md:text-2xl leading-relaxed opacity-85">{text}</p>
    </Reveal>
  );
}

function EndingSection({ section, ctx }: SectionProps) {
  if (section.type !== "ending") return null;
  return (
    <Reveal id={section.id} className={`exhibition-section ${SPACING.large} px-4 md:px-6`}>
      <div className={`mx-auto flex max-w-4xl flex-col items-center ${GAP.medium}`}>
        {section.photo_ids.map((id) => (
          <ExhibitionImage key={id} photo={ctx.photos.get(id)} exhibitionId={ctx.exhibitionId} className="w-full max-w-3xl" />
        ))}
        <p className="mt-6 text-xs tracking-[0.3em] opacity-50">· 完 ·</p>
      </div>
    </Reveal>
  );
}

/** section 注册表：type → 组件。LayoutRenderer 据此分发，稳定 key = section.id。 */
export const SECTION_REGISTRY: Record<LayoutSectionT["type"], ComponentType<SectionProps>> = {
  hero: HeroSection,
  chapter_intro: ChapterIntroSection,
  single_image: SingleImageSection,
  image_pair: ImagePairSection,
  image_group: ImageGroupSection,
  spacer: SpacerSection,
  statement: StatementSection,
  ending: EndingSection,
};