/**
 * Code-split views. Features keep registering eagerly (commands, status items, badges, the registry
 * entry itself) while the heavy component behind an entry loads in its own chunk: `lazyView` for any
 * component, `lazyPage` for a full page, `lazySection` for a Settings section. Every split chunk is
 * also loaded in idle time after startup (`./idle`). A view opened later normally has its component
 * already loaded; a deferred translation namespace may still suspend on first use. The fallback
 * (shaped like the surface it stands in for) covers either load. When the chunk or the namespace does
 * not load, a `LoadBoundary` shows the surface's failure state with Try again.
 */
import { Warning } from "@phosphor-icons/react";
import { Component, type ComponentType, createElement, type ReactNode, Suspense, use } from "react";
import { useTranslation } from "react-i18next";
import { retryFailedNamespaces } from "../i18n";
import { usePageBack } from "../state/navigation";
import { Button, EmptyState } from "../ui";
import { PageFrame, PageSkeleton, type PageWidth } from "../ui/Page";
import { preloadWhenIdle } from "./idle";
import { LoadError } from "./loadError";
import type { PageProps, SettingsSectionProps } from "./slots";

/** A split component. `preload()` starts loading it (call on intent, such as hovering its opener). */
export interface LazyView<P> {
	(props: P): ReactNode;
	preload(): Promise<ComponentType<P>>;
}

/** A surface's failure state; `retry` loads its chunk and failed texts again. */
export interface LoadFailureProps {
	retry(): void;
}

/**
 * Shows `fallback` in place of children that threw a `LoadError` (a chunk or deferred text that did not
 * load) until Try again. Any other error passes on to the next boundary.
 */
export class LoadBoundary extends Component<{ fallback(retry: () => void): ReactNode; children: ReactNode }, { error: unknown }> {
	override state: { error: unknown } = { error: null };

	static getDerivedStateFromError(error: unknown): { error: unknown } {
		return { error };
	}

	#retry = (): void => {
		void retryFailedNamespaces().finally(() => this.setState({ error: null }));
	};

	override render(): ReactNode {
		const { error } = this.state;
		if (error === null) return this.props.children;
		if (!(error instanceof LoadError)) throw error;
		return this.props.fallback(this.#retry);
	}
}

/** The failure state of a Settings section or a page, in place of its content. */
export function LoadFailed({ retry }: LoadFailureProps): ReactNode {
	const { t } = useTranslation("shell");
	return <EmptyState icon={<Warning />} title={t("load.failedTitle")} body={t("load.failedBody")} actions={<Button onClick={retry}>{t("load.retry")}</Button>} />;
}

/**
 * A component loaded from its own chunk on first render (or earlier through `preload` and idle time).
 * `Fallback` gets the same props and should look like the surface's empty frame, so loading never
 * shifts layout. Loaded components render directly; their translation hooks can still suspend here.
 * With `Failure`, a chunk or deferred text that does not load shows it; without, the `LoadError`
 * reaches the enclosing boundary (the sheet host has one for every sheet).
 */
export function lazyView<P extends object>(
	load: () => Promise<ComponentType<P>>,
	Fallback: ComponentType<P> | null = null,
	Failure: ComponentType<P & LoadFailureProps> | null = null,
): LazyView<P> {
	let loaded: ComponentType<P> | null = null;
	let pending: Promise<ComponentType<P>> | null = null;
	const preload = (): Promise<ComponentType<P>> => {
		pending ??= load().then(
			component => {
				loaded = component;
				return component;
			},
			(error: unknown) => {
				// A failed load reaches the nearest load boundary; the next render tries again.
				pending = null;
				throw new LoadError("A part of the window did not load.", { cause: error });
			},
		);
		return pending;
	};
	function Loaded(props: P): ReactNode {
		return createElement(loaded ?? use(preload()), props);
	}
	function View(props: P): ReactNode {
		const view = <Suspense fallback={Fallback ? createElement(Fallback, props) : null}>{createElement(Loaded, props)}</Suspense>;
		return Failure ? <LoadBoundary fallback={retry => createElement(Failure, { ...props, retry })}>{view}</LoadBoundary> : view;
	}
	View.preload = preload;
	preloadWhenIdle(preload);
	return View;
}

/**
 * A full page from its own chunk. Until it loads, the page frame shows with the real back link, the
 * page's width and a skeleton, so the swap to the page is in place. If it does not load, the same frame
 * shows the failure state.
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
	function PageFailed({ close, retry }: PageProps<P> & LoadFailureProps): ReactNode {
		const { t } = useTranslation();
		return (
			<PageFrame back={usePageBack(close)} width={options.width} label={t(options.title)} focusKey="failed">
				<LoadFailed retry={retry} />
			</PageFrame>
		);
	}
	return lazyView(load, PageLoading, PageFailed);
}

/** A Settings section from its own chunk; a content skeleton holds its place inside the Settings page. */
export function lazySection(load: () => Promise<ComponentType<SettingsSectionProps>>): LazyView<SettingsSectionProps> {
	return lazyView(load, PageSkeleton, LoadFailed);
}