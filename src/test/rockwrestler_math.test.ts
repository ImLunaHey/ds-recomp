// RockWrestler category #3 sub-test matrix — runs in parallel with the
// other 5 category files (vitest's default file-level parallelism).
import { describe, it, expect } from 'vitest';
import { SUBMENUS, haveRom, runSubTest } from './rockwrestler_helpers';

const i = 3;
const submenu = SUBMENUS[i];

describe.skipIf(!haveRom)(`RockWrestler ${submenu.name}`, () => {
  for (let j = 0; j < submenu.children.length; j++) {
    const child = submenu.children[j];
    const expectedToDrawOk = child.type === 0;
    const label = `${child.name} ${expectedToDrawOk ? 'reaches OK' : 'runs (type-2)'}`;
    it(label, { timeout: 30000 }, () => {
      expect(runSubTest(i, j, child)).toBe(true);
    });
  }
});
