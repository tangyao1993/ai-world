export type NpcGender = "male" | "female" | "non_binary" | "unknown";

export interface NpcSpawnPoint {
  x: number;
  y: number;
}

export interface NpcSnapshot {
  id: string;
  name: string;
  gender: NpcGender;
  soul: string;
  personaTags: string[];
  spawn: NpcSpawnPoint;
  memorySummary: string;
}

export interface NpcCreateRequest {
  id: string;
  name: string;
  gender: NpcGender;
  soul: string;
  personaTags: string[];
}

export interface CreateNpcSnapshotInput
  extends Partial<Omit<NpcSnapshot, "spawn">> {
  spawn?: Partial<NpcSpawnPoint>;
}

export function createNpcSnapshot(
  input: CreateNpcSnapshotInput = {}
): NpcSnapshot {
  return {
    id: input.id ?? "npc-unknown",
    name: input.name ?? "NPC",
    gender: input.gender ?? "unknown",
    soul: input.soul ?? "",
    personaTags: input.personaTags ? [...input.personaTags] : [],
    spawn: {
      x: input.spawn?.x ?? 0,
      y: input.spawn?.y ?? 0,
    },
    memorySummary: input.memorySummary ?? "",
  };
}
