import { ActionType, ServerEvent } from "../types/Actions";
import EventDispatcher from "./EventDispatcher";
import EventListener from "./EventListenerInterface";
import {
  ChatMessage,
  NpcBrainDecisionRequest,
  NpcChatRequest,
} from "../types/Chat";
import { Tilemaps } from "phaser";
import Player from "../models/Player";
import WorldScene from "../scenes/WorldScene";
import OtherPlayer from "../models/OtherPlayer";
import ResourceEntity from "../models/ResourceEntity";
import { NpcCreateRequest, NpcSnapshot } from "../types/Npc";
import { NpcActionExecutionResult } from "./NpcActionExecutor";

type NpcActionExecutionMeta = {
  executionId?: string;
  ownerSocketId?: string;
  decisionAt?: number;
};

export default class ServerConnectorService implements EventListener {
  server: any;
  world: WorldScene;
  emitter: EventDispatcher;

  constructor(server: any, world: WorldScene, eventEmitter: EventDispatcher) {
    this.server = server;
    this.world = world;
    this.emitter = eventEmitter;
  }

  public listen() {
    this.listenServerEvents();
    this.listenActions();
  }

  listenActions() {
    this.emitter.on(
      ActionType.CHAT_SEND_MESSAGE,
      (chatmessage: ChatMessage) => {
        this.server.emit("chat.sendNewMessage", {
          ...chatmessage,
          channel: chatmessage.channel || "world",
        });
      }
    );
    this.emitter.on(
      ActionType.CHAT_SEND_NPC_MESSAGE,
      (request: NpcChatRequest) => {
        this.server.emit("npc.chat.send", request);
      }
    );
    this.emitter.on(
      ActionType.NPC_BRAIN_DECIDE,
      (request: NpcBrainDecisionRequest) => {
        this.server.emit("npc.brain.decide", request);
      }
    );
    this.emitter.on(ActionType.NPC_CREATE, (request: NpcCreateRequest) => {
      this.server.emit("npc.create", request);
    });
    this.emitter.on(
      ActionType.ENTITY_GO_TO,
      (_player: Player, tile: Tilemaps.Tile) => {
        this.server.emit("playerMove", tile.x, tile.y);
      }
    );
    this.emitter.on(
      ActionType.RESOURCE_COLLECT,
      (_player: Player, resource: ResourceEntity) => {
        this.server.emit("resource.collect", resource.resourceId);
      }
    );
  }

  listenServerEvents() {
    // Player/current-players
    this.server.on("currentPlayers", (players: any) => {
      for (const playerId in players) {
        const otherPlayer = players[playerId];

        if (otherPlayer.id === this.world.player.id) continue;

        const newPlayer = new OtherPlayer(
          this.world,
          otherPlayer.x,
          otherPlayer.y,
          this.world.navMesh
        );
        newPlayer.id = otherPlayer.id;
        newPlayer.name = otherPlayer.name;
        this.world.otherPlayers[otherPlayer.id] = newPlayer;
        this.world.entityActions.registerEntity(newPlayer);
      }
    });

    // NPC/current-npcs
    this.server.on("currentNpcs", (npcs: { [key: string]: NpcSnapshot }) => {
      this.world.syncNpcs(npcs || {});
    });

    // Resources/current-resources
    this.server.on("currentResources", (resources: any) => {
      // Create Resources from data map
      Object.values(resources).forEach((object: any) => {
        const tile = this.world.map.getTileAtWorldXY(
          object.x,
          object.y,
          false,
          this.world.cameras.main,
          this.world.mapLayers["grass"]
        );
        const resource = new ResourceEntity(
          this.world,
          tile.x,
          tile.y,
          object.type
        );
        resource.grow(object.level);
        resource.resourceId = object.id;

        this.world.resources[object.id] = resource;
      });
    });

    // Player/new-player
    this.server.on("newPlayer", (newPlayer: any) => {
      const player = new OtherPlayer(
        this.world,
        newPlayer.x,
        newPlayer.y,
        this.world.navMesh
      );
      player.id = newPlayer.id;
      player.name = newPlayer.name;
      this.world.otherPlayers[newPlayer.id] = player;
      this.world.entityActions.registerEntity(player);
    });

    // player/disconnected
    this.server.on("playerDisconnected", (disconnectedPlayer: any) => {
      const player = this.world.otherPlayers[disconnectedPlayer.id];
      if (!player) return;

      this.world.entityActions.unregisterEntity(disconnectedPlayer.id);
      player.destroy(true);

      delete this.world.otherPlayers[disconnectedPlayer.id];
    });

    // # Entity/moved
    this.server.on("playerMoved", (player: any) => {
      const playerToMove =
        player.id === this.world.player.id
          ? this.world.player
          : this.world.otherPlayers[player.id];
      if (!playerToMove) return;

      const tile = this.world.map.getTileAt(
        player.x,
        player.y,
        false,
        this.world.mapLayers["grass"]
      );
      if (!tile) return;

      this.world.entityActions.processNow(playerToMove, {
        type: ServerEvent.ENTITY_MOVED,
        args: [tile],
      });
    });

    // # Chat/new-message
    this.server.on("chat.newMessage", (newMessages: ChatMessage[]) => {
      this.emitter.emit(ServerEvent.CHAT_NEW_MESSAGE, newMessages);
    });

    // # Resource/grown
    this.server.on("resource.grown", (resourceId: string, newLevel: number) => {
      const resource = this.world.resources[resourceId];
      if (!resource) return;

      resource.grow(newLevel);
    });

    // NPC/lifecycle
    this.server.on(
      "npc.executeActions",
      (npcId: string, actions: unknown, meta?: NpcActionExecutionMeta) => {
        const result = this.world.executeNpcActions(npcId, actions);
        if (!result.ok) {
          console.warn("[NpcActionExecutor] npc.executeActions failed:", result);
        }

        this.reportNpcExecutionResult(npcId, result, meta);
      }
    );

    this.server.on("npc.created", (snapshot: NpcSnapshot) => {
      if (!snapshot) return;

      this.world.upsertNpc(snapshot);
    });

    this.server.on("npc.updated", (snapshot: NpcSnapshot) => {
      if (!snapshot) return;

      this.world.upsertNpc(snapshot);
    });

    this.server.on("npc.removed", (npcId: string) => {
      this.world.removeNpc(npcId);
    });
  }

  private reportNpcExecutionResult(
    npcId: string,
    result: NpcActionExecutionResult,
    meta?: NpcActionExecutionMeta
  ) {
    const executionId =
      typeof meta?.executionId === "string" ? meta.executionId.trim() : "";
    if (!executionId) return;

    const ownerSocketId =
      typeof meta?.ownerSocketId === "string" ? meta.ownerSocketId.trim() : "";
    const localSocketId = this.world.player?.id;
    if (ownerSocketId && localSocketId !== ownerSocketId) return;

    this.server.emit("npc.executionResult", {
      executionId,
      npcId,
      clientFinishedAt: Date.now(),
      decisionAt: meta?.decisionAt,
      result: {
        ok: result.ok,
        acceptedActions: result.acceptedActions,
        queuedActions: result.queuedActions,
        fallbackApplied: result.fallbackApplied,
        errors: result.errors,
      },
    });
  }
}
