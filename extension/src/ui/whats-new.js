/** Release notes shown once after an update (popup) and always in Settings. */
export const WHATS_NEW = {
  version: '3.3.0',
  title: 'Faster, simpler, and works on empty chats',
  items: [
    'The Transfer button is always there — on a new chat it brings in a saved brief.',
    'Every item in the Transfer menu now works, including Open Library.',
    'Lighter on the page: no more slowdowns while you type or scroll.',
    'Clearer messages when ContextPort AI can’t be reached.',
    'Hit a usage limit? ContextPort offers to continue elsewhere in one click.',
    'Save checkpoints and group them into projects in the Library.',
    'Encrypted share links, Markdown and Obsidian export.',
    'Your About me card and snippets — type // in any chat box.',
    'Rate briefs to help us make them better.',
  ],
};

export function formatMinutes(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
