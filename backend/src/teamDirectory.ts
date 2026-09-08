import { readFileSync } from "node:fs";
import { join } from "node:path";
import { read, utils } from "xlsx";

const MAPPING_FILE = join(import.meta.dir, "..", "data", "API_Team_Code_Mapping.xlsx");

export interface TeamInfo {
  teamCode: string;
  teamName: string;
  category: string;
}

interface MappingRow {
  "Team Code"?: string;
  "Team Name"?: string;
  api_key_name?: string;
  api_key?: string;
  Category?: string;
}

function loadTeamDirectory(): Map<string, TeamInfo> {
  const directory = new Map<string, TeamInfo>();

  let file: Buffer;
  try {
    file = readFileSync(MAPPING_FILE);
  } catch (err) {
    console.error(`Team mapping file not found at ${MAPPING_FILE}:`, err);
    return directory;
  }

  const workbook = read(file, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return directory;
  const rows = utils.sheet_to_json<MappingRow>(sheet);

  for (const row of rows) {
    const apiKeyName = row.api_key_name?.trim();
    if (!apiKeyName) continue;
    directory.set(apiKeyName, {
      teamCode: row["Team Code"]?.trim() ?? "",
      teamName: row["Team Name"]?.trim() ?? "",
      category: row.Category?.trim() ?? "",
    });
  }

  return directory;
}

const teamDirectory = loadTeamDirectory();

export function getTeamInfo(teamId: string): TeamInfo | undefined {
  return teamDirectory.get(teamId);
}
