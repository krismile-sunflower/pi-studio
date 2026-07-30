import { describe, expect, it } from 'vitest';
import { isInteractiveExtensionRequest } from './extension-ui';

describe('extension UI requests', () => {
  it.each(['select', 'confirm', 'input', 'editor'])('keeps %s requests interactive', (method) => {
    expect(isInteractiveExtensionRequest({ id: 'interactive', method })).toBe(true);
  });

  it.each(['notify', 'setWidget', 'setStatus', 'setTitle', 'set_editor_text'])(
    'does not turn %s events into blocking dialogs',
    (method) => {
      expect(isInteractiveExtensionRequest({ id: 'fire-and-forget', method })).toBe(false);
    },
  );
});
