/**
 * References to secrets held outside the repository (ADR-0013).
 *
 * The {@link Secret} value object lives in `domain`, because the logger has to recognise one
 * without depending on configuration.
 */

/** A reference to a secret held outside the repository. */
export type SecretRef = { readonly env: string } | { readonly file: string };

export function isEnvironmentRef(ref: SecretRef): ref is { readonly env: string } {
  return 'env' in ref;
}

export function describeSecretRef(ref: SecretRef): string {
  return isEnvironmentRef(ref) ? `env:${ref.env}` : `file:${ref.file}`;
}
