import "phaser";
import Entity, { EntityType } from "./Entity";
import WorldScene from "../scenes/WorldScene";
import {
  NpcAffinityByNpcId,
  NpcGender,
  NpcInventory,
  NpcRuntimeTile,
  NpcSnapshot,
  NpcSpawnPoint,
} from "../types/Npc";
import { getTilePosition } from "../utils/tileUtils";

export default class Npc extends Entity {
  unitType = EntityType.PNJ;
  isNameAlwaysVisible = true;
  animationKey = "other-player";

  gender: NpcGender = "unknown";
  soul: string = "";
  personaTags: string[] = [];
  spawn: NpcSpawnPoint = { x: 0, y: 0 };
  runtimeTile?: NpcRuntimeTile;
  memorySummary: string = "";
  alive: boolean = true;
  inventory: NpcInventory = {};
  affinityByNpcId: NpcAffinityByNpcId = {};
  hpText: Phaser.GameObjects.Text;

  constructor(scene: WorldScene, navMesh: unknown, snapshot: NpcSnapshot) {
    super(scene, snapshot.spawn.x, snapshot.spawn.y, navMesh, "other-player", 1);
    this.hpText = new Phaser.GameObjects.Text(this.scene, 0, 0, "", {
      fontSize: "8",
      color: "#ffb3b3",
    });
    this.hpText.setOrigin(0.5, 1.2);
    this.scene.add.existing(this.hpText);
    this.add(this.hpText);
    this.applySnapshot(snapshot, { syncPosition: true });
    this.nameText.setVisible(this.isNameAlwaysVisible);
    this.hpText.setVisible(true);
  }

  public applySnapshot(
    snapshot: NpcSnapshot,
    options: { syncPosition?: boolean } = {}
  ): void {
    const shouldSyncPosition = options.syncPosition !== false;
    this.id = snapshot.id;
    this.gender = snapshot.gender;
    this.soul = snapshot.soul;
    this.personaTags = [...snapshot.personaTags];
    this.spawn = { ...snapshot.spawn };
    this.runtimeTile = snapshot.runtimeTile
      ? { ...snapshot.runtimeTile }
      : undefined;
    if (shouldSyncPosition) {
      const displayTile = this.runtimeTile || this.spawn;
      const displayPosition = getTilePosition(displayTile.x, displayTile.y);
      this.setPosition(displayPosition.x, displayPosition.y);
    }
    this.memorySummary = snapshot.memorySummary;
    this.hp = snapshot.hp;
    this.alive = snapshot.alive;
    this.inventory = { ...snapshot.inventory };
    this.affinityByNpcId = { ...snapshot.affinityByNpcId };
    this.setName(snapshot.name);
    this.updateHpText();
  }

  public toSnapshot(): NpcSnapshot {
    return {
      id: this.id,
      name: this.unitName,
      gender: this.gender,
      soul: this.soul,
      personaTags: [...this.personaTags],
      spawn: { ...this.spawn },
      runtimeTile: this.runtimeTile ? { ...this.runtimeTile } : undefined,
      memorySummary: this.memorySummary,
      hp: this.hp,
      alive: this.alive,
      inventory: { ...this.inventory },
      affinityByNpcId: { ...this.affinityByNpcId },
    };
  }

  private updateHpText(): void {
    this.hpText.setText(`HP: ${Math.max(0, this.hp)}/3`);
    this.hpText.setColor(this.alive ? "#ffb3b3" : "#808080");
  }
}
