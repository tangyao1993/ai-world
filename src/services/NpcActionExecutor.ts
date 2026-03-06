import "phaser";
import { Tilemaps } from "phaser";
import * as CONFIG from "../gameConfig.json";
import Npc from "../models/Npc";
import Entity from "../models/Entity";
import ResourceEntity from "../models/ResourceEntity";
import {
  NpcAction,
  NpcLookDirection,
  ValidationIssue,
  validateNpcActionList,
} from "../npc/NpcActionProtocol";
import { Position } from "../types/Positions";
import { ActionType } from "../types/Actions";
import EntityActionManager, {
  EntityAction,
  PendingEntityAction,
} from "./EntityActionManager";
import type WorldScene from "../scenes/WorldScene";

const WAIT_ACTION_TYPE = "action.npc.wait";
const FALLBACK_WAIT_MS = 1000;

export interface NpcActionExecutionError {
  code: string;
  message: string;
  field?: string;
  actionIndex?: number;
  actionType?: string;
}

export interface NpcActionExecutionResult {
  ok: boolean;
  npcId: string;
  acceptedActions: number;
  queuedActions: number;
  fallbackApplied: boolean;
  errors: NpcActionExecutionError[];
}

type PendingActionBuildResult =
  | { ok: true; value: PendingEntityAction[] }
  | { ok: false; error: NpcActionExecutionError };

export default class NpcActionExecutor {
  private scene: WorldScene;
  private entityActions: EntityActionManager;

  constructor(scene: WorldScene) {
    this.scene = scene;
    this.entityActions = scene.entityActions;
  }

  executeActions(npcId: string, rawActions: unknown): NpcActionExecutionResult {
    const normalizedNpcId = typeof npcId === "string" ? npcId.trim() : "";
    const npc = normalizedNpcId ? this.scene.npcs[normalizedNpcId] : undefined;

    if (!npc) {
      return {
        ok: false,
        npcId: normalizedNpcId || String(npcId || ""),
        acceptedActions: 0,
        queuedActions: 0,
        fallbackApplied: false,
        errors: [
          {
            code: "NPC_NOT_FOUND",
            message: `Npc "${normalizedNpcId || npcId}" does not exist.`,
            field: "npcId",
          },
        ],
      };
    }

    const validationResult = validateNpcActionList(rawActions);
    if ("errors" in validationResult) {
      this.applyFallbackWait(npc);

      return {
        ok: false,
        npcId: npc.id,
        acceptedActions: 0,
        queuedActions: 0,
        fallbackApplied: true,
        errors: validationResult.errors.map((issue) =>
          this.validationIssueToError(issue)
        ),
      };
    }

    const actions = validationResult.value;
    if (actions.length <= 0) {
      return {
        ok: true,
        npcId: npc.id,
        acceptedActions: 0,
        queuedActions: 0,
        fallbackApplied: false,
        errors: [],
      };
    }

    let queuedActions = 0;

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const buildResult = this.buildPendingActions(npc, action, index);

      if ("error" in buildResult) {
        this.applyFallbackWait(npc);

        return {
          ok: false,
          npcId: npc.id,
          acceptedActions: index,
          queuedActions,
          fallbackApplied: true,
          errors: [buildResult.error],
        };
      }

      for (const pendingAction of buildResult.value) {
        if (queuedActions === 0) {
          this.entityActions.processNow(npc, pendingAction);
        } else {
          this.entityActions.enqueue(npc, pendingAction);
        }

        queuedActions += 1;
      }
    }

