export type ChatChannel = "world" | "npc_private";

export type ChatMessage = {
  author: string;
  image?: string;
  message: string;
  creationDate?: number;
  channel?: ChatChannel;
  npcId?: string;
  npcName?: string;
  targetPlayerId?: string;
};

export type NpcChatRequest = {
  npcId: string;
  message: string;
};

export type NpcBrainDecisionRequest = {
  npcId: string;
  context?: string;
};

export type WorldEventInjectRequest = {
  description: string;
};
