/** Bounded store-only ZIP, fixed filenames only. No archive extraction or shell. */
export function buildAgentInstallZip(
  files: { name: string; content: Buffer; executable?: boolean }[],
): Buffer {
  if (files.length < 1 || files.length > 30)
    throw new Error("Invalid bundle file count");
  const names = new Set<string>();
  let total = 0;
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    if (
      !/^[A-Za-z0-9._ /-]+$/.test(file.name) ||
      file.name.startsWith("/") ||
      file.name
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      names.has(file.name)
    )
      throw new Error("Invalid bundle path");
    names.add(file.name);
    total += file.content.length;
    if (total > 2 * 1024 * 1024) throw new Error("Bundle size exceeds limit");
    const name = Buffer.from(`Sticker-Agent-Install/${file.name}`, "utf8");
    const checksum = crc32(file.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(file.content.length, 18);
    header.writeUInt32LE(file.content.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, file.content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(file.content.length, 20);
    directory.writeUInt32LE(file.content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(
      ((file.executable ? 0o100700 : 0o100600) << 16) >>> 0,
      38,
    );
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + file.content.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, end]);
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
