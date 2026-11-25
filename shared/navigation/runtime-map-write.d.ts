import type { CollisionMap } from '../types.ts';
import type { freeTilesFor } from './knowledge.ts';

export function packRuntimeNavigation(map: CollisionMap, layers: ReturnType<typeof freeTilesFor>[],
  options?: { compact?: boolean; includeGraph?: boolean; graphSections?: readonly Uint8Array[] | null | undefined }): Uint8Array;
