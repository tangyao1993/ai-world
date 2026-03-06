import EventDispatcher from './EventDispatcher';
import Entity from '../models/Entity';
import { ActionType } from '../types/Actions';

enum ActionStatus {
    PENDING,
    RUNNING,
    COMPLETED,
}

export interface EntityAction {
    status: ActionStatus;
    type: string;
    startedDate: number;
    args?: any;
    progress?: (action: EntityAction, entity: Entity) => number;
    isCompleted?: (action: EntityAction, entity: Entity) => boolean;
}

export type PendingEntityAction = Pick<EntityAction, 'type' | 'args' | 'isCompleted' | 'progress'>;

let instance: EntityActionManager;
export default class EntityActionManager {
    THICK_TIMER = 100;

    emitter: EventDispatcher = EventDispatcher.getInstance();
    scene: Phaser.Scene;
    entities: { [key: string]: Entity } = {};
    actionsQueue: { [key: string]: EntityAction[] } = {};

    static init(scene: Phaser.Scene): EntityActionManager {
        instance = new EntityActionManager(scene);

        return instance;
    }

    static getInstance(): EntityActionManager {
        if (!instance) throw new Error('EntityActionManager is not initialized.');

        return instance;
    }

    constructor(scene: Phaser.Scene) {
        this.scene = scene;

        this.update();
        // scene.events.on("update", this.update, this);
        // scene.events.once("shutdown", this.destroy, this);
    }

    registerEntity(entity: Entity) {
        this.entities[entity.id] = entity;

        if (!this.actionsQueue[entity.id]) this.actionsQueue[entity.id] = [];
    }

    unregisterEntity(entityId: string) {
        delete this.entities[entityId];
        delete this.actionsQueue[entityId];
    }

    processNow(entity: Entity, action: PendingEntityAction) {
        // Register entity
        this.registerEntity(entity);

        // Clear queue and add actoin
        this.actionsQueue[entity.id] = [this._createAction(action)];
    }

    enqueue(entity: Entity, action: PendingEntityAction) {
        // Register entity
        this.registerEntity(entity);

        this.actionsQueue[entity.id].push(this._createAction(action));
    }

    update = () => {
        try {
            for (let entityId in this.actionsQueue) {
                const entity = this.entities[entityId];
                const entityActions = this.actionsQueue[entityId];

                if (!entity || !Array.isArray(entityActions) || entityActions.length <= 0) {
                    continue;
                }

                const nextAction = entityActions[0];
                if (!nextAction) continue;

                try {
                    // Wait until current action is completed
                    if (nextAction.status === ActionStatus.RUNNING) {
                        if (nextAction.progress && typeof nextAction.progress === 'function') {
                            const progress = nextAction.progress(nextAction, entity);
                            this.emitter.emit(ActionType.ACTION_PROGRESS, entity, progress, ...nextAction.args);
                        }

                        if (nextAction.isCompleted && nextAction.isCompleted(nextAction, entity)) {
                            entityActions.shift();
                        }

                        continue;
                    }

                    // If no action running, process first action in the queue
                    this._processAction(entity, nextAction);
                } catch (error) {
                    console.error("[EntityActionManager] action processing failed", {
                        entityId,
                        actionType: nextAction.type,
                        message: String(error),
                    });
                    entityActions.shift();
                }
            }
        } finally {
            setTimeout(this.update, this.THICK_TIMER);
        }
    }

    private _processAction(entity: Entity, action: EntityAction) {
        action.status = ActionStatus.RUNNING;
        action.startedDate = Date.now();
        this.emitter.emit(action.type, entity, ...action.args);
    }

    private _createAction(action: PendingEntityAction): EntityAction {
        const newAction = { ...action } as EntityAction;

        newAction.status = ActionStatus.PENDING;
        newAction.args = Array.isArray(newAction.args) ? newAction.args : [];
        newAction.isCompleted = newAction.isCompleted ? newAction.isCompleted : () => (true);

        return newAction;
    }

    destroy() {
        if (this.scene) this.scene.events.off('update', this.update, this);
    }

}
