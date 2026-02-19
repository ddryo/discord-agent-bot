import {
  Client,
  GatewayIntentBits,
  type Message,
  type Interaction,
  type ThreadChannel,
} from "discord.js";
import { config } from "../config.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("bot:client");

export type MessageHandler = (message: Message) => void | Promise<void>;
export type InteractionHandler = (
  interaction: Interaction,
) => void | Promise<void>;
export type ThreadCreateHandler = (
  thread: ThreadChannel,
  newlyCreated: boolean,
) => void | Promise<void>;

export interface DiscordClient {
  client: Client;
  onMessage(handler: MessageHandler): void;
  onInteraction(handler: InteractionHandler): void;
  onThreadCreate(handler: ThreadCreateHandler): void;
  login(): Promise<void>;
  destroy(): Promise<void>;
}

export function createDiscordClient(): DiscordClient {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const messageHandlers: MessageHandler[] = [];
  const interactionHandlers: InteractionHandler[] = [];
  const threadCreateHandlers: ThreadCreateHandler[] = [];

  client.once("ready", () => {
    logger.info(`Bot logged in as ${client.user?.tag ?? "unknown"}`);
  });

  client.on("messageCreate", (message) => {
    for (const handler of messageHandlers) {
      void Promise.resolve(handler(message)).catch((err: unknown) => {
        logger.error(`messageCreate handler error: ${String(err)}`);
      });
    }
  });

  client.on("interactionCreate", (interaction) => {
    for (const handler of interactionHandlers) {
      void Promise.resolve(handler(interaction)).catch((err: unknown) => {
        logger.error(`interactionCreate handler error: ${String(err)}`);
      });
    }
  });

  client.on("threadCreate", (thread, newlyCreated) => {
    for (const handler of threadCreateHandlers) {
      void Promise.resolve(handler(thread, newlyCreated)).catch((err: unknown) => {
        logger.error(`threadCreate handler error: ${String(err)}`);
      });
    }
  });

  return {
    client,
    onMessage(handler: MessageHandler) {
      messageHandlers.push(handler);
    },
    onInteraction(handler: InteractionHandler) {
      interactionHandlers.push(handler);
    },
    onThreadCreate(handler: ThreadCreateHandler) {
      threadCreateHandlers.push(handler);
    },
    async login() {
      await client.login(config.discordBotToken);
    },
    async destroy() {
      await client.destroy();
      logger.info("Bot client destroyed");
    },
  };
}
