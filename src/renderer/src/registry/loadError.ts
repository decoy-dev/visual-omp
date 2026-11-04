/**
 * A part of the window that did not load: a code chunk (`./lazy`) or a deferred text namespace
 * (`../i18n`). Load boundaries show a retry state for it; any other error passes through them.
 */
export class LoadError extends Error {
	override name = "LoadError";
}
