import { FolderOpen, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChatArea } from "../chat/ChatArea";
import { getCommand } from "../registry/commands";
import { screens, sheets } from "../registry/slots";
import { useApp } from "../state/app";
import { Button, EmptyState, Mark } from "../ui";
import { Dock } from "./Dock";
import { ResizeHandle } from "./ResizeHandle";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabStrip } from "./TabStrip";
import { TitleBar } from "./TitleBar";

function SheetHost(): ReactNode {
	const sheet = useApp(state => state.sheet);
	const list = sheets.use();
	if (!sheet) return null;
	const spec = list.find(entry => entry.id === sheet.id);
	if (!spec) return null;
	const Component = spec.component;
	// Sheet props are defined by each feature; the opener passes the matching shape.
	return <Component key={sheet.id} props={sheet.props as never} close={() => useApp.getState().closeSheet()} />;
}

function HomeView(): ReactNode {
	const { t } = useTranslation("shell");
	const projectPath = useApp(state => state.activeProject);
	const home = screens.use().find(screen => screen.id === "home");
	if (home) return <home.component projectPath={projectPath} />;
	return (
		<EmptyState
			className="m-auto"
			art={<Mark size={48} />}
			title={t("home.noProject")}
			actions={
				<>
					<Button icon={<FolderOpen />} onClick={() => void getCommand("project.open")?.run({ session: null, projectPath })}>
						{t("home.openFolder")}
					</Button>
					<Button variant="primary" icon={<Plus />} onClick={() => void getCommand("project.new")?.run({ session: null, projectPath })}>
						{t("home.newProject")}
					</Button>
				</>
			}
		/>
	);
}

/** Window layout (DESIGN §3): title bar · sidebar | tabs + chats/home | dock · status bar. */
export function Shell(): ReactNode {
	const { t } = useTranslation("shell");
	const sidebarOpen = useApp(state => state.sidebarOpen);
	const sidebarWidth = useApp(state => state.sidebarWidth);
	const dockOpen = useApp(state => state.dockOpen);
	const dockWidth = useApp(state => state.dockWidth);
	const view = useApp(state => state.view);
	const hasTabs = useApp(state => state.tabs.length > 0);

	return (
		<div className="flex h-full flex-col bg-bg text-fg">
			<TitleBar />
			<div className="flex min-h-0 flex-1">
				{sidebarOpen && (
					<>
						<Sidebar width={sidebarWidth} />
						<ResizeHandle label={t("resizeSidebar")} value={sidebarWidth} min={200} max={320} direction={1} onChange={width => useApp.getState().setSidebarWidth(width)} />
					</>
				)}
				<main className="flex min-w-0 flex-1 flex-col">
					<TabStrip />
					<div className="flex min-h-0 flex-1">{view === "chat" && hasTabs ? <ChatArea /> : <HomeView />}</div>
				</main>
				{dockOpen && (
					<>
						<ResizeHandle label={t("dock.resize")} value={dockWidth} min={320} max={640} direction={-1} onChange={width => useApp.getState().setDockWidth(width)} />
						<Dock width={dockWidth} />
					</>
				)}
			</div>
			<StatusBar />
			<SheetHost />
		</div>
	);
}
