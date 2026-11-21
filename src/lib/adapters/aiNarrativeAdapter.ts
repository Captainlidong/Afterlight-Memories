import { z } from "zod";
import { Chapter, NarrativePlan, PlacementReason } from "../agents/schemas";
import { checkNarrativeCredibility } from "../agents/credibility";
import { AiBusinessValidationError } from "../ai/errors";
import { assertVisualFacts, createTextRunner, type AiTextAdapterOptions } from "./aiTextAdapter";
import type { NarrativeAdapter } from "./types";

const responseSchema = NarrativePlan.extend({
  selected_motif_id: z.string().min(1),
  title: z.string().trim().min(1).max(60),
  curatorial_statement: z.string().trim().min(1).max(100),
  chapters: z.array(Chapter.extend({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(100),
    photo_ids: z.array(z.string().min(1)).min(1).max(60),
    placement_reasons: z.array(PlacementReason.extend({ reason: z.string().trim().min(1).max(100) }).strict()).min(1).max(60),
    locked: z.literal(false).default(false),
  }).strict()).min(2).max(4),
}).strict();

export function createAiNarrativeAdapter(options: AiTextAdapterOptions): NarrativeAdapter {
  const run = createTextRunner(options, "narrative");
  return {
    async compose(input) {
      assertVisualFacts(input.photos);
      const result = await run(input, (value) => {
        const parsed = responseSchema.parse(value);
        const ids = new Set(parsed.chapters.flatMap((c) => c.photo_ids));
        if (input.requiredChapterIds?.some((id) => !parsed.chapters.some((c) => c.id === id))) {
          throw new AiBusinessValidationError();
        }
        if (parsed.selected_motif_id !== input.motif.motifId || parsed.tone !== input.tone) {
          throw new AiBusinessValidationError();
        }
        if (new Set(parsed.chapters.map((c) => c.id)).size !== parsed.chapters.length || input.mustKeepIds.some((id) => !ids.has(id))) {
          throw new AiBusinessValidationError();
        }
        for (const chapter of parsed.chapters) {
          const refs = [chapter.opening_photo_id, chapter.closing_photo_id, ...chapter.placement_reasons.map((r) => r.photo_id)];
          if (refs.some((id) => id != null && !chapter.photo_ids.includes(id))) {
            throw new AiBusinessValidationError();
          }
        }
        const report = checkNarrativeCredibility(parsed, { keepIds: input.photos.map((p) => p.photoId), motifPhotoIds: input.motif.photo_ids });
        if (!report.ok) throw new AiBusinessValidationError();
        return parsed;
      });
      return { ...result.data, provenance: result.provenance };
    },
  };
}
