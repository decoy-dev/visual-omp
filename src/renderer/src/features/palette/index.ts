/**
 * Command palette (⌘K), omp terminal sheet (⌘J) with its auto-open watcher, and app-wide
 * shortcut/menu routing. Other features declare natively drawn omp screens via
 * `registerNativeOverlay` from `./overlays`.
 */
import { globals } from "../../registry/slots";
import "./commands";
import { OverlayWatcher } from "./OverlayWatcher";
import { PaletteHost } from "./Palette";
import { Shortcuts } from "./Shortcuts";
import { TerminalSheetHost } from "./TerminalSheet";

globals.register({ id: "palette", component: PaletteHost });
globals.register({ id: "terminal-sheet", component: TerminalSheetHost });
globals.register({ id: "terminal-sheet-watcher", component: OverlayWatcher });
globals.register({ id: "shortcuts", component: Shortcuts });
