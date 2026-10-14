/**
 * Code-split views. Features keep registering eagerly (commands, status items, badges, the registry
 * entry itself) while the heavy component behind an entry loads in its own chunk: `lazyView` for any
 * component, `lazyPage` for a full page, `lazySection` for a Settings section. Every split chunk is
 * also loaded in idle time after startup (`./idle`), so a view opened later is normally loaded already
 * and renders with no fallback at all; the fallback (shaped like the surface it stands in for) covers
 * an open before that.
 */
import { type ComponentType, createElement, type ReactNode, Suspense, use } from "react";
import { useTranslation } from "react-i18next";
import { usePageBack } from "../state/navigation";
import { PageFrame, PageSkeleton, type PageWidth } from "../ui/Page";
import { preloadWhenIdle } from "./idle";
import type { PageProps, SettingsSectionProps } from "./slots";

/** A split component. `preload()` starts loading it (call on intent, such as hovering its opener). */
export interface LazyView<P> {
	(props: P): ReactNode;
	preload(): Promise<ComponentType<P>>;
}

/**
 * A component loaded from its own chunk on first render (or earlier through `preload` and idle time).
 * `Fallback` gets the same props and should look like the surface's empty frame, so loading never
 * shifts layout. Once loaded, the component renders synchronously, without suspending.
 */
export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>, Fallback: ComponentType<P> | null = null): LazyView<P> {
	let loaded: ComponentType<P> | null = null;
	let pending: Promise<ComponentType<P>> | null = null;
	const preload = (): Promise<ComponentType<P>> => {
		pending ??= load().then(
			component => {
				loaded = component;
				return component;
			},
			(error: unknown) => {
				// A failed load reaches the nearest error boundary; the next render tries again.
				pending = null;
				throw error;
			},
		);
		return pending;
	};
	function Loaded(props: P): ReactNode {
		return createElement(loaded ?? use(preload()), props);
	}
	function View(props: P): ReactNode {
		return <Suspense fallback={Fallback ? createElement(Fallback, props) : null}>{createElement(Loaded, props)}</Suspense>;
	}
	View.preload = preload;
	preloadWhenIdle(preload);
	return View;
}

/**
 * A full page from its own chunk. Until it loads, the page frame shows with the real back link, the
 * page's width and a skeleton, so the swap to the page is in place.
 */
export function lazyPage<P>(load: () => Promise<ComponentType<PageProps<P>>>, options: { title: string; width: PageWidth }): LazyView<PageProps<P>> {
	function PageLoading({ close }: PageProps<P>): ReactNode {
		const { t } = useTranslation();
		return (
			<PageFrame back={usePageBack(close)} width={options.width} label={t(options.title)} focusKey="loading">
				<PageSkeleton />
			</PageFrame>
		);
	}
	return lazyView(load, PageLoading);
}

/** A Settings section from its own chunk; a content skeleton holds its place inside the Settings page. */
export function lazySection(load: () => Promise<ComponentType<SettingsSectionProps>>): LazyView<SettingsSectionProps> {
	return lazyView(load, PageSkeleton);
}