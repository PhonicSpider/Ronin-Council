// Meshy (3D and image generation) shared definitions. Credit prices are ESTIMATES from Meshy's published pricing page
// and change over time; the real figure Meshy reports (consumed_credits) replaces the estimate once a task finishes.

export type MeshyKind = 'text_to_3d' | 'image_to_3d' | 'text_to_image';
export type MeshyQuality = 'draft' | 'standard';
export const MESHY_KINDS: MeshyKind[] = ['text_to_3d', 'image_to_3d', 'text_to_image'];

export const MESHY_PROMPT_MAX = 800;
export const MESHY_ABILITY = 'meshy';
/** Abilities an agent can be given besides its model. */
export const ABILITIES = [MESHY_ABILITY] as const;
export const isAbility = (v: unknown): v is (typeof ABILITIES)[number] => typeof v === 'string' && (ABILITIES as readonly string[]).includes(v);

export interface MeshySpec {
  kind: MeshyKind;
  quality: MeshyQuality;
  /** Add textures (a second paid step for text to 3D). */
  texture: boolean;
}

/** One paid step: what it is and what it should cost. */
export interface MeshyStep { label: string; credits: number }

/** The paid steps a request will take, with estimated credits. Draft uses Meshy's cheap "lite" models. */
export function meshySteps(spec: MeshySpec): MeshyStep[] {
  const draft = spec.quality === 'draft';
  switch (spec.kind) {
    case 'text_to_3d':
      return [
        { label: draft ? 'Model shape (draft, meshy-6-lite)' : 'Model shape (standard)', credits: draft ? 5 : 20 },
        ...(spec.texture ? [{ label: 'Texturing (2K)', credits: 10 }] : []),
      ];
    case 'image_to_3d':
      return [{
        label: `Model from image (${draft ? 'draft, meshy-6-lite' : 'standard'}${spec.texture ? ', textured 2K' : ', no texture'})`,
        credits: draft ? (spec.texture ? 15 : 5) : (spec.texture ? 30 : 20),
      }];
    case 'text_to_image':
      return [{ label: draft ? 'Image (nano-banana-2-lite)' : 'Image (nano-banana-2)', credits: draft ? 3 : 6 }];
  }
}
export const meshyEstimate = (spec: MeshySpec) => meshySteps(spec).reduce((n, s) => n + s.credits, 0);
