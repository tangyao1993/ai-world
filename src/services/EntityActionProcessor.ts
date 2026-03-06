import EventDispatcher from './EventDispatcher';
import EventListener from './EventListenerInterface';
import Entity from '../models/Entity';
import { HasInventory } from '../systems/InventorySystem';
import InventoryItem from '../models/InventoryItem';
import ResourceEntity from '../models/ResourceEntity';
import { SayAction } from '../npc/NpcActionProtocol';
import { Position } from '../types/Positions';
import { ActionType, ServerEvent } from '../types/Actions';
import CONFIG from "../gameConfig.json";

type NpcLookPayload = {
  target?: Entity;
  direction?: Position;
};

function canAddInventory(
  inventory: unknown
): inventory is { add: (item: InventoryItem) => void } {
  return !!inventory && typeof (inventory as { add?: unknown }).add === "function";
}

export default class EntityActionProcessor implements EventListener {
    emitter = EventDispatcher.getInstance();

    listen() {
      // Player move
      this.emitter.on(ActionType.ENTITY_GO_TO, (unit: Entity, tile: Phaser.Tilemaps.Tile) => {
        unit.goTo(tile);
      });

      // Move other players
      this.emitter.on(ServerEvent.ENTITY_MOVED, (unit: Entity, tile: Phaser.Tilemaps.Tile) => {
        unit.goTo(tile);
      });

      this.emitter.on(ActionType.NPC_GO_TO, (unit: Entity, tile: Phaser.Tilemaps.Tile) => {
        unit.goTo(tile);
      });

      this.emitter.on(ActionType.NPC_SAY, (unit: Entity, payload: SayAction) => {
        const isPrivate = payload.channel === "npc_private" && !!payload.targetPlayerId;

        this.emitter.emit(ActionType.CHAT_SEND_MESSAGE, {
          author: unit.unitName || unit.id,
          message: payload.text,
          creationDate: Date.now(),
          channel: isPrivate ? "npc_private" : "world",
          targetPlayerId: isPrivate ? payload.targetPlayerId : undefined,
          npcId: unit.id,
          npcName: unit.unitName || unit.id,
        });
      });

      this.emitter.on(ActionType.NPC_LOOK_AT, (unit: Entity, payload: NpcLookPayload) => {
        if (payload?.target) {
          unit.lookAt(payload.target);
          return;
        }

        if (payload?.direction === undefined) return;

        unit.animate(payload.direction);
        unit.unitSprite.anims.stop();
      });

      this.emitter.on(ActionType.RESOURCE_COLLECT, (unit: Entity & HasInventory, object: ResourceEntity) => {
        if (object.level < CONFIG.RESOURCE_MAX_LEVEL) return;

        // Look at object
        unit.lookAt(object);

        if (canAddInventory(unit.inventory)) {
          // Create inventory's item and add it to unit's inventory
          const itemInventory = new InventoryItem(object.item, object.itemQuantity);
          unit.inventory.add(itemInventory);

          // Increase harvesting skill
          if (object.harvestingSkill) {
            this.emitter.emit(ActionType.SKILL_INCREASE, unit, object.harvestingSkill, object.harvestingSkillXp)
          }
        }
      });

      this.emitter.on(ActionType.ACTION_PROGRESS, (owner: Entity, progress: number, target: Entity) => {
        target.displayProgress(progress);
      });
    }
}
