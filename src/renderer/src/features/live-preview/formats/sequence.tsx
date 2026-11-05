import type { LiveAdapter } from "../types";
import { Frame } from "./image";

/** A declared sequence uses the same revision-safe image player for its newest stable frame. */
export const adapter: LiveAdapter = { format: "sequence", maxFps: 4, Frame };
