import { signAsync } from "@electron/osx-sign";

/**
 * electron-builder's `mac.sign` hook. Release builds set VOMP_MAC_IDENTITY to the name of the project's own
 * code signing certificate, which the release workflow imports into a temporary keychain and passes in as
 * CSC_KEYCHAIN (electron-builder hands it over as `options.keychain`). Every release then carries the same
 * designated requirement, naming that certificate instead of the build's own hash. macOS records the permissions
 * a person grants visual-omp (App Management, for example) against that requirement, so they are meant to carry
 * over to the next version. Without the variable the app is signed ad hoc, as local and CI builds always were.
 *
 * The certificate is self-signed, so `security find-identity -v` doesn't list it as valid and
 * electron-builder can't select it itself; `mac.identity` stays "-" and this hook swaps the identity in.
 * `identityValidation: false` makes osx-sign use the name as given instead of looking it up among valid
 * identities; codesign's own signature verification still runs.
 */
export default async function sign(options) {
	const identity = process.env.VOMP_MAC_IDENTITY?.trim();
	if (!identity) return signAsync(options);
	if (!options.keychain) throw new Error("VOMP_MAC_IDENTITY is set, but no keychain holds the certificate (set CSC_KEYCHAIN)");
	return signAsync({ ...options, identity, identityValidation: false });
}
