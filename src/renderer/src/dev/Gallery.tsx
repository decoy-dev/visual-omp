import {
	Archive,
	Bot,
	Copy,
	FolderOpen,
	GitBranch,
	Inbox,
	Moon,
	MoreHorizontal,
	Pencil,
	Play,
	Plus,
	RotateCw,
	Settings,
	Share2,
	Sparkles,
	Sun,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
	Badge,
	BracketLabel,
	Button,
	Card,
	Checkbox,
	Chip,
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuTrigger,
	ContextRing,
	Dialog,
	DialogClose,
	DialogContent,
	DialogTrigger,
	Divider,
	EmptyState,
	GlowBorder,
	IconButton,
	Input,
	Kbd,
	Mark,
	Menu,
	MenuCheckboxItem,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuSub,
	MenuTrigger,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Progress,
	PulseDot,
	RadioGroup,
	ScrollArea,
	SearchInput,
	Segmented,
	Select,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	Sheet,
	SheetClose,
	SheetContent,
	SheetTrigger,
	Skeleton,
	Slider,
	Spinner,
	StatusDot,
	StepDots,
	Switch,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Textarea,
	Toaster,
	Tooltip,
	TooltipProvider,
	toast,
	Wordmark,
	WorkingIndicator,
} from "../ui";

type Theme = "light" | "dark";
type Motion = "full" | "reduced";

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-4 border-t border-border py-8">
			<BracketLabel as="h2">{title}</BracketLabel>
			{children}
		</section>
	);
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			{label && <span className="w-28 shrink-0 text-sm text-fg-faint">{label}</span>}
			{children}
		</div>
	);
}

