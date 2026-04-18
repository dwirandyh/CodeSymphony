import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { parsePatchFiles, SPLIT_WITH_NEWLINES } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import { queryKeys } from "../../lib/queryKeys";
import { fileContentsQueryOptions } from "./useFileContents";
import { gitDiffQueryOptions } from "./useGitDiff";

export type GitDiffReviewEntry = {
  file: FileDiffMetadata;
  stats: { additions: number; deletions: number };
};

export type GitDiffReviewResult = {
  entries: GitDiffReviewEntry[];
  diffLength: number;
  fileCount: number;
  fetchedFullContents: boolean;
  diffFetchDurationMs: number;
  parseDurationMs: number;
  contentFetchDurationMs: number;
  totalDurationMs: number;
};

function computeStats(file: FileDiffMetadata) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions.length;
        deletions += content.deletions.length;
      }
    }
  }
  return { additions, deletions };
}

async function fetchGitDiffReview(
  queryClient: QueryClient,
  worktreeId: string,
  selectedFilePath?: string,
): Promise<GitDiffReviewResult> {
  const fetchStartedAt = performance.now();
  const diffStartedAt = performance.now();
  const { diff } = await queryClient.fetchQuery({
    ...gitDiffQueryOptions(worktreeId, selectedFilePath ? { filePath: selectedFilePath } : undefined),
    staleTime: 0,
  });
  const diffFetchedAt = performance.now();
  const parseStartedAt = performance.now();
  const patches = parsePatchFiles(diff);
  const allFiles = patches.flatMap((patch) => patch.files);
  const parseCompletedAt = performance.now();
  const shouldFetchFullContents = Boolean(selectedFilePath);
  const fileFetchStartedAt = performance.now();

  if (shouldFetchFullContents && allFiles.length > 0) {
    await Promise.all(
      allFiles.map(async (file) => {
        try {
          const { oldContent, newContent } = await queryClient.fetchQuery({
            ...fileContentsQueryOptions(worktreeId, file.name),
            staleTime: 0,
          });
          file.oldLines = (oldContent ?? "").split(SPLIT_WITH_NEWLINES);
          file.newLines = (newContent ?? "").split(SPLIT_WITH_NEWLINES);
        } catch {
          // The diff still renders without expanded unchanged content.
        }
      }),
    );
  }

  const entries = allFiles.map((file) => ({
    file,
    stats: computeStats(file),
  }));
  const totalDurationMs = performance.now() - fetchStartedAt;
  const contentFetchDurationMs = shouldFetchFullContents ? performance.now() - fileFetchStartedAt : 0;

  return {
    entries,
    diffLength: diff.length,
    fileCount: allFiles.length,
    fetchedFullContents: shouldFetchFullContents,
    diffFetchDurationMs: Number((diffFetchedAt - diffStartedAt).toFixed(2)),
    parseDurationMs: Number((parseCompletedAt - parseStartedAt).toFixed(2)),
    contentFetchDurationMs: Number(contentFetchDurationMs.toFixed(2)),
    totalDurationMs: Number(totalDurationMs.toFixed(2)),
  };
}

export function gitDiffReviewQueryOptions(
  queryClient: QueryClient,
  worktreeId: string,
  selectedFilePath?: string,
) {
  return queryOptions({
    queryKey: queryKeys.worktrees.gitDiff(worktreeId, selectedFilePath),
    queryFn: () => fetchGitDiffReview(queryClient, worktreeId, selectedFilePath),
    retry: false,
  });
}

export function useGitDiffReview(worktreeId: string | null, selectedFilePath?: string | null) {
  const queryClient = useQueryClient();

  return useQuery({
    ...gitDiffReviewQueryOptions(queryClient, worktreeId ?? "", selectedFilePath ?? undefined),
    enabled: !!worktreeId,
  });
}
