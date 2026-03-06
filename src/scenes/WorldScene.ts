declare global {
  interface Window {
    io: any;
  }
}

import "phaser";
import Player from "../models/Player";
import OtherPlayer from "../models/OtherPlayer";
import ResourceEntity from "../models/ResourceEntity";
import Npc from "../models/Npc";
import Entity, { EntityType } from "../models/Entity";
import EventDispatcher from "../services/EventDispatcher";
import EntityActionManager from "../services/EntityActionManager";
import EntityActionProcessor from "../services/EntityActionProcessor";
import io from "socket.io-client";
import SkillsManager from "../services/SkillsManager";
import { ActionType } from "../types/Actions";
import ServerConnectorService from "../services/ServerConnectorService";
import GameState from "../services/GameState";
import NpcActionExecutor, {
  NpcActionExecutionResult,
} from "../services/NpcActionExecutor";
import { createNpcSnapshot, NpcSnapshot } from "../types/Npc";

const GOD_VIEW_MODE = true;
const GOD_CAMERA_MOVE_SPEED = 480;
const GOD_CAMERA_DEFAULT_ZOOM = 1;
const GOD_CAMERA_MIN_ZOOM = 0.45;
const GOD_CAMERA_MAX_ZOOM = 2.2;
const GOD_CAMERA_WHEEL_STEP = 0.1;

type MapLayer = Phaser.Tilemaps.TilemapLayer;

export default class WorldScene extends Phaser.Scene {
  TILE_SIZE: number = 32;

  server: any;
  emitter: EventDispatcher = EventDispatcher.getInstance();
  entityActions: EntityActionManager;
  npcActionExecutor!: NpcActionExecutor;
  gameState: GameState = new GameState(this, this.emitter);

  navMeshPlugin: any;
  navMesh: any;
  marker: Phaser.GameObjects.Graphics;
  map: Phaser.Tilemaps.Tilemap;
  mapLayers: { [key: string]: MapLayer } = {};
  currentSelection: Entity | null;

  // Entities
  player: Player;
  otherPlayers: { [key: string]: OtherPlayer } = {};
  npcs: { [key: string]: Npc } = {};
  resources: { [key: string]: ResourceEntity } = {};
  godCursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  godKeys?: {
    w: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    s: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super("WorldScene");
  }

  create() {
    this.input.setDefaultCursor("url(assets/ui/cursor-brown.cur), default");
    this.entityActions = EntityActionManager.init(this);

    this._createMap();
    this._createAnims();
    this.npcActionExecutor = new NpcActionExecutor(this);

    // Connect to Server World
    this.server = window.io
      ? window.io("http://localhost:3000", { transports: ["websocket"] })
      : io("http://localhost:3000", { transports: ["websocket"] });

    // this.server.set("origins", "*");
    console.log("server", this.server);
    // Create player
    this.server.on("playerCreated", (player: any) => {
      this.player = new Player(this, player.x, player.y, this.navMesh);
      this.player.id = player.id;
      this.player.name = player.name;
      this.player.avatar = player.avatar;
      this.entityActions.registerEntity(this.player);

      this.cameras.main.setBounds(
        0,
        0,
        this.map.widthInPixels,
        this.map.heightInPixels
      );
      this.cameras.main.roundPixels = true;

      if (GOD_VIEW_MODE) {
        this.player.setVisible(false);
        this.cameras.main.stopFollow();
        // Use spawn point as initial anchor so scene opens at an area with content.
        this.cameras.main.centerOn(this.player.x, this.player.y);
        this.cameras.main.setZoom(GOD_CAMERA_DEFAULT_ZOOM);
        this.setupGodCameraControls();
      } else {
        this.cameras.main.startFollow(this.player);
      }

      this._createEvents();

      this.scene.launch("UIScene", { player: this.player, mapLayer: this.map });
      this.scene.launch("ReactScene", { player: this.player });
    });
  }

  public syncNpcs(npcSnapshots: { [key: string]: NpcSnapshot }) {
    const nextNpcIds = new Set<string>();

    Object.values(npcSnapshots || {}).forEach((rawSnapshot: NpcSnapshot) => {
      if (!rawSnapshot || typeof rawSnapshot !== "object") return;

      const npcId =
        typeof rawSnapshot.id === "string" ? rawSnapshot.id.trim() : "";
      if (!npcId) return;

      const snapshot = createNpcSnapshot({
        ...rawSnapshot,
        id: npcId,
      });
      this.upsertNpc(snapshot);
      nextNpcIds.add(snapshot.id);
    });

    Object.keys(this.npcs).forEach((npcId) => {
      if (!nextNpcIds.has(npcId)) this.removeNpc(npcId);
    });
  }

