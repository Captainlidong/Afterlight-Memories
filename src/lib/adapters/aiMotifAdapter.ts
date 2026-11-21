import { z } from "zod";
import { Motif, MotifResult } from "../agents/schemas";
import { AiBusinessValidationError } from "../ai/errors";
import { assertVisualFacts, createTextRunner, type AiTextAdapterOptions } from "./aiTextAdapter";
import type { MotifAdapter } from "./types";

const responseSchema = MotifResult.extend({
  motifs: z.array(Motif.omit({ id: true }).extend({
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(100),
    photo_ids: z.array(z.string().min(1)).min(1).max(60),
    evidence: z.array(z.string().trim().min(1).max(300)).min(2).max(120),
    alternative_readings: z.array(z.string().trim().min(1).max(100)).max(4).default([]),
  }).strict()).max(4),
}).strict();

export function createAiMotifAdapter(options: AiTextAdapterOptions): MotifAdapter {
  const run = createTextRunner(options, "motifs");
  return {
    async discover(input) {
      assertVisualFacts(input.photos);
      const allowed = new Set(input.photos.map((p) => p.photoId));
      const result = await run(input, (value) => {
        const parsed = responseSchema.parse(value);
        const titles = parsed.motifs.map((m) => m.title.replace(/\s/g, ""));
        if (new Set(titles).size !== titles.length) throw new AiBusinessValidationError();
        for (const motif of parsed.motifs) {
          if (new Set(motif.photo_ids).size !== motif.photo_ids.length || motif.photo_ids.some((id) => !allowed.has(id))) {
            throw new AiBusinessValidationError();
          }
          const evidence = motif.evidence.map((e) => {
            const photoId = motif.photo_ids.find((id) => e.startsWith(`[${id}] `));
            return { photoId, observation: photoId ? e.slice(photoId.length + 3).trim() : "" };
          });
          const normalized = evidence.map((e) => `${e.photoId}|${e.observation.replace(/\s/g, "")}`);
          if (new Set(normalized).size !== normalized.length ||
            evidence.some((e) => !e.photoId || !e.observation)) {
            throw new AiBusinessValidationError();
          }
        }
        return parsed;
      });
      return { ...result.data, provenance: result.provenance };
    },
  };
}
