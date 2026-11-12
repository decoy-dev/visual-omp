export type FixtureEnvironment = NodeJS.ProcessEnv & {
  HOME: string;
  USERPROFILE: string;
  PI_CODING_AGENT_DIR: string;
  TMPDIR: string;
  VOMP_DEV_PROFILE: string;
};
export function fixtureEnvironment(root: string): FixtureEnvironment;
export function initializeFixture(root: string, baseUrl: string): Promise<FixtureEnvironment>;
export function requireFixture(root: string): Promise<FixtureEnvironment>;
