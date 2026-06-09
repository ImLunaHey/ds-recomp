// Boot one of the sprite test ROMs and report state.
import { readFileSync } from 'node:fs';
import { Emulator } from '../emulator';

const romName = process.argv[2] ?? 'test_obj_mosaic.nds';
const rom = readFileSync(`public/${romName}`);
const emu = new Emulator();
emu.loadRom(rom);

console.log(`title: "${emu.header!.title}" code: ${emu.header!.gameCode}`);
console.log(`ARM9 entry: 0x${emu.header!.arm9EntryAddr.toString(16)}`);
console.log(`ARM7 entry: 0x${emu.header!.arm7EntryAddr.toString(16)}\n`);

const frames = parseInt(process.argv[3] ?? '120', 10);
let lastDisp = 0;
let lastIpc = '-';
for (let i = 0; i < frames; i++) {
  emu.runFrame();
  const ipc = `${emu.ipc.sync9Out}-${emu.ipc.sync7Out}`;
  if (emu.ppu.dispcntA !== lastDisp || ipc !== lastIpc) {
    console.log(`f${String(i).padStart(3)} | dispcntA=0x${emu.ppu.dispcntA.toString(16)} dispcntB=0x${emu.ppu.dispcntB.toString(16)} | s9/s7=${ipc} | pc9=0x${emu.cpu9.state.r[15].toString(16)} pc7=0x${emu.cpu7.state.r[15].toString(16)} | h9=${emu.cpu9.state.halted?1:0} h7=${emu.cpu7.state.halted?1:0}`);
    lastDisp = emu.ppu.dispcntA;
    lastIpc = ipc;
  }
}

// Check if VRAM has any non-zero content (signs of rendering)
let nonZero = 0;
for (let i = 0; i < emu.mem.vram.length; i++) if (emu.mem.vram[i] !== 0) { nonZero++; if (nonZero === 1) console.log(`\nFirst non-zero VRAM byte: 0x${i.toString(16)}`); }
console.log(`Total non-zero VRAM bytes: ${nonZero}`);
console.log(`Final ARM9 PC: 0x${emu.cpu9.state.r[15].toString(16)}  ARM7 PC: 0x${emu.cpu7.state.r[15].toString(16)}`);
console.log(`Final IME9=${emu.irq9.ime} IME7=${emu.irq7.ime} IE9=0x${emu.irq9.ie.toString(16)} IE7=0x${emu.irq7.ie.toString(16)}`);
