import "phaser";
import Entity, { EntityType } from "./Entity";
import WorldScene from "../scenes/WorldScene";
import { NpcGender, NpcSnapshot, NpcSpawnPoint } from "../types/Npc";
import { getTilePosition } from "../utils/tileUtils";

export default class Npc extends Entity {
  unitType = EntityType.PNJ;
  isNameAlwaysVisible = true;
  animationKey = "other-player";

  gender: NpcGender = "unknown";
  soul: string = "";
  personaTags: string[] = [];
  spawn: NpcSpawnPoint = { x: 0, y: 0 };
  memorySummary: string = "";

  constructor(scene: WorldScene, navMesh: unknown, snapshot: NpcSnapshot) {
    super(scene, snapshot.spawn.x, snapshot.spawn.y, navMesh, "other-player", 1);
    this.applySnapshot(snapshot);
    this.nameText.setVisible(this.isNameAlwaysVisible);
  }

  public applySnapshot(snapshot: NpcSnapshot): void {
    this.id = snapshot.id;
    this.gender = snapshot.gender;
    this.soul = snapshot.soul;
    this.personaTags = [...snapshot.personaTags];
    this.spawn = { ...snapshot.spawn };
    const spawnPosition = getTilePosition(snapshot.spawn.x, snapshot.spawn.y);
    this.setPosition(spawnPosition.x, spawnPosition.y);
    this.memorySummary = snapshot.memorySummary;
    this.setName(snapshot.name);
  }

  public toSnapshot(): NpcSnapshot {
    return {
      id: this.id,
      name: this.unitName,
      gender: this.gender,
      soul: this.soul,
      personaTags: [...this.personaTags],
      spawn: { ...this.spawn },
      memorySummary: this.memorySummary,
    };
  }
}
