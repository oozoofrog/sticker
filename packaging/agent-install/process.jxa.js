/* OS-only subprocess transport. stdout remains in memory; stderr is discarded. */
ObjC.import("Foundation");
globalThis.StickerHostProcess = (() => {
  function isNil(value) {
    return (
      value === null ||
      value === undefined ||
      (typeof value.isNil === "function" && value.isNil())
    );
  }
  const channels = {};
  const newline = $("\n").dataUsingEncoding($.NSUTF8StringEncoding);
  ObjC.registerSubclass({
    name: "StickerInstallPipeObserverV1",
    superclass: "NSObject",
    methods: {
      "readCompleted:": {
        types: ["void", ["id"]],
        implementation: function (notification) {
          const handle = notification.object;
          const state = channels[String(handle.fileDescriptor)];
          if (!state || state.closed) return;
          const data = notification.userInfo.objectForKey(
            $.NSFileHandleNotificationDataItem,
          );
          if (isNil(data)) {
            state.failed = true;
            return;
          }
          const length = Number(data.length);
          if (!length) {
            state.eof = true;
            return;
          }
          state.total += length;
          if (state.total > 2 * 1024 * 1024) {
            state.failed = true;
            return;
          }
          if (!state.discard) state.buffer.appendData(data);
          void handle.readInBackgroundAndNotify;
        },
      },
    },
  });
  function tick() {
    $.NSRunLoop.currentRunLoop.runUntilDate(
      $.NSDate.dateWithTimeIntervalSinceNow(0.02),
    );
  }
  function text(data) {
    const value = $.NSString.alloc.initWithDataEncoding(
      data,
      $.NSUTF8StringEncoding,
    );
    if (isNil(value)) throw new Error("process_encoding");
    const decoded = ObjC.unwrap(value);
    if (typeof decoded !== "string") throw new Error("process_encoding");
    return decoded;
  }
  function spawn(executable, args, environment, cwd) {
    const task = $.NSTask.alloc.init;
    task.launchPath = executable;
    task.arguments = args;
    task.environment = environment;
    task.currentDirectoryPath = cwd;
    const input = $.NSPipe.pipe,
      output = $.NSPipe.pipe,
      errors = $.NSPipe.pipe;
    task.standardInput = input;
    task.standardOutput = output;
    task.standardError = errors;
    const observer = $.StickerInstallPipeObserverV1.alloc.init;
    const center = $.NSNotificationCenter.defaultCenter;
    function channel(pipe, discard) {
      const handle = pipe.fileHandleForReading;
      const state = {
        handle,
        discard,
        buffer: $.NSMutableData.data,
        total: 0,
        eof: false,
        failed: false,
        closed: false,
      };
      channels[String(handle.fileDescriptor)] = state;
      center.addObserverSelectorNameObject(
        observer,
        "readCompleted:",
        $.NSFileHandleReadCompletionNotification,
        handle,
      );
      return state;
    }
    const out = channel(output, false),
      err = channel(errors, true);
    let launched = false,
      closed = false;
    try {
      void task.launch;
      launched = true;
      void out.handle.readInBackgroundAndNotify;
      void err.handle.readInBackgroundAndNotify;
    } catch {
      try {
        close();
      } catch {
        throw new Error("process_start_cleanup_unverified");
      }
      throw new Error("process_start");
    }
    function check() {
      if (out.failed || err.failed) throw new Error("process_limit");
    }
    function close() {
      if (closed) return;
      closed = true;
      try {
        void input.fileHandleForWriting.closeFile;
      } catch {
        /* Already closed. */
      }
      let forced = false,
        failed = false;
      const attempt = (action) => {
        try {
          action();
        } catch {
          failed = true;
        }
      };
      const grace = Date.now() + 5000;
      while (launched && task.isRunning && Date.now() < grace) {
        try {
          tick();
        } catch {
          failed = true;
          break;
        }
      }
      if (launched && task.isRunning) {
        forced = true;
        attempt(() => {
          void task.terminate;
        });
      }
      const terminated = Date.now() + 1000;
      while (launched && task.isRunning && Date.now() < terminated) {
        try {
          tick();
        } catch {
          failed = true;
          break;
        }
      }
      if (launched && task.isRunning) {
        forced = true;
        attempt(() => {
          ObjC.bindFunction("kill", ["int", ["int", "int"]]);
          $.kill(Number(task.processIdentifier), 9);
        });
      }
      out.closed = true;
      err.closed = true;
      attempt(() => center.removeObserver(observer));
      delete channels[String(out.handle.fileDescriptor)];
      delete channels[String(err.handle.fileDescriptor)];
      for (const action of [
        () => {
          void out.handle.closeFile;
        },
        () => {
          void err.handle.closeFile;
        },
        () => out.buffer.setLength(0),
        () => err.buffer.setLength(0),
      ])
        attempt(action);
      if (forced || failed) throw new Error("process_cleanup_unverified");
    }
    return {
      write(value) {
        check();
        const data = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
        if (isNil(data) || Number(data.length) > 4096)
          throw new Error("rpc_write_limit");
        input.fileHandleForWriting.writeData(data);
      },
      read(deadline) {
        while (Date.now() < deadline) {
          check();
          const range = out.buffer.rangeOfDataOptionsRange(
            newline,
            0,
            $.NSMakeRange(0, Number(out.buffer.length)),
          );
          if (Number(range.location) !== Number($.NSNotFound)) {
            const end = Number(range.location) + 1;
            const value = text(
              out.buffer.subdataWithRange($.NSMakeRange(0, end)),
            );
            out.buffer.replaceBytesInRangeWithBytesLength(
              $.NSMakeRange(0, end),
              null,
              0,
            );
            return value;
          }
          if (out.eof) {
            if (Number(out.buffer.length)) {
              const value = text(out.buffer);
              out.buffer.setLength(0);
              return value;
            }
            return null;
          }
          tick();
        }
        throw new Error("rpc_timeout");
      },
      collect(deadline) {
        void input.fileHandleForWriting.closeFile;
        while (
          (task.isRunning || !out.eof || !err.eof) &&
          Date.now() < deadline
        ) {
          check();
          tick();
        }
        check();
        if (task.isRunning || !out.eof || !err.eof)
          throw new Error("process_timeout");
        return {
          status: Number(task.terminationStatus),
          text: text(out.buffer),
        };
      },
      close,
    };
  }
  function command(executable, args, environment, cwd, timeout = 30000) {
    const process = spawn(executable, args, environment, cwd);
    try {
      return process.collect(Date.now() + timeout);
    } finally {
      process.close();
    }
  }
  return { spawn, command, isNil };
})();
