// Fixture only; not included in the installer bundle.
globalThis.StickerWriteCandidate = (() => {
  const validName = (name) =>
    typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name);
  const boundedUtf8 = (value) => {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < value.length &&
        value.charCodeAt(i + 1) >= 0xdc00 &&
        value.charCodeAt(i + 1) <= 0xdfff
      ) {
        bytes += 4;
        i++;
      } else bytes += 3;
      if (bytes > 2097152) return false;
    }
    return true;
  };
  function writeNew(io, parent, name, value) {
    const result = { state: "unverified", published: false };
    let dir = null,
      fd = null,
      tempName = null,
      created = false;
    const fail = (code) => {
      throw new Error(code);
    };
    try {
      if (
        typeof parent !== "string" ||
        !parent.startsWith("/") ||
        parent.includes("\0") ||
        parent.split("/").some((p) => p === "." || p === "..") ||
        !validName(name) ||
        typeof value !== "string" ||
        !boundedUtf8(value)
      )
        fail("input_unverified");
      dir = io.openParent(parent);
      if (!Number.isInteger(dir) || dir < 0) {
        dir = null;
        fail("parent_unverified");
      }
      const temp = io.createTemp(dir);
      if (!Number.isInteger(temp.fd) || temp.fd < 0) fail("temp_unverified");
      fd = temp.fd;
      created = true;
      if (
        typeof temp.name !== "string" ||
        !/^\.sticker-write\.[A-Za-z0-9]{12}$/.test(temp.name)
      )
        fail("temp_name_unverified");
      tempName = temp.name;
      io.write(fd, value);
      io.sync(fd);
      const closing = fd;
      fd = null; // close errors never cause a second close of a possibly reused fd.
      io.close(closing);
      io.publish(dir, tempName, name);
      result.published = true;
      result.state = "published";
      io.sync(dir);
    } catch (error) {
      result.error =
        error instanceof Error && /^[a-z_]{1,50}$/.test(error.message)
          ? error.message
          : "native_unverified";
      if (result.published) result.state = "published_unverified";
    } finally {
      if (fd !== null) {
        try {
          io.close(fd);
        } catch {
          result.cleanup = "unverified";
        }
      }
      if (created && !result.published) {
        if (tempName === null)
          result.cleanup = "unverified"; // Unknown name is never unlinked.
        else {
          try {
            io.remove(dir, tempName);
          } catch {
            result.cleanup = "unverified";
          }
        }
      }
      if (dir !== null) {
        try {
          io.close(dir);
        } catch {
          result.cleanup = "unverified";
        }
      }
      if (result.cleanup && result.published)
        result.state = "published_unverified";
    }
    return result;
  }
  return { writeNew };
})();
