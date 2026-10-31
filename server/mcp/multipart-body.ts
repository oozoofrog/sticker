/** Track the application-owned FormData encoder separately from the HTTP response. */
export function trackedMultipart(form: FormData) {
  const encoded = new Request("http://127.0.0.1/", {
    method: "POST",
    body: form,
  });
  if (!encoded.body) throw new Error("Multipart encoder body missing");
  const reader = encoded.body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined,
    stopped = false,
    done = false,
    pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined,
    disposing: Promise<void> | undefined,
    resolveSettled: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const finish = () => {
    if (done) return;
    done = true;
    try {
      reader.releaseLock();
    } catch {
      /* A pending reader is awaited by dispose. */
    }
    resolveSettled?.();
  };
  const dispose = () => {
    if (disposing) return disposing;
    if (done) return settled;
    stopped = true;
    try {
      controller?.error(new Error("Multipart body ownership released"));
    } catch {
      /* The fetch consumer may already have canceled. */
    }
    disposing = (async () => {
      try {
        // Node24's native FormData encoder can enqueue after reader.cancel()
        // has closed its stream. Stop the outward stream now, but keep owning
        // the encoder/Blob until its pending read and sequential EOF drain settle.
        let chunk = await (pending ?? reader.read());
        while (!chunk.done) chunk = await reader.read();
      } finally {
        finish();
      }
    })();
    return disposing;
  };
  const isStopped = () => stopped;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(value) {
      if (stopped) return;
      try {
        pending = reader.read();
        const chunk = await pending;
        pending = undefined;
        if (isStopped()) return;
        if (chunk.done) {
          value.close();
          finish();
        } else value.enqueue(chunk.value);
      } catch (error) {
        pending = undefined;
        try {
          value.error(error);
        } finally {
          // A rejected encoder read is already settled. Preserve the outward
          // failure; disposal also propagates a rejection when it owns the read.
          finish();
        }
      }
    },
    async cancel() {
      await dispose();
    },
  });
  return {
    body,
    contentType: encoded.headers.get("content-type") ?? "",
    settled,
    dispose,
  };
}
