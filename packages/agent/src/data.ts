/**
 * Fences tenant text as data (AGT-07, FEAT-025 §5.3): no value can close or open a
 * prompt block, forge a slot token or start a new line of instructions. Only the prompt
 * sees this form; slots render the stored value.
 */
export function asData(text: string): string {
  return text
    .replaceAll('<', '‹')
    .replaceAll('>', '›')
    .replaceAll('[[', '⟦')
    .replaceAll(']]', '⟧')
    .replace(/\s*[\r\n]+\s*/g, ' ');
}
