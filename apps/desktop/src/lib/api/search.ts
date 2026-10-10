import { invoke } from "./invoke";

import type { SearchHit } from "../types";

export function searchText(query: string, limit: number): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_text", { query, limit });
}
