export enum ActionType {
    ENTITY_GO_TO = 'action.entity.go-to',
    NPC_GO_TO = 'action.npc.go-to',
    NPC_SAY = 'action.npc.say',
    NPC_LOOK_AT = 'action.npc.look-at',
    NPC_TALK_TO_NPC = 'action.npc.talk-to-npc',
    NPC_GIFT_TO_NPC = 'action.npc.gift-to-npc',
    NPC_ATTACK_NPC = 'action.npc.attack-npc',
    NPC_CREATE = 'action.npc.create',
    NPC_BRAIN_DECIDE = 'action.npc.brain-decide',
    WORLD_EVENT_INJECT = 'action.world-event.inject',
    ENTITY_SELECT = 'action.entity.select',
    RESOURCE_COLLECT_BEGIN = 'action.resource.collect-begin',
    RESOURCE_COLLECT = 'action.resource.collect',
    ACTION_PROGRESS = 'action.progress',
    SKILL_INCREASE = 'action.skill.increase',
    SKILL_LEVEL_UP = 'action.skill.level-up',
    CHAT_SEND_MESSAGE = 'chat.message.send',
    CHAT_SEND_NPC_MESSAGE = 'chat.message.send-npc',
};

export enum ServerEvent {
    CHAT_NEW_MESSAGE = 'server.chat.new-message',
    ENTITY_MOVED = 'server.entity.move',
}
