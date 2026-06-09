// Trace the relative order of "autoload memcpy LDR" vs "BSS clear STR"
// to confirm whether the BSS clear actually runs before or after.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

let autoloadLDRs = 0;
let bssSTRs = 0;
const events: string[] = [];

const origStep = emu.cpu9.step.bind(emu.cpu9);
emu.cpu9.step = () => {
  const decode = emu.cpu9.state.r[15] & ~3;
  if (decode === 0x02000A50) {
    autoloadLDRs++;
    if (autoloadLDRs === 1) events.push(`step ${steps}: FIRST autoload LDR at decode 0x${decode.toString(16)}, R3=0x${emu.cpu9.state.r[3].toString(16)}, [R3]=0x${emu.bus9.read32(emu.cpu9.state.r[3]).toString(16)}`);
    if (autoloadLDRs === 432) events.push(`step ${steps}: LAST autoload LDR (432th), R3=0x${emu.cpu9.state.r[3].toString(16)}`);
  }
  if (decode === 0x020008C8) {
    bssSTRs++;
    if (bssSTRs === 1) events.push(`step ${steps}: FIRST BSS clear STR, R1=0x${emu.cpu9.state.r[1].toString(16)}, R2(end)=0x${emu.cpu9.state.r[2].toString(16)}`);
    if (bssSTRs === 432) events.push(`step ${steps}: 432th BSS clear STR, R1=0x${emu.cpu9.state.r[1].toString(16)}`);
  }
  steps++;
  return origStep();
};
let steps = 0;

for (let i = 0; i < 5; i++) emu.runFrame();

console.log(`autoload LDRs: ${autoloadLDRs}, BSS STRs: ${bssSTRs}`);
console.log('Events in order:');
for (const e of events) console.log('  ' + e);
