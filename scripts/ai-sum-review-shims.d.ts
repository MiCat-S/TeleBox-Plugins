declare module "@utils/pluginBase" {
  export class Plugin {
    name?: string;
    description: unknown;
    cmdHandlers: Record<string, (...args: any[]) => Promise<void>>;
  }

  export type PanelSettingsAdapter = any;
  export type PanelSettingField = any;

  export interface PluginRuntimeContext {
    generation: number;
    signal: AbortSignal;
    lifecycle: any;
  }
}

declare module "@utils/pluginManager" {
  export function getPrefixes(): string[];
}

declare module "@utils/pathHelpers" {
  export function createDirectoryInAssets(name: string): string;
}

declare module "@utils/telegramFormatter" {
  export const TelegramFormatter: any;
}

declare module "@utils/telegraphFormatter" {
  export const TelegraphFormatter: any;
}

declare module "@utils/safeGetMessages" {
  export const safeGetMessages: any;
  export const safeGetReplyMessage: any;
}

declare module "@utils/htmlEscape" {
  export function htmlEscape(value: unknown): string;
}

declare module "@utils/cronManager" {
  export const cronManager: any;
}

declare module "@utils/runtimeManager" {
  export const getGlobalClient: any;
}
