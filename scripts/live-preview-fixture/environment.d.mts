export function fixtureEnvironment(root: string): NodeJS.ProcessEnv & { HOME: string; PI_CODING_AGENT_DIR: string; VOMP_DEV_PROFILE: string };
export function initializeFixture(root: string, baseUrl: string): Promise<ReturnType<typeof fixtureEnvironment>>;
export function requireFixture(root: string): Promise<ReturnType<typeof fixtureEnvironment>>;
