import type { CustomTheme } from "@shared/themes";
import { create } from "zustand";

/**
 * A custom theme being edited in Settings › Appearance. The app shows it right away (`App` applies it ahead of the
 * saved theme) while the editor saves it to preferences a moment later, so dragging a color stays smooth.
 */
export const useThemePreview = create<{ theme: CustomTheme | null }>(() => ({ theme: null }));