  public upsertNpc(snapshot: NpcSnapshot): Npc | null {
    const npcId = typeof snapshot.id === "string" ? snapshot.id.trim() : "";
    if (!npcId) return null;

    const normalizedSnapshot = createNpcSnapshot({
      ...snapshot,
      id: npcId,
    });
    const existingNpc = this.npcs[normalizedSnapshot.id];

    if (existingNpc) {
      existingNpc.applySnapshot(normalizedSnapshot);
      return existingNpc;
    }

    const npc = new Npc(this, this.navMesh, normalizedSnapshot);
    this.npcs[npc.id] = npc;
    this.entityActions.registerEntity(npc);

    return npc;
  }

  public removeNpc(npcId: string): void {
    const normalizedNpcId = typeof npcId === "string" ? npcId.trim() : "";
    if (!normalizedNpcId) return;

    const npc = this.npcs[normalizedNpcId];
    if (!npc) return;

    npc.destroy(true);
    delete this.npcs[normalizedNpcId];
    this.entityActions.unregisterEntity(normalizedNpcId);
  }

  public executeNpcActions(
    npcId: string,
    actions: unknown
  ): NpcActionExecutionResult {
    return this.npcActionExecutor.executeActions(npcId, actions);
  }

  private _createMap() {
    this.map = this.make.tilemap({ key: "map" });

    const tiles = this.map.addTilesetImage("tileset", "tiles");
    const tiles2 = this.map.addTilesetImage("tileset2", "tiles2", 32, 32, 1, 2);
    const tilesetGrass = this.map.addTilesetImage(
      "Grass",
      "tileset_grass",
      32,
      32,
      1,
      2
    );

    this.mapLayers["grass"] = this.map.createLayer(
      "Grass",
      [tiles, tiles2, tilesetGrass],
      0,
      0
    );
    this.mapLayers["decorations"] = this.map.createLayer(
      "Decorations",
      [tiles, tiles2],
      0,
      0
    );
    this.mapLayers["objects"] = this.map.createLayer(
      "Objects",
      [tiles, tiles2],
      0,
      0
    );
    // this.mapLayers['objects'].setCollisionByExclusion([-1]);
    this.mapLayers["ui"] = this.map.createBlankLayer("UI", [tiles, tiles2]);

    const obstaclesLayer = this.map.getObjectLayer("Obstacles");
    this.navMesh = this.navMeshPlugin.buildMeshFromTiled(
      "mesh",
      obstaclesLayer
    );

    this.physics.world.bounds.width = this.map.widthInPixels;
    this.physics.world.bounds.height = this.map.heightInPixels;

    // Tile marker
    // Create a simple graphic that can be used to show which tile the mouse is over
    const markerWidth = 4;
    this.marker = this.add.graphics();
    this.marker.lineStyle(markerWidth, 0xffffff, 0.3);
    this.marker.strokeRect(
      -markerWidth / 2,
      -markerWidth / 2,
      this.map.tileWidth + markerWidth,
      this.map.tileHeight + markerWidth
    );

    // DEBUG NAVMESH
    //
    // this.navMesh.enableDebug();
    // this.navMesh.debugDrawMesh({
    //   drawCentroid: true,
    //   drawBounds: false,
    //   drawNeighbors: true,
    //   drawPortals: true
    // });
  }

  private _createAnims() {
    // Player animation (used mainly in the Player class when moving)
    // Need refactoring
    this.anims.create({
      key: "player-left",
      frames: this.anims.generateFrameNumbers("player", {
        frames: [4, 3, 4, 5],
      }),
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: "player-right",
      frames: this.anims.generateFrameNumbers("player", {
        frames: [7, 6, 7, 8],
      }),
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: "player-up",
      frames: this.anims.generateFrameNumbers("player", {
        frames: [10, 9, 10, 11],
      }),
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: "player-down",
      frames: this.anims.generateFrameNumbers("player", {
        frames: [1, 0, 1, 2],
      }),
      frameRate: 10,
      repeat: -1,
    });

    // Other Players animation
    this.anims.create({
      key: "other-player-left",
      frames: this.anims.generateFrameNumbers("other-player", {
        frames: [4, 3, 4, 5],
      }),
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: "other-player-right",
      frames: this.anims.generateFrameNumbers("other-player", {
        frames: [7, 6, 7, 8],
      }),
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: "other-player-up",
      frames: this.anims.generateFrameNumbers("other-player", {
        frames: [10, 9, 10, 11],
      }),
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: "other-player-down",
      frames: this.anims.generateFrameNumbers("other-player", {
        frames: [1, 0, 1, 2],
      }),
      frameRate: 10,
      repeat: -1,
    });
  }