/** Visual QA page: every primitive in every variant/state, with theme + motion toggles. */
export function Gallery() {
	const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
	const [motion, setMotion] = useState<Motion>(() =>
		document.documentElement.dataset.motion === "reduced" ? "reduced" : "full",
	);
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);
	useEffect(() => {
		document.documentElement.dataset.motion = motion;
	}, [motion]);

	const [view, setView] = useState<"chat" | "log" | "raw">("chat");
	const [autoApprove, setAutoApprove] = useState(true);
	const [telemetry, setTelemetry] = useState(false);
	const [agree, setAgree] = useState(true);
	const [preset, setPreset] = useState<"ask" | "auto" | "readonly">("ask");
	const [textSize, setTextSize] = useState(100);
	const [model, setModel] = useState("sonnet");
	const [query, setQuery] = useState("");
	const [prompt, setPrompt] = useState("");
	const [name, setName] = useState("my-app");
	const [loading, setLoading] = useState(false);
	const [working, setWorking] = useState(true);
	const [showHidden, setShowHidden] = useState(true);
	const [sort, setSort] = useState("recent");
	const [progress, setProgress] = useState(35);
	const [ring, setRing] = useState(42);

	return (
		<TooltipProvider>
			<div className="h-full overflow-y-auto bg-bg text-fg">
				<header className="sticky top-0 z-(--z-sticky) flex h-14 items-center gap-4 border-b border-border bg-glass px-8 backdrop-blur-xl">
					<Wordmark withMark />
					<span className="text-sm text-fg-faint">UI primitives</span>
					<div className="ml-auto flex items-center gap-3">
						<Segmented
							aria-label="Theme"
							value={theme}
							onValueChange={setTheme}
							options={[
								{ value: "light", label: "Light", icon: <Sun /> },
								{ value: "dark", label: "Dark", icon: <Moon /> },
							]}
						/>
						<Segmented
							aria-label="Motion"
							value={motion}
							onValueChange={setMotion}
							options={[
								{ value: "full", label: "Motion" },
								{ value: "reduced", label: "Reduced" },
							]}
						/>
					</div>
				</header>

				<main className="mx-auto max-w-5xl px-8 pb-24">
					<Section title="Brand">
						<Row label="Mark">
							<Mark size={16} />
							<Mark size={24} />
							<Mark size={40} title="visual-omp" />
							<Mark size={64} />
						</Row>
						<Row label="Wordmark">
							<Wordmark size="sm" />
							<Wordmark />
							<Wordmark size="lg" withMark />
							<Wordmark size="lg" blink />
						</Row>
						<Row label="Working">
							<WorkingIndicator label="Working… 14s" />
							<WorkingIndicator size="sm" label="Running tests" />
							<span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
								<PulseDot label="Working" />
								PulseDot
							</span>
						</Row>
						<Row label="Card working">
							<Card working={working} rail="agent" padding="sm" className="w-[320px]">
								<p className="text-md">Running tests</p>
								<p className="text-sm text-fg-muted">Signal shimmer replaces the border.</p>
							</Card>
						</Row>
						<Row label="GlowBorder">
							<GlowBorder active={working} radiusClassName="rounded-xl" className="w-[420px]">
								<Card className="rounded-xl shadow-(--shadow-composer)">
									<p className="text-md text-fg-muted">Composer — GlowBorder while omp is working.</p>
								</Card>
							</GlowBorder>
							<Switch label="Working" checked={working} onCheckedChange={setWorking} />
						</Row>
						<Row label="ContextRing">
							<ContextRing value={ring} showLabel />
							<ContextRing value={68} showLabel />
							<ContextRing value={91} showLabel />
							<ContextRing value={ring} size={32} />
							<div className="w-48">
								<Slider aria-label="Context used" value={ring} onValueChange={setRing} formatValue={(v) => `${v}%`} />
							</div>
						</Row>
					</Section>

					<Section title="Buttons">
						{(["primary", "secondary", "ghost", "danger", "danger-ghost"] as const).map((variant) => (
							<Row key={variant} label={variant}>
								<Button variant={variant} size="sm" icon={<Plus />}>
									Small
								</Button>
								<Button variant={variant}>Medium</Button>
								<Button variant={variant} size="lg" icon={<Play />}>
									Large
								</Button>
								<Button variant={variant} disabled>
									Disabled
								</Button>
								<Button variant={variant} loading>
									Loading
								</Button>
							</Row>
						))}
						<Row label="loading toggle">
							<Button
								variant="primary"
								loading={loading}
								onClick={() => {
									setLoading(true);
									setTimeout(() => setLoading(false), 1500);
								}}
							>
								Save changes
							</Button>
						</Row>
						<Row label="IconButton">
							<IconButton size="sm" label="Copy" icon={<Copy />} />
							<IconButton label="Restart" shortcut="⌘R" icon={<RotateCw />} />
							<IconButton size="lg" label="Settings" shortcut="⌘," icon={<Settings />} />
							<IconButton variant="secondary" label="Share" icon={<Share2 />} />
							<IconButton label="Show hidden files" pressed={showHidden} onClick={() => setShowHidden((v) => !v)} icon={<FolderOpen />} />
							<IconButton variant="danger-ghost" label="Delete" icon={<Trash2 />} />
							<IconButton label="Disabled" disabled icon={<Pencil />} />
						</Row>
						<Row label="Tooltip">
							<Tooltip content="Plain tooltip">
								<Button variant="ghost">Hover me</Button>
							</Tooltip>
							<Tooltip content="New session" shortcut="⌘N" side="bottom">
								<Button variant="ghost">With shortcut</Button>
							</Tooltip>
						</Row>
					</Section>

					<Section title="Chips, badges, status">
						<Row label="Chip">
							{(["accent", "blue", "agent", "ok", "warn", "err", "neutral"] as const).map((tone) => (
								<Chip key={tone} tone={tone} dot>
									{tone}
								</Chip>
							))}
						</Row>
						<Row label="Chip extras">
							<Chip tone="agent" icon={<Bot />}>
								reviewer
							</Chip>
							<Chip tone="neutral" icon={<GitBranch />} onRemove={() => toast({ message: "Removed main" })} removeLabel="Remove main">
								main
							</Chip>
						</Row>
						<Row label="Badge">
							<Badge count={3} label="3 unread" />
							<Badge count={128} />
							<Badge count={2} tone="err" label="2 failures" />
							<Badge count={7} tone="neutral" />
						</Row>
						<Row label="StatusDot">
							{(["ok", "warn", "err", "live", "idle", "agent"] as const).map((s) => (
								<span key={s} className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
									<StatusDot status={s} />
									{s}
								</span>
							))}
						</Row>
					</Section>

					<Section title="Segmented & tabs">
						<Row label="Segmented">
							<Segmented
								aria-label="Transcript view"
								value={view}
								onValueChange={setView}
								options={[
									{ value: "chat", label: "Chat" },
									{ value: "log", label: "Log" },
									{ value: "raw", label: "Raw", disabled: true },
								]}
							/>
							<Segmented
								size="sm"
								aria-label="Transcript view (small)"
								value={view}
								onValueChange={setView}
								options={[
									{ value: "chat", label: "Chat" },
									{ value: "log", label: "Log" },
									{ value: "raw", label: "Raw" },
								]}
							/>
							<Segmented aria-label="Disabled" disabled value="a" onValueChange={() => {}} options={[{ value: "a", label: "Disabled" }, { value: "b", label: "Group" }]} />
						</Row>
						<Tabs defaultValue="files">
							<TabsList size="sm" aria-label="Window tabs">
								<TabsTrigger value="files">Files</TabsTrigger>
								<TabsTrigger value="changes" trailing={<Badge count={4} tone="neutral" />}>
									Changes
								</TabsTrigger>
								<TabsTrigger value="term">Terminal</TabsTrigger>
								<TabsTrigger value="off" disabled>
									Disabled
								</TabsTrigger>
							</TabsList>
							<TabsContent value="files" className="py-3 text-md text-fg-muted">
								Underline tabs (28px, window style).
							</TabsContent>
							<TabsContent value="changes" className="py-3 text-md text-fg-muted">
								4 changed files.
							</TabsContent>
							<TabsContent value="term" className="py-3 text-md text-fg-muted">
								Terminal output.
							</TabsContent>
						</Tabs>
						<Tabs defaultValue="plan">
							<TabsList aria-label="Dock tabs">
								<TabsTrigger value="plan">Plan</TabsTrigger>
								<TabsTrigger value="tasks">Tasks</TabsTrigger>
								<TabsTrigger value="usage">Usage</TabsTrigger>
							</TabsList>
						</Tabs>
						<Tabs defaultValue="all">
							<TabsList variant="pill" aria-label="Filter">
								<TabsTrigger value="all">All</TabsTrigger>
								<TabsTrigger value="installed">Installed</TabsTrigger>
								<TabsTrigger value="updates">Updates</TabsTrigger>
							</TabsList>
						</Tabs>
					</Section>

					<Section title="Menus & popovers">
						<Row>
							<Menu>
								<MenuTrigger asChild>
									<Button iconRight={<MoreHorizontal />}>Dropdown</Button>
								</MenuTrigger>
								<MenuContent>
									<MenuLabel>Session</MenuLabel>
									<MenuItem icon={<Pencil />} shortcut="F2">
										Rename
									</MenuItem>
									<MenuItem icon={<Copy />} shortcut="⌘D">
										Duplicate
									</MenuItem>
									<MenuItem icon={<Archive />} disabled>
										Archive
									</MenuItem>
									<MenuSub label="Share" icon={<Share2 />}>
										<MenuItem>Copy link</MenuItem>
										<MenuItem>Invite…</MenuItem>
									</MenuSub>
									<MenuSeparator />
									<MenuCheckboxItem checked={showHidden} onCheckedChange={setShowHidden}>
										Show hidden files
									</MenuCheckboxItem>
									<MenuSeparator />
									<MenuLabel>Sort</MenuLabel>
									<MenuRadioGroup value={sort} onValueChange={setSort}>
										<MenuRadioItem value="recent">Recent</MenuRadioItem>
										<MenuRadioItem value="name">Name</MenuRadioItem>
									</MenuRadioGroup>
									<MenuSeparator />
									<MenuItem icon={<Trash2 />} danger shortcut="⌘⌫">
										Delete
									</MenuItem>
								</MenuContent>
							</Menu>
							<ContextMenu>
								<ContextMenuTrigger asChild>
									<div className="flex h-16 w-64 items-center justify-center rounded-lg border border-dashed border-border-strong text-sm text-fg-faint">
										Right-click here
									</div>
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuLabel>File</ContextMenuLabel>
									<ContextMenuItem icon={<FolderOpen />}>Open</ContextMenuItem>
									<ContextMenuItem icon={<Copy />} shortcut="⌘C">
										Copy path
									</ContextMenuItem>
									<ContextMenuSub label="Open with">
										<ContextMenuItem>Editor</ContextMenuItem>
										<ContextMenuItem>Finder</ContextMenuItem>
									</ContextMenuSub>
									<ContextMenuCheckboxItem checked={showHidden} onCheckedChange={setShowHidden}>
										Show hidden
									</ContextMenuCheckboxItem>
									<ContextMenuSeparator />
									<ContextMenuItem icon={<Trash2 />} danger>
										Delete
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
							<Popover>
								<PopoverTrigger asChild>
									<Button variant="ghost">Popover</Button>
								</PopoverTrigger>
								<PopoverContent width={280}>
									<div className="flex items-center gap-3">
										<ContextRing value={62} size={32} />
										<div>
											<p className="font-medium">124k / 200k tokens</p>
											<p className="text-sm text-fg-muted">62% of context used</p>
										</div>
									</div>
									<div className="mt-3 flex justify-end gap-2">
										<Button size="sm" variant="ghost">
											Change model
										</Button>
										<Button size="sm" variant="primary">
											Compact now
										</Button>
									</div>
								</PopoverContent>
							</Popover>
						</Row>
					</Section>

					<Section title="Dialogs & sheets">
						<Row>
							{(["sm", "md", "lg"] as const).map((size) => (
								<Dialog key={size}>
									<DialogTrigger asChild>
										<Button>Dialog {size}</Button>
									</DialogTrigger>
									<DialogContent
										size={size}
										title="Start a new project"
										description="Pick a folder and omp will set things up."
										footer={
											<>
												<DialogClose asChild>
													<Button variant="ghost">Cancel</Button>
												</DialogClose>
												<DialogClose asChild>
													<Button variant="primary">Create project</Button>
												</DialogClose>
											</>
										}
									>
										<Input label="Project name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
									</DialogContent>
								</Dialog>
							))}
							<Dialog>
								<DialogTrigger asChild>
									<Button variant="danger-ghost" icon={<Trash2 />}>
										Destructive
									</Button>
								</DialogTrigger>
								<DialogContent
									destructive
									size="sm"
									title="Delete this session?"
									description="The conversation and its checkpoints will be removed. This can't be undone."
									footer={
										<>
											<DialogClose asChild>
												<Button variant="ghost">Cancel</Button>
											</DialogClose>
											<DialogClose asChild>
												<Button variant="danger">Delete session</Button>
											</DialogClose>
										</>
									}
								/>
							</Dialog>
							<Sheet>
								<SheetTrigger asChild>
									<Button>Right sheet</Button>
								</SheetTrigger>
								<SheetContent
									width={420}
									title="Model roles"
									description="Which model does what"
									actions={<IconButton size="sm" label="Reset" icon={<RotateCw />} />}
									footer={
										<>
											<SheetClose asChild>
												<Button variant="ghost">Cancel</Button>
											</SheetClose>
											<Button variant="primary">Save</Button>
										</>
									}
								>
									<div className="flex flex-col gap-3">
										{Array.from({ length: 24 }, (_, i) => (
											<Skeleton key={i} shape="text" />
										))}
									</div>
								</SheetContent>
							</Sheet>
							<Sheet>
								<SheetTrigger asChild>
									<Button>Bottom sheet</Button>
								</SheetTrigger>
								<SheetContent side="bottom" height={320} title="Terminal">
									<p className="font-mono text-code text-fg-muted">$ omp --version</p>
								</SheetContent>
							</Sheet>
						</Row>
					</Section>

					<Section title="Toasts">
						<Row>
							<Button onClick={() => toast({ message: "Settings saved" })}>Info</Button>
							<Button
								onClick={() =>
									toast({ tone: "ok", message: "Session archived", action: { label: "Undo", onClick: () => toast({ message: "Restored" }) } })
								}
							>
								Success + undo
							</Button>
							<Button onClick={() => toast({ tone: "warn", message: "Context almost full", description: "Compact soon to keep going." })}>
								Warn
							</Button>
							<Button onClick={() => toast({ tone: "err", message: "omp crashed", description: "Restart to continue." })}>Error</Button>
							<Button onClick={() => toast({ message: "Sticky info", sticky: true })}>Sticky</Button>
						</Row>
					</Section>

					<Section title="Form controls">
						<div className="grid grid-cols-2 gap-8">
							<div className="flex flex-col gap-4">
								<Switch
									label="Auto-approve file edits"
									description="omp can change files without asking each time."
									checked={autoApprove}
									onCheckedChange={setAutoApprove}
								/>
								<Switch label="Send anonymous usage stats" checked={telemetry} onCheckedChange={setTelemetry} />
								<Switch label="Disabled" disabled checked />
								<Row>
									<Switch aria-label="Bare switch" checked={autoApprove} onCheckedChange={setAutoApprove} />
								</Row>
								<Checkbox label="I understand" description="omp may run commands in this folder." checked={agree} onCheckedChange={setAgree} />
								<Checkbox label="Indeterminate" indeterminate />
								<Checkbox label="Disabled" disabled />
								<RadioGroup
									label="Permissions"
									value={preset}
									onValueChange={setPreset}
									options={[
										{ value: "ask", label: "Ask me first", description: "Recommended" },
										{ value: "auto", label: "Just do it" },
										{ value: "readonly", label: "Read only", disabled: true },
									]}
								/>
							</div>
							<div className="flex flex-col gap-4">
								<Input label="Project name" value={name} onChange={(e) => setName(e.currentTarget.value)} description="Lowercase, no spaces." />
								<Input size="sm" placeholder="Small" icon={<GitBranch />} />
								<Input size="lg" placeholder="Large" />
								<Input label="API key" placeholder="sk-…" error="That key didn't work — check for typos." />
								<Input placeholder="Disabled" disabled />
								<SearchInput value={query} onValueChange={setQuery} placeholder="Search sessions" hint={<Kbd>⌘K</Kbd>} />
								<Textarea
									label="Prompt"
									placeholder="Ask omp anything… (grows 2–6 rows)"
									minRows={2}
									maxRows={6}
									value={prompt}
									onChange={(e) => setPrompt(e.currentTarget.value)}
								/>
								<div className="flex items-center gap-3">
									<Select value={model} onValueChange={setModel} aria-label="Model" icon={<Sparkles />} className="w-56">
										<SelectGroup>
											<SelectLabel>Anthropic</SelectLabel>
											<SelectItem value="sonnet" hint="fast">
												Claude Sonnet
											</SelectItem>
											<SelectItem value="opus" hint="smart">
												Claude Opus
											</SelectItem>
										</SelectGroup>
										<SelectSeparator />
										<SelectItem value="gpt" disabled>
											GPT (not configured)
										</SelectItem>
									</Select>
									<Select size="sm" placeholder="Pick one…" aria-label="Small select">
										<SelectItem value="a">Alpha</SelectItem>
										<SelectItem value="b">Beta</SelectItem>
									</Select>
									<Select disabled placeholder="Disabled" aria-label="Disabled select">
										<SelectItem value="a">Alpha</SelectItem>
									</Select>
								</div>
								<div>
									<p className="mb-2 text-sm text-fg-muted">Text size {textSize}%</p>
									<Slider
										aria-label="Text size"
										value={textSize}
										onValueChange={setTextSize}
										min={90}
										max={130}
										step={5}
										formatValue={(v) => `${v}%`}
									/>
								</div>
								<Slider aria-label="Disabled slider" value={40} onValueChange={() => {}} disabled />
							</div>
						</div>
					</Section>

					<Section title="Progress & loading">
						<Row label="Spinner">
							<Spinner />
							<Spinner size={20} className="text-accent" label="Loading" />
							<Spinner className="text-agent" />
						</Row>
						<div className="flex max-w-md flex-col gap-4">
							<Progress aria-label="Installing omp" value={progress} showValue />
							<Progress aria-label="Downloading" tone="ok" value={100} showValue />
							<Progress aria-label="Indexing files" showValue />
							<Row>
								<Button size="sm" onClick={() => setProgress((p) => (p >= 100 ? 0 : p + 15))}>
									Advance
								</Button>
							</Row>
						</div>
						<Row label="StepDots">
							<StepDots total={4} current={1} showLabel />
							<StepDots total={6} current={4} />
						</Row>
						<Row label="Skeleton">
							<div className="flex w-80 items-center gap-3">
								<Skeleton shape="circle" />
								<div className="flex flex-1 flex-col gap-2">
									<Skeleton shape="text" width="70%" />
									<Skeleton shape="text" width="45%" />
								</div>
							</div>
							<Skeleton width={200} height={64} />
						</Row>
					</Section>

					<Section title="Display & layout">
						<Row label="Kbd">
							<span className="inline-flex gap-1">
								<Kbd>⌘</Kbd>
								<Kbd>K</Kbd>
							</span>
							<Kbd>Esc</Kbd>
							<Kbd>⇧⌘P</Kbd>
						</Row>
						<Row label="BracketLabel">
							<BracketLabel>Recent sessions</BracketLabel>
							<BracketLabel tone="accent">Plan</BracketLabel>
							<BracketLabel tone="agent">Agent</BracketLabel>
						</Row>
						<Row label="Divider">
							<div className="flex w-80 flex-col gap-4">
								<Divider />
								<Divider label="or" />
							</div>
							<div className="flex h-8 items-center gap-3 text-sm text-fg-muted">
								Left
								<Divider orientation="vertical" />
								Right
							</div>
						</Row>
						<div className="grid grid-cols-3 gap-4">
							<Card>
								<p className="font-medium">Plain card</p>
								<p className="mt-1 text-sm text-fg-muted">Panel, 1px border, 12px radius.</p>
							</Card>
							<Card floating interactive>
								<p className="font-medium">Floating + interactive</p>
								<p className="mt-1 text-sm text-fg-muted">Hover lifts.</p>
							</Card>
							<Card rail="agent" padding="sm">
								<p className="font-medium">Agent rail</p>
								<p className="mt-1 text-sm text-fg-muted">Status rail tone.</p>
							</Card>
							{(["accent", "blue", "ok", "warn", "err", "info"] as const).map((rail) => (
								<Card key={rail} rail={rail} padding="sm">
									<p className="text-sm font-medium">rail="{rail}"</p>
								</Card>
							))}
						</div>
						<ScrollArea className="h-40 w-80 rounded-lg border border-border bg-panel" focusable aria-label="Scrollable list">
							<ul className="p-2">
								{Array.from({ length: 30 }, (_, i) => (
									<li key={i} className="flex h-9 items-center rounded-sm px-2 text-md hover:bg-hover">
										Session {i + 1}
									</li>
								))}
							</ul>
						</ScrollArea>
						<Card>
							<EmptyState
								icon={<Inbox />}
								eyebrow={<BracketLabel>Sessions</BracketLabel>}
								title="No sessions yet"
								body="Start a conversation and omp will keep it here."
								actions={
									<>
										<Button variant="primary" icon={<Plus />}>
											New session
										</Button>
										<Button variant="ghost">Learn more</Button>
									</>
								}
							/>
						</Card>
						<Card>
							<EmptyState art={<Mark size={56} />} title="Ready when you are" body="Art slot variant." />
						</Card>
					</Section>
				</main>
			</div>
			<Toaster />
		</TooltipProvider>
	);
}
