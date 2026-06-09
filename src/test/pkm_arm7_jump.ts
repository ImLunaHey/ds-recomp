// Trap the exact moment ARM7's PC first crosses into the BSS zero
// region. Capture the OLD PC, the instruction at that PC, and the
// affected registers — that's the wild jump's origin.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const rom = readFileSync('public/Pokemon - Platinum Version (USA) (Rev 1).nds');
const emu = new Emulator();
emu.loadRom(rom);

// Per the autoload: entry 1 dest 0x037F8000, code 0xEC94, bss 0x4238.
// BSS spans 0x037F8000 + 0xEC94 .. 0x037F8000 + 0xEC94 + 0x4238
// = 0x03806C94 .. 0x0380AECC
// But wait: 0x037F8000 + N wraps mod 0x10000 in our IWRAM model:
//   N in [0, 0x8000): addr 0x037F8000..0x037FFFFF → IWRAM[0x8000..0xFFFF]
//   N in [0x8000, 0xEC94): addr 0x03800000..0x03806C94 → IWRAM[0..0x6C94]
//   BSS is at N in [0xEC94, 0x12ECC): so dest addrs 0x03806C94..0x0380AECC,
//   which map to IWRAM[0x6C94..0xAECC] when accessed through 0x038xxxxx.
// We need to catch ARM7 jumping into the 0x6C94..0xAECC range (or
// equivalently the addresses 0x03806C94..0x0380AECC, OR their
// shared-WRAM-area equivalent if accessed via 0x037xxxxx wrap).
// Entry 1's BSS spans IWRAM[0x6C94..0xAECC]. Through the WRAMCNT=0
// mirror at 0x037xxxxx, that's addresses 0x037F6C94..0x037FAECC.
const BSS_LO = 0x037F6C94, BSS_HI = 0x037FAECC;

let prev = 0;
let triggered = false;
const orig7 = emu.cpu7.step.bind(emu.cpu7);
emu.cpu7.step = () => {
  if (triggered) return orig7();
  const pc = emu.cpu7.state.r[15] & ~3;
  // Detect the FIRST step where ARM7 is in BSS AND wasn't already.
  if (pc >= BSS_LO && pc < BSS_HI && (prev < BSS_LO || prev >= BSS_HI)) {
    console.log(`!! ARM7 jumped from 0x${prev.toString(16)} to 0x${pc.toString(16)}`);
    console.log(`   insn at prev: 0x${emu.bus7.read32(prev).toString(16).padStart(8, '0')}`);
    console.log(`   insn at curr: 0x${emu.bus7.read32(pc).toString(16).padStart(8, '0')}`);
    console.log(`   LR=0x${emu.cpu7.state.r[14].toString(16)} SP=0x${emu.cpu7.state.r[13].toString(16)}`);
    console.log(`   R0-R7: ${[0,1,2,3,4,5,6,7].map(i => '0x' + emu.cpu7.state.r[i].toString(16)).join(' ')}`);
    triggered = true;
  }
  prev = pc;
  return orig7();
};

for (let i = 0; i < 30; i++) emu.runFrame();

if (!triggered) console.log(`No jump into BSS detected.`);
