/** DLL names in a PE file's import table. */
export function peImports(pe: Buffer) {
  const header = pe.readUInt32LE(0x3c);
  if (pe.toString('latin1', header, header + 4) !== 'PE\0\0') return [];
  const sections = pe.readUInt16LE(header + 6), optional = header + 24, table = optional + pe.readUInt16LE(header + 20);
  const offset = (rva: number) => {
    for (let s = table; s < table + sections * 40; s += 40) {
      const start = pe.readUInt32LE(s + 12);
      if (rva >= start && rva < start + Math.max(pe.readUInt32LE(s + 8), pe.readUInt32LE(s + 16))) return rva - start + pe.readUInt32LE(s + 20);
    }
    throw new Error(`RVA ${rva} is outside every section`);
  };
  const imports = pe.readUInt32LE(optional + (pe.readUInt16LE(optional) === 0x20b ? 120 : 104));
  const names: string[] = [];
  if (imports) for (let entry = offset(imports); pe.readUInt32LE(entry + 12); entry += 20) {
    const name = offset(pe.readUInt32LE(entry + 12));
    names.push(pe.toString('latin1', name, pe.indexOf(0, name)));
  }
  return names;
}
