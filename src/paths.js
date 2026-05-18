import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const configBase = process.env.INTENT_VIDEO_CONFIG_DIR || join(home, ".config", "intent-video");
const dataBase = process.env.INTENT_VIDEO_DATA_DIR || join(home, ".local", "share", "intent-video");

export const paths = {
  configDir: configBase,
  dataDir: dataBase,
  configFile: join(configBase, "config.json"),
  historyFile: join(dataBase, "history.jsonl"),
  cacheFile: join(dataBase, "cache.jsonl")
};

export function useProjectLocalPaths(base = join(process.cwd(), ".intent-video")) {
  paths.configDir = join(base, "config");
  paths.dataDir = join(base, "data");
  paths.configFile = join(paths.configDir, "config.json");
  paths.historyFile = join(paths.dataDir, "history.jsonl");
  paths.cacheFile = join(paths.dataDir, "cache.jsonl");
}