  private _createEvents() {
    // Server Connector Listener
    const serverConnectorService = new ServerConnectorService(
      this.server,
      this,
      this.emitter
    );
    serverConnectorService.listen();
    // Entity Action Listener
    const entityActionProcessor = new EntityActionProcessor();
    entityActionProcessor.listen();

    // Skills Manager
    const skillsManager = new SkillsManager();
    skillsManager.listen();

    // On map click
    this.input.on("pointerdown", this.onMapClick);

    this.emitter.on(
      ActionType.ENTITY_SELECT,
      (unit: Entity | null, flag: boolean = true) => {
        if (
          GOD_VIEW_MODE &&
          unit &&
          unit.unitType !== EntityType.PNJ &&
          unit.unitType !== EntityType.ENEMY
        ) {
          return;
        }

        if (this.currentSelection) {
          this.currentSelection.select(false);
        }

        if (flag) this.currentSelection = unit;
        else this.currentSelection = null;

        if (unit) unit.select(flag);
      }
    );
  }

  onMapClick = (pointer: Phaser.Input.Pointer) => {
    if (GOD_VIEW_MODE) {
      if (this.currentSelection) {
        this.emitter.emit(ActionType.ENTITY_SELECT, null);
      }
      return;
    }

    // If something is selected, unselected
    if (this.currentSelection) {
      this.emitter.emit(ActionType.ENTITY_SELECT, null);
      return;
    }

    this._moveEntity(this.player, pointer.worldX, pointer.worldY);
  };

  private _moveEntity(
    entity: Entity,
    x: number,
    y: number
  ): Phaser.Tilemaps.Tile {
    const tile = this.map.getTileAtWorldXY(
      x,
      y,
      false,
      this.cameras.main,
      this.mapLayers["grass"]
    );

    // Move Player to this position
    // Player will automatically find its path to the point and update its position accordingly
    this.entityActions.processNow(entity, {
      type: ActionType.ENTITY_GO_TO,
      args: [tile],
    });

    return tile;
  }

  update() {
    if (!this.currentSelection) this.updateMapMarker();
    if (!GOD_VIEW_MODE || !this.godCursors || !this.godKeys) return;

    const camera = this.cameras.main;
    const dt = this.game.loop.delta / 1000;
    const offset = GOD_CAMERA_MOVE_SPEED * dt;

    const left = this.godCursors.left?.isDown || this.godKeys.a?.isDown;
    const right = this.godCursors.right?.isDown || this.godKeys.d?.isDown;
    const up = this.godCursors.up?.isDown || this.godKeys.w?.isDown;
    const down = this.godCursors.down?.isDown || this.godKeys.s?.isDown;

    if (left) camera.scrollX -= offset;
    if (right) camera.scrollX += offset;
    if (up) camera.scrollY -= offset;
    if (down) camera.scrollY += offset;
  }

  private updateMapMarker() {
    // Convert the mouse position to world position within the camera
    const worldPoint: any = this.input.activePointer.positionToCamera(
      this.cameras.main
    );

    // Move map marker over pointed tile
    const pointerTileXY = this.mapLayers["ui"].worldToTileXY(
      worldPoint.x,
      worldPoint.y
    );
    const snappedWorldPoint = this.mapLayers["ui"].tileToWorldXY(
      pointerTileXY.x,
      pointerTileXY.y
    );
    this.marker.setPosition(snappedWorldPoint.x, snappedWorldPoint.y);
  }

  private setupGodCameraControls() {
    if (!this.input.keyboard) return;

    this.godCursors = this.input.keyboard.createCursorKeys();
    this.godKeys = this.input.keyboard.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as {
      w: Phaser.Input.Keyboard.Key;
      a: Phaser.Input.Keyboard.Key;
      s: Phaser.Input.Keyboard.Key;
      d: Phaser.Input.Keyboard.Key;
    };

    // Wheel up -> zoom in, wheel down -> zoom out.
    this.input.on(
      "wheel",
      (
        _pointer: Phaser.Input.Pointer,
        _gameObjects: Phaser.GameObjects.GameObject[],
        _deltaX: number,
        deltaY: number
      ) => {
        const currentZoom = this.cameras.main.zoom;
        const nextZoom =
          deltaY < 0
            ? currentZoom + GOD_CAMERA_WHEEL_STEP
            : currentZoom - GOD_CAMERA_WHEEL_STEP;

        this.cameras.main.setZoom(
          Phaser.Math.Clamp(nextZoom, GOD_CAMERA_MIN_ZOOM, GOD_CAMERA_MAX_ZOOM)
        );
      }
    );

    this.input.keyboard.on("keydown-EQUALS", () => {
      const nextZoom = Phaser.Math.Clamp(
        this.cameras.main.zoom + GOD_CAMERA_WHEEL_STEP,
        GOD_CAMERA_MIN_ZOOM,
        GOD_CAMERA_MAX_ZOOM
      );
      this.cameras.main.setZoom(nextZoom);
    });
    this.input.keyboard.on("keydown-MINUS", () => {
      const nextZoom = Phaser.Math.Clamp(
        this.cameras.main.zoom - GOD_CAMERA_WHEEL_STEP,
        GOD_CAMERA_MIN_ZOOM,
        GOD_CAMERA_MAX_ZOOM
      );
      this.cameras.main.setZoom(nextZoom);
    });
  }
}
