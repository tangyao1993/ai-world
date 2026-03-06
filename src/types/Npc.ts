export type NpcGender = "male" | "female" | "non_binary" | "unknown";
export type NpcInventory = Record<string, number>;
export type NpcAffinityByNpcId = Record<string, number>;

export interface NpcSpawnPoint {
  x: number;
  y: number;
}

export interface NpcRuntimeTile {
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
  runtimeTile?: NpcRuntimeTile;
  memorySummary: string;
  hp: number;
  alive: boolean;
  inventory: NpcInventory;
  affinityByNpcId: NpcAffinityByNpcId;
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
  const runtimeTile =
    Number.isInteger(input.runtimeTile?.x) &&
    Number.isInteger(input.runtimeTile?.y)
      ? {
          x: input.runtimeTile.x,
          y: input.runtimeTile.y,
        }
      : undefined;

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
    runtimeTile,
    memorySummary: input.memorySummary ?? "",
    hp: Number.isFinite(input.hp) ? Math.max(0, Math.floor(input.hp as number)) : 3,
    alive: typeof input.alive === "boolean" ? input.alive : true,
    inventory:
      input.inventory && typeof input.inventory === "object"
        ? { ...input.inventory }
        : {},
    affinityByNpcId:
      input.affinityByNpcId && typeof input.affinityByNpcId === "object"
        ? { ...input.affinityByNpcId }
        : {},
  };
}
