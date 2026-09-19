// Local-only fork: cloud account controls removed.
// This component previously rendered the InsForge avatar / sign-in button.
// It now renders nothing so existing call sites keep working unchanged.
export function InsforgeUserHeaderControls() {
  return null;
}
