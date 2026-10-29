import type { GithubProvider } from "../server/features/github.js";
import { GithubReadError } from "../server/github-read-client.js";
/** Deliberate deterministic browser fixtures; no transport, credentials or operator configuration. */
export function githubBrowserFixture(): GithubProvider {
  const attempts = new Map<string, number>();
  return {
    enabled: true,
    client: () => ({
      verify: () => Promise.resolve(),
      inspect: (target) => {
        const count = (attempts.get(target.url) ?? 0) + 1;
        attempts.set(target.url, count);
        if (
          target.kind === "pr" &&
          (target.number === 6 || (target.number === 7 && count > 1))
        )
          return Promise.reject(
            new GithubReadError(target.number === 6 ? "RATE_LIMIT" : "NETWORK"),
          );
        const number = target.kind === "pr" ? target.number : 1;
        const sha = target.kind === "commit" ? target.sha : "a".repeat(40);
        const changed = number === 5;
        const ci =
          number === 2
            ? "failure"
            : number === 3
              ? "pending"
              : number === 4 || changed
                ? "unknown"
                : "success";
        return Promise.resolve({
          headSha: changed ? "b".repeat(40) : sha,
          snapshotSha: sha,
          ci,
          snapshotCi: changed ? "success" : ci,
          stale: changed,
          complete: true,
          checkCount: 1,
          statusCount: 1,
        });
      },
    }),
  };
}
