/**
 * The build bundle's merge rule, extracted pure so a unit test can pin it:
 * the decrypted-bundle route is reachable only through a GitHub Actions OIDC
 * grant, which e2e cannot mint.
 *
 * Runtime env rides into builds because frameworks inline env at build time -
 * a SvelteKit `PUBLIC_*` value that exists only as a runtime binding never
 * reaches the client bundle. The build-specific stores stay separate and WIN
 * on a name collision: they exist precisely to say "at build time, this
 * instead".
 */
export function mergeBuildEnv(
	runtime: { vars: Record<string, string>; secrets: Record<string, string> },
	build: { vars: Record<string, string>; secrets: Record<string, string> },
): { vars: Record<string, string>; secrets: Record<string, string> } {
	return {
		vars: { ...runtime.vars, ...build.vars },
		secrets: { ...runtime.secrets, ...build.secrets },
	};
}
