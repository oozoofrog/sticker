// Synthetic native feasibility fixture only. No product integration.
globalThis.WindowProbePolicy = (function () {
  function origin(url) {
    if (typeof url !== "string" || /[^\x20-\x7e]|[\\\s]/.test(url)) return null;
    var match =
      /^http:\/\/(localhost|127\.0\.0\.1)(?::([1-9][0-9]{0,4}))?(?:[/?#]|$)/.exec(
        url,
      );
    if (!match) return null;
    var port = match[2] ? Number(match[2]) : 80;
    return port <= 65535 ? "http://" + match[1] + ":" + String(port) : null;
  }
  function navigation(input) {
    if (input.sourceOrigin !== input.origin || !input.mainFrame)
      return "cancel";
    if (
      input.download &&
      (origin(input.url) === input.origin ||
        (input.url.indexOf("blob:") === 0 &&
          origin(input.url.slice(5)) === input.origin))
    )
      return "download";
    if (origin(input.url) === input.origin) return "allow";
    var external =
      /^https?:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([1-9][0-9]{0,4}))?(?:[/?#]|$)/.exec(
        input.url,
      );
    if (
      input.link &&
      external &&
      (!external[2] || Number(external[2]) <= 65535) &&
      !/[^\x20-\x7e]|[\\\s]/.test(input.url)
    )
      return "external";
    return "cancel";
  }
  function once(callback) {
    var used = false;
    return function (value) {
      if (used) return false;
      used = true;
      callback(value);
      return true;
    };
  }
  return { origin: origin, navigation: navigation, once: once };
})();
