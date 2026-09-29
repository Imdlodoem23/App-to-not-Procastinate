/**
 * Lets a cross-module test skip itself while another builder's module is still a stub
 * (lead-owned). Usage: `describe.runIf(implemented(() => createGenericClassifier()))(…)`.
 * Remove the guards once every module has landed (the coordinator checks none are left).
 */
export function implemented(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch (error) {
    return !(error instanceof Error && error.message.startsWith('not implemented'));
  }
}
