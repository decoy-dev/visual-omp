import { IconContext, type IconProps } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { needsSetup, useSetup } from "./features/onboarding/setup";
import { globals, screens } from "./registry/slots";
import { Shell } from "./shell/Shell";
import { MAIN_ID, useApp } from "./state/app";
import { MotionProvider, Toaster, TooltipProvider } from "./ui";

/** Phosphor defaults: size follows the text (callers size with `size-*` classes), regular weight, inherited color. */
const iconDefaults: IconProps = { size: "1em", weight: "regular", color: "currentColor", mirrored: false };

/** Applies theme, text size and motion preferences to <html> so tokens and rem sizes follow them. */
function usePreferenceAttributes(): void {
	const prefs = useApp(state => state.prefs);
	const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	useEffect(() => {
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	useEffect(() => {
		const html = document.documentElement;
		const theme = prefs?.theme ?? "light";
		html.dataset.theme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
		html.style.fontSize = `${prefs?.textScale ?? 100}%`;
		const motion = prefs?.reducedMotion ?? "system";
		if (motion === "system") delete html.dataset.motion;
		else html.dataset.motion = motion === "on" ? "reduced" : "full";
	}, [prefs, systemDark]);
}

export function App(): ReactNode {
	const omp = useApp(state => state.omp);
	const prefs = useApp(state => state.prefs);
	const requested = useSetup(state => state.requested);
	const dismissed = useSetup(state => state.dismissed);
	const handoff = useSetup(state => state.handoff);
	const activeProject = useApp(state => state.activeProject);
	const screenList = screens.use();
	const globalList = globals.use();
	usePreferenceAttributes();
	const previousHandoff = useRef(false);
	useEffect(() => {
		if (previousHandoff.current && !handoff) {
			const target = [...document.querySelectorAll<HTMLElement>('[data-setup-shell] [data-tour="composer"] textarea')]
				.find(element => !element.closest("[inert], [hidden]") && element.getClientRects().length > 0)
				?? document.getElementById(MAIN_ID);
			target?.focus();
		}
		previousHandoff.current = handoff;
	}, [handoff]);

	useEffect(() => {
		void useApp.getState().init();
	}, []);
	// An exit suppresses the current unavailable engine. A later failure still needs repair.
	useEffect(() => {
		if (dismissed && omp?.found && omp.supported && !omp.refused) useSetup.setState({ dismissed: false });
	}, [dismissed, omp]);

	const setup = screenList.find(screen => screen.id === "setup");
	const showSetup = needsSetup(omp, prefs, requested, dismissed);

	return (
		<IconContext.Provider value={iconDefaults}>
			<MotionProvider>
				<TooltipProvider>
					{(!showSetup || handoff) && <div className="contents" data-setup-shell inert={handoff}><Shell /></div>}
					{(showSetup || handoff) && setup && <div className={handoff ? "fixed inset-0 z-50" : undefined}><setup.component projectPath={activeProject} /></div>}
					{globalList.map(global => (
						<global.component key={global.id} />
					))}
					<Toaster />
				</TooltipProvider>
			</MotionProvider>
		</IconContext.Provider>
	);
}
