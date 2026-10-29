interface Semver {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `1.2.3`, `v1.2.3-beta.1+build`; null when not semver. */
export function parseSemver(version: string): Semver | null {
	const match = SEMVER.exec(version.trim());
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ? match[4].split(".") : [],
	};
}

function compareIdentifiers(a: string, b: string): number {
	const numA = /^\d+$/.test(a);
	const numB = /^\d+$/.test(b);
	if (numA && numB) return Number(a) - Number(b);
	if (numA) return -1;
	if (numB) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence, ignoring build metadata. Unparseable versions sort lowest. */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
	const core = pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
	if (core !== 0) return core;
	if (pa.prerelease.length === 0 || pb.prerelease.length === 0) return pb.prerelease.length - pa.prerelease.length;
	const length = Math.max(pa.prerelease.length, pb.prerelease.length);
	for (let i = 0; i < length; i++) {
		const idA = pa.prerelease[i];
		const idB = pb.prerelease[i];
		if (idA === undefined) return -1;
		if (idB === undefined) return 1;
		const diff = compareIdentifiers(idA, idB);
		if (diff !== 0) return diff;
	}
	return 0;
}
