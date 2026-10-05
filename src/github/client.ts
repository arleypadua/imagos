import { execa } from 'execa';
import { ActivityLogger } from '../logger/index.js';
import type { GitHubIssue, NativeIssueRelation } from '../types/index.js';

const MAX_ISSUE_PAGES = 20;
const FULL_PAGE_SIZE = 100;
/** A GraphQL page of 25 issues with their nested connections costs 1 point, against ~5 for a page of 100. */
const INCREMENTAL_PAGE_SIZE = 25;
const DEFAULT_FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 5 * 60 * 1000;
const SECONDARY_RATE_LIMIT_BACKOFF_MS = 60 * 1000;

interface IssueCache {
  key: string;
  issues: Map<number, GitHubIssue>;
  lastSyncAt?: number;
  lastFullSyncAt?: number;
}

/**
 * Whether an error from a `gh` call is GitHub refusing the request for exceeding a (primary or secondary) rate limit.
 */
export function isRateLimitError(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string; stdout?: string } | undefined;
  const text = `${e?.message ?? ''}\n${e?.stderr ?? ''}\n${e?.stdout ?? ''}`;
  return /rate limit|RATE_LIMIT/i.test(text);
}

function mapGraphQLRelation(node: any): NativeIssueRelation {
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    repository: node.repository?.nameWithOwner,
  };
}

