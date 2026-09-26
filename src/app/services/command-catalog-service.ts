import { opencodeV2 } from "../../opencode/client.js";

export interface CommandCatalogItem {
  name: string;
  description?: string | undefined;
}

function normalizeDirectoryForCommandApi(directory: string): string {
  return directory.replace(/\\/g, "/");
}

export async function loadCommandCatalog(projectDirectory: string): Promise<CommandCatalogItem[]> {
  const { data, error } = await opencodeV2.command.list({
    location: { directory: normalizeDirectoryForCommandApi(projectDirectory) },
  });

  if (error || !data) {
    throw error || new Error("No command data received");
  }

  return data.data
    .filter((command) => {
      return typeof command.name === "string" && command.name.trim().length > 0;
    })
    .map((command) => ({
      name: command.name,
      description: command.description,
    }));
}
