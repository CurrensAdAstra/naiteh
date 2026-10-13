import { useEffect, useState } from "react";

import { searchText } from "../../lib/api/search";
import { HighlightedText } from "../../lib/HighlightedText";
import { openByRelPath } from "../../lib/openByRelPath";
import { formatAppError } from "../../lib/types";
import type { SearchHit } from "../../lib/types";
import { useEditorStore } from "../../state/editorStore";
import { useVaultContentStore } from "../../state/vaultContentStore";
import styles from "./SearchListPanel.module.css";

const DEBOUNCE_MS = 250;
const RESULT_LIMIT = 100;
/** Shorter queries match nearly every line and only cost a full scan. */
export const MIN_QUERY_LENGTH = 2;

export function SearchListPanel() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const openRelPath = useEditorStore((s) => s.open?.source.relPath ?? null);
  // Re-run the current query when vault files change elsewhere (sync,
  // other panels, changes made outside naiteh).
  const contentVersion = useVaultContentStore((s) => s.version);

  useEffect(() => {
    const trimmed = query.trim();
    if (Array.from(trimmed).length < MIN_QUERY_LENGTH) {
      setHits([]);
      setHasSearched(false);
      setError(null);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      searchText(trimmed, RESULT_LIMIT)
        .then((results) => {
          if (cancelled) return;
          setHits(results);
          setError(null);
          setHasSearched(true);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(formatAppError(e));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, contentVersion]);

  async function handleOpen(hit: SearchHit) {
    try {
      await openByRelPath(hit.relPath);
    } catch (e) {
      setError(formatAppError(e));
    }
  }

  const trimmed = query.trim();
  const tooShort = trimmed !== "" && Array.from(trimmed).length < MIN_QUERY_LENGTH;
  const showStatus = trimmed !== "" && !tooShort && (searching || hasSearched);

  return (
    <div className={styles.panel} data-testid="list-panel-search">
      <header className={styles.header}>
        <h2 className={styles.title}>Search</h2>
      </header>
      <div className={styles.searchBar}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search vault…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search vault"
          autoFocus
          data-testid="search-input"
        />
      </div>
      <div className={styles.body} data-testid="search-body">
        {error !== null && <p className={styles.error}>{error}</p>}
        {error === null && trimmed === "" && (
          <p className={styles.empty}>Type to search note bodies.</p>
        )}
        {error === null && tooShort && (
          <p className={styles.empty} data-testid="search-too-short">
            Type at least {MIN_QUERY_LENGTH} characters.
          </p>
        )}
        {error === null && showStatus && (
          <div className={styles.statusRow} data-testid="search-status">
            {searching
              ? "Searching…"
              : hits.length === 0
                ? "No matches."
                : `${hits.length} match${hits.length === 1 ? "" : "es"}`}
          </div>
        )}
        {error === null && !tooShort && !searching && hits.length > 0 && (
          <ul className={styles.list} data-testid="search-results">
            {hits.map((hit, index) => {
              const isActive = hit.relPath === openRelPath;
              return (
                <li key={`${hit.relPath}:${hit.line}:${index}`}>
                  <button
                    type="button"
                    className={`${styles.row} ${isActive ? styles.rowActive : ""}`}
                    onClick={() => void handleOpen(hit)}
                    data-testid={`search-hit-${hit.relPath}-${hit.line}`}
                  >
                    <span className={styles.rowHeader}>
                      <span className={styles.rowTitle}>
                        <HighlightedText text={hit.title} query={trimmed} />
                      </span>
                      <span className={styles.rowLine}>L{hit.line}</span>
                    </span>
                    <span className={styles.rowExcerpt}>
                      <HighlightedText text={hit.excerpt} query={trimmed} />
                    </span>
                    <span className={styles.rowRelPath}>{hit.relPath}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