function mapGraphQLIssue(node: any): GitHubIssue {
  return {
    number: node.number,
    title: node.title,
    body: node.body || '',
    state: node.state,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    labels: (node.labels?.nodes || []).map((l: any) => ({
      name: l.name,
      color: l.color,
      description: l.description,
    })),
    repository: node.repository?.nameWithOwner,
    parent: node.parent
      ? { number: node.parent.number, title: node.parent.title, repository: node.parent.repository?.nameWithOwner }
      : undefined,
    blockedBy: (node.blockedBy?.nodes || []).map(mapGraphQLRelation),
    blocking: (node.blocking?.nodes || []).map(mapGraphQLRelation),
    subIssues: (node.subIssues?.nodes || []).map(mapGraphQLRelation),
    comments: (node.comments?.nodes || []).map((c: any) => ({
      id: c.id,
      author: {
        login: c.author?.login || '',
      },
      body: c.body || '',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  };
}

/**
 * Options for configuring a {@link GitHubClient} instance.
 */
export interface GitHubClientOptions {
  /**
   * Target repository in `owner/repo` format (e.g. `octocat/Hello-World`).
   */
  repository?: string;
  /**
   * Working directory from which to run `gh` CLI commands.
   * @defaultValue `process.cwd()`
   */
  cwd?: string;
  /**
   * How often {@link GitHubClient.fetchIssues} re-reads every issue instead of only the ones updated since the last poll.
   * @defaultValue 15 minutes
   */
  fullSyncIntervalMs?: number;
}

/**
 * Options for creating a new pull request via {@link GitHubClient.createPR} or {@link GitHubClient.createPullRequest}.
 */
export interface CreatePROptions {
  /** Title of the pull request */
  title: string;
  /** Markdown body / description of the pull request */
  body: string;
  /** Name of the head branch containing the changes */
  head: string;
  /** Name of the base branch to merge into (e.g. `main`) */
  base: string;
  /** Whether to create the pull request as a draft */
  draft?: boolean;
}

/**
 * Options for modifying labels on an issue via {@link GitHubClient.editIssueLabels}.
 */
export interface EditIssueLabelsOptions {
  /** Array of label names to add to the issue */
  add?: string[];
  /** Array of label names to remove from the issue */
  remove?: string[];
}

/**
 * Options for merging a pull request via {@link GitHubClient.mergePullRequest}.
 */
export interface MergePROptions {
  /**
   * Merge strategy to use (`'squash'`, `'merge'`, or `'rebase'`).
   * @defaultValue `'squash'`
   */
  method?: 'squash' | 'merge' | 'rebase';
  /**
   * Whether to delete the remote head branch after merging.
   * @defaultValue `true`
   */
  deleteBranch?: boolean;
}

/**
 * Client for interacting with GitHub via the GitHub CLI (`gh`).
 * Provides typed methods for issue tracking, labels, comments, reactions, and pull requests.
 */
export class GitHubClient {
  private repository?: string;
  private cwd: string;
  private fullSyncIntervalMs: number;
  private cache?: IssueCache;
  private rateLimitedUntil = 0;

  /**
   * Initializes a new instance of the {@link GitHubClient}.
   *
   * @param options - Configuration options including default repository and working directory.
   */
  constructor(options: GitHubClientOptions = {}) {
    this.repository = options.repository;
    this.cwd = options.cwd ?? process.cwd();
    this.fullSyncIntervalMs = options.fullSyncIntervalMs ?? DEFAULT_FULL_SYNC_INTERVAL_MS;
  }

  /**
   * Sets or updates the default repository for GitHub CLI operations.
   *
   * @param repo - The target repository in `owner/repo` format (e.g. `octocat/Hello-World`).
   */
  public setRepository(repo: string): void {
    this.repository = repo;
    this.cache = undefined;
  }

  /**
   * Gets the currently configured default repository.
   *
   * @returns The repository string in `owner/repo` format, or `undefined` if none is configured.
   */
  public getRepository(): string | undefined {
    return this.repository;
  }

  /**
   * Returns repository CLI arguments (`['--repo', repo]`) if a repository is specified.
   *
   * @param overrideRepo - Optional repository override in `owner/repo` format.
   * @returns Array with `--repo` flags or empty array if no repository is configured.
   */
  private repoArgs(overrideRepo?: string): string[] {
    const repo = overrideRepo ?? this.repository;
    return repo ? ['--repo', repo] : [];
  }

  /**
   * Checks whether the current environment is authenticated with GitHub via the `gh` CLI.
   *
   * @returns A promise resolving to `true` if `gh auth status` succeeds, `false` otherwise.
   */
  public async checkAuth(): Promise<boolean> {
    try {
      await execa('gh', ['auth', 'status'], { cwd: this.cwd });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves the repository owner and name from the configured repository or current working directory.
   */
  public async getRepoOwnerAndName(overrideRepo?: string): Promise<{ owner: string; repo: string } | undefined> {
    const targetRepo = overrideRepo ?? this.repository;
    if (targetRepo && targetRepo.includes('/')) {
      const [owner, repo] = targetRepo.split('/');
      if (owner && repo) {
        return { owner, repo };
      }
    }

    try {
      const { stdout } = await execa('gh', ['repo', 'view', ...(targetRepo ? [targetRepo] : []), '--json', 'owner,name'], {
        cwd: this.cwd,
      });
      const data = JSON.parse(stdout);
      if (data.owner?.login && data.name) {
        return { owner: data.owner.login, repo: data.name };
      }
    } catch {
      // Ignore error and return undefined
    }

    return undefined;
  }

  /**
   * Fetches issues via GitHub GraphQL API, including native relationships (blockedBy, blocking, parent, subIssues).
   *
   * Pages through the whole repository. A single unpaginated page silently drops the oldest issues
   * once a repo passes the page size, which both hides them from the scheduler and makes their
   * closed blockers read as missing — and a missing blocker leaves its dependents blocked forever.
   *
   * @param since - When set, only issues updated at or after this ISO timestamp are returned
   *   (an incremental sync), in smaller pages since few issues change between polls.
   */
  public async fetchIssuesViaGraphQL(owner: string, repoName: string, since?: string): Promise<GitHubIssue[]> {
    const query = `
      query($owner: String!, $repo: String!, $after: String, $first: Int!, $since: DateTime) {
        repository(owner: $owner, name: $repo) {
          issues(first: $first, after: $after, states: [OPEN, CLOSED], filterBy: {since: $since}, orderBy: {field: ${since ? 'UPDATED_AT' : 'CREATED_AT'}, direction: DESC}) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              number
              title
              body
              state
              url
              createdAt
              updatedAt
              labels(first: 50) {
                nodes {
                  name
                  color
                  description
                }
              }
              repository {
                nameWithOwner
              }
              parent {
                number
                title
                repository {
                  nameWithOwner
                }
              }
              blockedBy(first: 50) {
                nodes {
                  number
                  title
                  state
                  repository {
                    nameWithOwner
                  }
                }
              }
              blocking(first: 50) {
                nodes {
                  number
                  title
                  state
                  repository {
                    nameWithOwner
                  }
                }
              }
              subIssues(first: 100) {
                nodes {
                  number
                  title
                  state
                  repository {
                    nameWithOwner
                  }
                }
              }
              comments(first: 50) {
                nodes {
                  id
                  author {
                    login
                  }
                  body
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      }
    `;

    const issues: GitHubIssue[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repoName}`,
        '-F',
        `first=${since ? INCREMENTAL_PAGE_SIZE : FULL_PAGE_SIZE}`,
        ...(since ? ['-f', `since=${since}`] : []),
        ...(cursor ? ['-f', `after=${cursor}`] : []),
      ];

      const { stdout } = await execa('gh', args, { cwd: this.cwd });

      const data = JSON.parse(stdout);
      const connection = data.data?.repository?.issues;
      const issueNodes = connection?.nodes;
      if (!Array.isArray(issueNodes)) {
        throw new Error('GraphQL response did not contain repository issues');
      }

      issues.push(...issueNodes.map((node: any) => mapGraphQLIssue(node)));

      if (!connection.pageInfo?.hasNextPage || !connection.pageInfo?.endCursor) {
        return issues;
      }
      cursor = connection.pageInfo.endCursor;
    }

    return issues;
  }

  /**
   * Fetches issues via standard gh issue list CLI command.
   */
  public async fetchIssuesViaCli(repo?: string): Promise<GitHubIssue[]> {
    const fields = 'number,title,body,state,labels,url,createdAt,updatedAt,comments';
    const args = ['issue', 'list', '--state', 'all', '--limit', String(MAX_ISSUE_PAGES * 100), ...this.repoArgs(repo), '--json', fields];

    const { stdout } = await execa('gh', args, { cwd: this.cwd });
    if (!stdout.trim()) {
      return [];
    }

    try {
      const issues: GitHubIssue[] = JSON.parse(stdout);
      return issues;
    } catch (err) {
      throw new Error(`Failed to parse gh issue list output: ${err}\nOutput was: ${stdout}`);
    }
  }

  /**
   * Fetches issues from the repository using the GitHub GraphQL API, falling back to GitHub CLI list.
   *
   * Issues are cached per repository: the first call (and one every {@link GitHubClientOptions.fullSyncIntervalMs})
   * pages through the whole repository, while calls in between only ask for issues updated since the previous
   * sync and merge them into the cache. A poll therefore costs one small GraphQL page instead of the whole
   * repository, which on a repo with ~1000 issues is the difference between staying well inside the hourly
   * GraphQL budget and exhausting it. The periodic full sync picks up the few edits that do not bump an issue's
   * `updatedAt` (e.g. relationship changes made from the other side) and drops deleted/transferred issues.
   *
   * When GitHub reports a rate limit, the client stops calling GraphQL until the limit resets and serves the
   * cached issues meanwhile. It never falls back to `gh issue list` in that case, since that also runs on GraphQL.
   *
   * @param repo - Optional repository override in `owner/repo` format. If omitted, the configured default repository is used.
   * @returns A promise resolving to an array of {@link GitHubIssue} objects, newest issue number first.
   * @throws {Error} If the command fails or if the command output cannot be parsed as JSON.
   */
  public async fetchIssues(repo?: string): Promise<GitHubIssue[]> {
    const repoInfo = await this.getRepoOwnerAndName(repo);
    if (repoInfo) {
      const cacheKey = `${repoInfo.owner}/${repoInfo.repo}`;
      if (this.cache?.key !== cacheKey) {
        this.cache = { key: cacheKey, issues: new Map() };
      }
      const cache = this.cache;

      if (this.rateLimitedUntil > Date.now()) {
        if (cache.lastSyncAt !== undefined) {
          return this.cachedIssues(cache);
        }
        throw new Error(`GitHub API rate limit exceeded; retrying after ${new Date(this.rateLimitedUntil).toLocaleTimeString()}`);
      }

      const syncStartedAt = Date.now();
      const isFullSync =
        cache.lastSyncAt === undefined ||
        cache.lastFullSyncAt === undefined ||
        syncStartedAt - cache.lastFullSyncAt >= this.fullSyncIntervalMs;

      try {
        if (isFullSync) {
          const issues = await this.fetchIssuesViaGraphQL(repoInfo.owner, repoInfo.repo);
          cache.issues = new Map(issues.map((issue) => [issue.number, issue]));
          cache.lastFullSyncAt = syncStartedAt;
        } else {
          // Overlap the window a little so clock skew between this machine and GitHub cannot lose an update.
          const since = new Date(cache.lastSyncAt! - SYNC_OVERLAP_MS).toISOString();
          const changed = await this.fetchIssuesViaGraphQL(repoInfo.owner, repoInfo.repo, since);
          for (const issue of changed) {
            cache.issues.set(issue.number, issue);
          }
        }
        cache.lastSyncAt = syncStartedAt;
        return this.cachedIssues(cache);
      } catch (err) {
        if (isRateLimitError(err)) {
          this.rateLimitedUntil = await this.getGraphQLRateLimitReset();
          const retryAt = new Date(this.rateLimitedUntil).toLocaleTimeString();
          if (cache.lastSyncAt !== undefined) {
            ActivityLogger.warn(`GitHub API rate limit exceeded; showing cached issues until ${retryAt}.`);
            return this.cachedIssues(cache);
          }
          throw new Error(`GitHub API rate limit exceeded; retrying after ${retryAt}`);
        }
        // Fallback to CLI
      }
    }

    return this.fetchIssuesViaCli(repo);
  }

  /**
   * Forgets the cached issues so the next {@link fetchIssues} call performs a full sync.
   */
  public invalidateIssueCache(): void {
    this.cache = undefined;
  }

  private cachedIssues(cache: IssueCache): GitHubIssue[] {
    return [...cache.issues.values()].sort((a, b) => b.number - a.number);
  }

  /**
   * Returns when the GraphQL rate limit resets (epoch ms). The `rate_limit` REST endpoint does not count
   * against any limit, so asking it is free; if it fails, back off for a fixed interval instead.
   */
  private async getGraphQLRateLimitReset(): Promise<number> {
    const fallback = Date.now() + RATE_LIMIT_FALLBACK_BACKOFF_MS;
    try {
      const { stdout } = await execa('gh', ['api', 'rate_limit', '--jq', '.resources.graphql'], { cwd: this.cwd });
      const graphql = JSON.parse(stdout);
      // Still budget left means a secondary (per-minute) limit tripped; those clear within about a minute.
      if (typeof graphql?.remaining === 'number' && graphql.remaining > 0) {
        return Date.now() + SECONDARY_RATE_LIMIT_BACKOFF_MS;
      }
      if (typeof graphql?.reset === 'number') {
        return Math.max(graphql.reset * 1000, Date.now() + SECONDARY_RATE_LIMIT_BACKOFF_MS);
      }
    } catch {
      // Use the fixed backoff
    }
    return fallback;
  }

  /**
   * Fetches details of a specific issue by its issue number using the GitHub CLI.
   *
   * @param issueNumber - The issue number to view.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise resolving to the {@link GitHubIssue} details.
   * @throws {Error} If the `gh issue view` command fails or if output cannot be parsed as JSON.
   */
  public async viewIssue(issueNumber: number, repo?: string): Promise<GitHubIssue> {
    const fields = 'number,title,body,state,labels,url,createdAt,updatedAt,comments';
    const args = ['issue', 'view', String(issueNumber), ...this.repoArgs(repo), '--json', fields];

    const { stdout } = await execa('gh', args, { cwd: this.cwd });
    return JSON.parse(stdout) as GitHubIssue;
  }

  /**
   * Fetches details of a specific issue by its issue number.
   * Alias for {@link viewIssue}.
   *
   * @param issueNumber - The issue number to fetch.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise resolving to the {@link GitHubIssue} details.
   * @throws {Error} If the `gh issue view` command fails or if output cannot be parsed as JSON.
   */
  public async fetchIssue(issueNumber: number, repo?: string): Promise<GitHubIssue> {
    return this.viewIssue(issueNumber, repo);
  }

  /**
   * Ensures that a label exists on the repository, creating it with a predefined color if missing.
   * Fails silently if the label already exists or if the caller lacks permission to create labels.
   *
   * @param labelName - The name of the label to ensure.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise that resolves when label creation is completed or handled.
   */
  public async ensureLabelExists(labelName: string, repo?: string): Promise<void> {
    try {
      const colors: Record<string, string> = {
        'ready-for-agent': '0E8A16',
        'needs-info': 'D93F0B',
        'ready-for-human': 'B60205',
        'human-task': 'B60205',
        'human-tasks': 'B60205',
        'needs-triage': 'FBCA04',
        'wontfix': 'FFFFFF',
      };
      const descriptions: Record<string, string> = {
        'ready-for-agent': 'Queued for autonomous agent execution',
        'needs-info': 'Requires more information from developer',
        'ready-for-human': 'Ready for human review, manual task, or merge',
        'human-task': 'Manual task assigned to human developer',
        'human-tasks': 'Manual task assigned to human developer',
        'needs-triage': 'Pending triage / specification',
        'wontfix': 'Will not be implemented',
      };
      const color = colors[labelName] || 'EDEDED';
      const description = descriptions[labelName];
      const args = ['label', 'create', labelName, ...this.repoArgs(repo), '--color', color, '--force'];
      if (description) {
        args.push('--description', description);
      }
      await execa('gh', args, {
        cwd: this.cwd,
      });
    } catch {
      // Label may already exist or lack permission
    }
  }

  /**
   * Ensures that multiple labels exist on the repository.
   *
   * @param labels - Array of label names or a Record of label name mappings to ensure.
   * @param repo - Optional repository override in `owner/repo` format.
   */
  public async ensureLabelsExist(
    labels: string[] | Record<string, string>,
    repo?: string
  ): Promise<void> {
    const labelList = Array.isArray(labels) ? labels : Object.values(labels);
    for (const label of labelList) {
      if (label && typeof label === 'string') {
        await this.ensureLabelExists(label, repo);
      }
    }
  }

  /**
   * Adds and/or removes labels from a GitHub issue.
   * Automatically attempts to create any missing labels if label addition/removal fails and retries once.
   *
   * @param issueNumber - The issue number whose labels should be modified.
   * @param options - Object specifying labels to add and/or remove.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise that resolves when the issue labels have been updated.
   * @throws {Error} If the `gh issue edit` command fails and the error is not recovered by label creation.
   */
  public async editIssueLabels(
    issueNumber: number,
    options: EditIssueLabelsOptions,
    repo?: string
  ): Promise<void> {
    const args = ['issue', 'edit', String(issueNumber), ...this.repoArgs(repo)];

    if (options.add && options.add.length > 0) {
      for (const label of options.add) {
        args.push('--add-label', label);
      }
    }

    if (options.remove && options.remove.length > 0) {
      for (const label of options.remove) {
        args.push('--remove-label', label);
      }
    }

    try {
      await execa('gh', args, { cwd: this.cwd });
    } catch (err: any) {
      // If label not found, try creating any missing labels (both added and removed) and retry
      const allLabels = [...(options.add || []), ...(options.remove || [])];
      for (const label of allLabels) {
        await this.ensureLabelExists(label, repo);
      }
      try {
        await execa('gh', args, { cwd: this.cwd });
        return;
      } catch (retryErr: any) {
        // If removal still fails (e.g. lack of permission to create labels), try applying add-only labels
        if (options.add && options.add.length > 0 && options.remove && options.remove.length > 0) {
          try {
            const addOnlyArgs = ['issue', 'edit', String(issueNumber), ...this.repoArgs(repo)];
            for (const label of options.add) {
              addOnlyArgs.push('--add-label', label);
            }
            await execa('gh', addOnlyArgs, { cwd: this.cwd });
            return;
          } catch {
            // Ignore and fall through to warning log
          }
        }
        // Log failure gracefully without crashing caller
        ActivityLogger.warn(`Warning: Could not update labels for issue #${issueNumber}: ${retryErr.message || err.message}`);
      }
    }
  }

  /**
   * Adds a markdown comment to a GitHub issue.
   *
   * @param issueNumber - The number of the issue to comment on.
   * @param body - The markdown content of the comment.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise that resolves when the comment is successfully added.
   * @throws {Error} If the `gh issue comment` command fails (e.g. network failure, invalid issue, or insufficient permissions).
   */
  public async addComment(issueNumber: number, body: string, repo?: string): Promise<void> {
    const args = ['issue', 'comment', String(issueNumber), ...this.repoArgs(repo), '--body', body];
    await execa('gh', args, { cwd: this.cwd });
  }

  /**
   * Adds an emoji reaction to a comment using either the GitHub GraphQL API or REST API.
   * Fails silently (best-effort) if the reaction cannot be added due to permissions or network issues.
   *
   * @param commentId - The ID of the comment (either a GraphQL node ID starting with `IC_` or a numeric REST ID).
   * @param content - The reaction type to apply (`'EYES'`, `'ROCKET'`, or `'THUMBS_UP'`). Defaults to `'EYES'`.
   * @returns A promise that resolves when the reaction request completes.
   */
  public async addCommentReaction(
    commentId: string,
    content: 'EYES' | 'ROCKET' | 'THUMBS_UP' = 'EYES'
  ): Promise<void> {
    try {
      if (commentId.startsWith('IC_') || commentId.length > 15) {
        const query = `mutation($subjectId: ID!, $content: ReactionContent!) {
          addReaction(input: { subjectId: $subjectId, content: $content }) {
            reaction { content }
          }
        }`;
        await execa(
          'gh',
          ['api', 'graphql', '-f', `query=${query}`, '-F', `subjectId=${commentId}`, '-F', `content=${content}`],
          { cwd: this.cwd }
        );
      } else {
        const restContent = content === 'EYES' ? 'eyes' : content === 'ROCKET' ? 'rocket' : '+1';
        const endpoint = this.repository
          ? `repos/${this.repository}/issues/comments/${commentId}/reactions`
          : `repos/:owner/:repo/issues/comments/${commentId}/reactions`;
        await execa('gh', ['api', endpoint, '-f', `content=${restContent}`], { cwd: this.cwd });
      }
    } catch {
      // Best-effort reaction; non-fatal if permissions or network fail
    }
  }

  /**
   * Closes a GitHub issue, optionally adding a comment before closing.
   *
   * @param issueNumber - The number of the issue to close.
   * @param comment - Optional closing comment to post before closing the issue.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise that resolves when the issue is closed.
   * @throws {Error} If adding the comment or closing the issue via `gh issue close` fails.
   */
  public async closeIssue(issueNumber: number, comment?: string, repo?: string): Promise<void> {
    if (comment) {
      await this.addComment(issueNumber, comment, repo);
    }
    const args = ['issue', 'close', String(issueNumber), ...this.repoArgs(repo)];
    await execa('gh', args, { cwd: this.cwd });
  }

  /**
   * Creates a new pull request on GitHub.
   *
   * @param options - Pull request configuration options.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise resolving to an object containing the PR URL and extracted PR number.
   * @throws {Error} If the `gh pr create` command fails (e.g. branch missing, no commits, or PR already exists).
   */
  public async createPR(
    options: CreatePROptions,
    repo?: string
  ): Promise<{ url: string; number: number }> {
    const args = [
      'pr',
      'create',
      ...this.repoArgs(repo),
      '--title',
      options.title,
      '--body',
      options.body,
      '--head',
      options.head,
      '--base',
      options.base,
    ];

    if (options.draft) {
      args.push('--draft');
    }

    const { stdout } = await execa('gh', args, { cwd: this.cwd });
    const prUrl = stdout.trim();
    // Extract PR number from url (e.g. https://github.com/owner/repo/pull/123)
    const match = prUrl.match(/\/pull\/(\d+)$/);
    const prNumber = match && match[1] ? parseInt(match[1], 10) : 0;

    return { url: prUrl, number: prNumber };
  }

  /**
   * Creates a new pull request on GitHub.
   * Alias for {@link createPR}.
   *
   * @param options - Pull request configuration options.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise resolving to an object containing the PR URL and extracted PR number.
   * @throws {Error} If the `gh pr create` command fails (e.g. branch missing, no commits, or PR already exists).
   */
  public async createPullRequest(
    options: CreatePROptions,
    repo?: string
  ): Promise<{ url: string; number: number }> {
    return this.createPR(options, repo);
  }

  /**
   * Merges a pull request using the specified merge strategy and optionally deletes the branch.
   * Attempts auto-merge first; falls back to direct merge if auto-merge is not supported.
   *
   * @param prNumberOrBranch - The PR number (e.g. `123`) or branch name to merge.
   * @param method - The merge strategy to use (`'squash'`, `'merge'`, or `'rebase'`). Defaults to `'squash'`.
   * @param deleteBranch - Whether to delete the remote head branch after merging. Defaults to `true`.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise that resolves when the merge command completes.
   * @throws {Error} If the `gh pr merge` command fails on both auto-merge and direct merge attempts.
   */
  public async mergePR(
    prNumberOrBranch: number | string,
    method: 'squash' | 'merge' | 'rebase' = 'squash',
    deleteBranch: boolean = true,
    repo?: string
  ): Promise<void> {
    const args = [
      'pr',
      'merge',
      String(prNumberOrBranch),
      ...this.repoArgs(repo),
      `--${method}`,
      '--auto',
    ];

    if (deleteBranch) {
      args.push('--delete-branch');
    }

    try {
      await execa('gh', args, { cwd: this.cwd });
    } catch {
      // If --auto fails (e.g. branch protection does not require checks), try direct merge
      const fallbackArgs = [
        'pr',
        'merge',
        String(prNumberOrBranch),
        ...this.repoArgs(repo),
        `--${method}`,
      ];
      if (deleteBranch) {
        fallbackArgs.push('--delete-branch');
      }
      await execa('gh', fallbackArgs, { cwd: this.cwd });
    }
  }

  /**
   * Merges a pull request using the specified merge options or method.
   * Convenience wrapper / alias for {@link mergePR}.
   *
   * @param prNumber - The PR number or branch name to merge.
   * @param options - Merge options object or merge strategy string (`'squash'`, `'merge'`, `'rebase'`).
   * @param deleteBranch - Whether to delete the remote head branch after merging (used when `options` is a string or omitted).
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise that resolves when the merge command completes.
   * @throws {Error} If the `gh pr merge` command fails.
   */
  public async mergePullRequest(
    prNumber: number | string,
    options?: MergePROptions | 'squash' | 'merge' | 'rebase',
    deleteBranch: boolean = true,
    repo?: string
  ): Promise<void> {
    if (typeof options === 'object' && options !== null) {
      return this.mergePR(prNumber, options.method ?? 'squash', options.deleteBranch ?? true, repo);
    }
    return this.mergePR(prNumber, options ?? 'squash', deleteBranch, repo);
  }

  /**
   * Finds an existing pull request associated with the specified head branch name.
   * Returns `undefined` if no pull request is found or if the query fails.
   *
   * @param branchName - The head branch name to search for.
   * @param repo - Optional repository override in `owner/repo` format.
   * @returns A promise resolving to PR info `{ url, number, state }` or `undefined` if not found.
   */
  public async findPRForBranch(
    branchName: string,
    repo?: string
  ): Promise<{ url: string; number: number; state: string } | undefined> {
    try {
      const args = ['pr', 'list', '--head', branchName, '--state', 'all', ...this.repoArgs(repo), '--json', 'number,url,state'];
      const { stdout } = await execa('gh', args, { cwd: this.cwd });
      if (!stdout.trim()) return undefined;
      const prs = JSON.parse(stdout);
      if (Array.isArray(prs) && prs.length > 0) {
        return prs[0];
      }
    } catch {
      // Best effort
    }
    return undefined;
  }
}

