import { Plugin } from "obsidian";

export default class AIAgentPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log("[AI Agent] loaded");
  }

  onunload(): void {
    console.log("[AI Agent] unloaded");
  }
}