    return {
      ok: true,
      npcId: npc.id,
      acceptedActions: actions.length,
      queuedActions,
      fallbackApplied: false,
      errors: [],
    };
  }

  private buildPendingActions(
    npc: Npc,
    action: NpcAction,
    index: number
  ): PendingActionBuildResult {
    switch (action.type) {
      case "MOVE_TO": {
        const targetTile = this.resolveTile(action.x, action.y);
        if (!targetTile) {
          return {
            ok: false,
            error: {
              code: "TILE_NOT_FOUND",
              message: `Target tile (${action.x}, ${action.y}) does not exist.`,
              actionIndex: index,
              actionType: action.type,
            },
          };
        }

        if (!this.canReachTile(npc, targetTile)) {
          return {
            ok: false,
            error: {
              code: "TARGET_UNREACHABLE",
              message: `Target tile (${action.x}, ${action.y}) is unreachable.`,
              actionIndex: index,
              actionType: action.type,
            },
          };
        }

        return {
          ok: true,
          value: [this.createGoToAction(targetTile)],
        };
      }
      case "SAY":
        return {
          ok: true,
          value: [
            {
              type: ActionType.NPC_SAY,
              args: [action],
            },
          ],
        };
      case "LOOK_AT": {
        if (action.targetEntityId) {
          const target = this.resolveTargetEntity(action.targetEntityId);
          if (!target) {
            return {
              ok: false,
              error: {
                code: "LOOK_TARGET_NOT_FOUND",
                message: `LOOK_AT target "${action.targetEntityId}" does not exist.`,
                actionIndex: index,
                actionType: action.type,
              },
            };
          }

          return {
            ok: true,
            value: [
              {
                type: ActionType.NPC_LOOK_AT,
                args: [{ target }],
              },
            ],
          };
        }

        if (!action.direction) {
          return {
            ok: false,
            error: {
              code: "LOOK_DIRECTION_MISSING",
              message: "LOOK_AT direction is missing.",
              actionIndex: index,
              actionType: action.type,
            },
          };
        }

        return {
          ok: true,
          value: [
            {
              type: ActionType.NPC_LOOK_AT,
              args: [{ direction: this.mapLookDirection(action.direction) }],
            },
          ],
        };
      }
      case "WAIT":
        return {
          ok: true,
          value: [this.createWaitAction(action.durationMs)],
        };
      case "INTERACT": {
        const target = this.resolveTargetEntity(action.targetEntityId);
        if (!target) {
          return {
            ok: false,
            error: {
              code: "INTERACT_TARGET_NOT_FOUND",
              message: `INTERACT target "${action.targetEntityId}" does not exist.`,
              actionIndex: index,
              actionType: action.type,
            },
          };
        }

        return this.buildMoveNearTargetActions(npc, target, index, action.type);
      }
      case "COLLECT": {
        const resource = this.resolveResource(action.resourceId);
        if (!resource) {
          return {
            ok: false,
            error: {
              code: "COLLECT_RESOURCE_NOT_FOUND",
              message: `COLLECT resource "${action.resourceId}" does not exist.`,
              actionIndex: index,
              actionType: action.type,
            },
          };
        }

        if (resource.level < CONFIG.RESOURCE_MAX_LEVEL) {
          return {
            ok: false,
            error: {
              code: "COLLECT_RESOURCE_NOT_READY",
              message: `COLLECT resource "${action.resourceId}" is not ready (level=${resource.level}).`,
              actionIndex: index,
              actionType: action.type,
            },
          };
        }

        const interactionBuild = this.buildMoveNearTargetActions(
          npc,
          resource,
          index,
          action.type
        );
        if (!interactionBuild.ok) return interactionBuild;

        return {
          ok: true,
          value: [
            ...interactionBuild.value,
            {
              type: ActionType.RESOURCE_COLLECT,
              args: [resource],
            },
          ],
        };
      }
      default:
        return {
          ok: false,
          error: {
            code: "ACTION_NOT_SUPPORTED",
            message: `Action "${(action as NpcAction).type}" is not supported.`,
            actionIndex: index,
            actionType: (action as NpcAction).type,
          },
        };
    }
  }

  private validationIssueToError(issue: ValidationIssue): NpcActionExecutionError {
    const actionIndexMatch = /actions\[(\d+)\]/.exec(issue.field);
    const actionIndex = actionIndexMatch ? Number(actionIndexMatch[1]) : undefined;

    return {
      code: issue.code,
      message: issue.message,
      field: issue.field,
      actionIndex: Number.isInteger(actionIndex) ? actionIndex : undefined,
    };
  }

  private createWaitAction(durationMs: number): PendingEntityAction {
    return {
      type: WAIT_ACTION_TYPE,
      args: [durationMs],
      isCompleted: (queuedAction: EntityAction) => {
        const elapsed = Date.now() - queuedAction.startedDate;
        return elapsed >= durationMs;
      },
    };
  }

  private createGoToAction(targetTile: Tilemaps.Tile): PendingEntityAction {
    return {
      type: ActionType.NPC_GO_TO,
      args: [targetTile],
      isCompleted: (_queuedAction: EntityAction, unit: Entity) => {
        const currentTile = unit.getTile();
        return (
          !!currentTile &&
          currentTile.x === targetTile.x &&
          currentTile.y === targetTile.y
        );
      },
    };
  }

  private buildMoveNearTargetActions(
    npc: Npc,
    target: Entity,
    index: number,
    actionType: NpcAction["type"]
  ): PendingActionBuildResult {
    const npcPos = new Phaser.Geom.Point(npc.x, npc.y);
    const tileNextToTarget = target.getNearestFreeTile(npcPos);

    if (!tileNextToTarget) {
      return {
        ok: false,
        error: {
          code: "TARGET_NEIGHBOR_TILE_NOT_FOUND",
          message: `Target "${target.id}" has no nearby walkable tile.`,
          actionIndex: index,
          actionType,
        },
      };
    }

    if (!this.canReachTile(npc, tileNextToTarget)) {
      return {
        ok: false,
        error: {
          code: "TARGET_UNREACHABLE",
          message: `Target "${target.id}" is unreachable.`,
          actionIndex: index,
          actionType,
        },
      };
    }

    return {
      ok: true,
      value: [
        this.createGoToAction(tileNextToTarget),
        {
          type: ActionType.NPC_LOOK_AT,
          args: [{ target }],
        },
      ],
    };
  }

  private applyFallbackWait(npc: Npc): void {
    this.entityActions.processNow(npc, this.createWaitAction(FALLBACK_WAIT_MS));
  }

  private resolveTile(x: number, y: number): Tilemaps.Tile | null {
    return this.scene.map.getTileAt(x, y, false, this.scene.mapLayers["grass"]);
  }

  private canReachTile(npc: Npc, tile: Tilemaps.Tile): boolean {
    if (!this.scene.navMesh || !npc.body) return true;

    const start = new Phaser.Math.Vector2(
      npc.body.x + npc.body.width / 2,
      npc.body.y + npc.body.height / 2
    );
    const target = new Phaser.Math.Vector2(
      tile.pixelX + CONFIG.TILE_SIZE / 2,
      tile.pixelY + CONFIG.TILE_SIZE / 2
    );
    const path = this.scene.navMesh.findPath(start, target);

    return Array.isArray(path) && path.length > 0;
  }

  private resolveTargetEntity(entityId: string): Entity | null {
    const normalizedId = entityId.trim();
    if (!normalizedId) return null;

    if (this.scene.player && this.scene.player.id === normalizedId) {
      return this.scene.player;
    }

    if (this.scene.otherPlayers[normalizedId]) {
      return this.scene.otherPlayers[normalizedId];
    }

    if (this.scene.npcs[normalizedId]) {
      return this.scene.npcs[normalizedId];
    }

    const resource = this.resolveResource(normalizedId);
    if (resource) return resource;

    return null;
  }

  private resolveResource(resourceId: string): ResourceEntity | null {
    const normalizedId = resourceId.trim();
    if (!normalizedId) return null;

    if (this.scene.resources[normalizedId]) {
      return this.scene.resources[normalizedId];
    }

    const matchedByResourceId = Object.values(this.scene.resources).find(
      (resource) => String(resource.resourceId) === normalizedId
    );
    return matchedByResourceId || null;
  }

  private mapLookDirection(direction: NpcLookDirection): Position {
    switch (direction) {
      case "UP":
        return Position.UP;
      case "LEFT":
        return Position.LEFT;
      case "RIGHT":
        return Position.RIGHT;
      case "DOWN":
      default:
        return Position.DOWN;
    }
  }
}
