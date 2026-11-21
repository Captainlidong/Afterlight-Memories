import { z } from "zod";
import { CurationDecision, CurationResult } from "../agents/schemas";
import { AiBusinessValidationError } from "../ai/errors";
import { assertVisualFacts, createTextRunner, type AiTextAdapterOptions } from "./aiTextAdapter";
import type { CurationAdapter } from "./types";

const responseSchema = CurationResult.extend({
  decisions: z.array(CurationDecision.extend({
    reasons: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
    related_photo_ids: z.array(z.string().min(1)).max(60).default([]),
    user_override_allowed: z.literal(true).default(true),
  }).strict()).max(60),
}).strict();

export function createAiCurationAdapter(options: AiTextAdapterOptions): CurationAdapter {
  const run = createTextRunner(options, "curation");
  return {
    async curate(input) {
      assertVisualFacts(input.photos);
      const allowed = new Set(input.photos.map((p) => p.photoId));
      const result = await run(input, (value) => {
        const parsed = responseSchema.parse(value);
        const ids = parsed.decisions.map((d) => d.photo_id);
        if (ids.length !== allowed.size || new Set(ids).size !== ids.length ||
          parsed.decisions.some((d) => !allowed.has(d.photo_id) ||
            new Set(d.related_photo_ids).size !== d.related_photo_ids.length ||
            d.related_photo_ids.some((id) => !allowed.has(id)))) {
          throw new AiBusinessValidationError();
        }
        return parsed;
      });
      return { ...result.data, provenance: result.provenance };
    },
  };
}
