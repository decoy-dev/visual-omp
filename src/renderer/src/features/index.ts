/**
 * Loads every feature module (`features/<name>/index.ts` or `index.tsx`). Importing a feature
 * registers its commands, panes, sheets, status-bar items and chat slots; nothing else in the app
 * needs to know it exists.
 */
import.meta.glob(["./*/index.ts", "./*/index.tsx"], { eager: true });
