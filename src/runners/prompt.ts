import type { TaskContext } from "../types/index.js";

export interface PromptBuilderOptions {
  taskPrefix?: (issueRef: string) => string;
  codeReviewHint?: string;
}

/**
 * How a PR body references the issue: `#12`, or `owner/repo#12` when issues live in another repository.
 */
export function formatIssueRef(issueNumber: number, issueRepository?: string): string {
  return issueRepository ? `${issueRepository}#${issueNumber}` : `#${issueNumber}`;
}

/**
 * The ` -R owner/repo` flag `gh issue` commands need when issues live in another repository than the
 * worktree's (where `gh` would otherwise default to the code repository).
 */
export function issueRepoFlag(issueRepository?: string): string {
  return issueRepository ? ` -R ${issueRepository}` : "";
}

/**
 * Builds the canonical Guidelines & Protocol section for agent execution.
 */
export function buildGuidelines(
  context: TaskContext,
  codeReviewHint?: string,
): string {
  const {
    issue,
    baseBranch = "main",
    autoMerge = true,
    mergeMethod = "squash",
    issueRepository,
  } = context;
  const repoFlag = issueRepoFlag(issueRepository);
  const issueRef = formatIssueRef(issue.number, issueRepository);

  const mergeGuideline = autoMerge
    ? `- Once all tests, review, and CI checks pass, merge the Pull Request (e.g. \`gh pr merge --${mergeMethod} --delete-branch\`) to close the issue.`
    : `- Once all tests and CI checks pass, leave the Pull Request open for developer review and merge (do not auto-merge).`;

  const reviewText = codeReviewHint
    ? `Verify changes with tests and code review (${codeReviewHint}).`
    : `Verify changes with tests and code review.`;

  const issueRepoNote = issueRepository
    ? `> **Issue tracker**: this task's issue lives in \`${issueRepository}\`, not in this worktree's repository. Always pass \`-R ${issueRepository}\` to \`gh issue\` commands; pull requests are opened in this worktree's repository as usual.\n`
    : "";

  return `### Guidelines & Protocol
${issueRepoNote}1. **Feedback, Questions & Human Review**: If you encounter blocking ambiguities, require clarification, or decide that manual human review is required before merging:
   - Post your comment or question: \`gh issue comment ${issue.number}${repoFlag} --body "❓ **Agent Question**: <your question/explanation>"\`
   - Mark for developer feedback: \`gh issue edit ${issue.number}${repoFlag} --add-label "ready-for-human" --remove-label "ready-for-agent"\` (or \`--add-label "needs-info"\`).
   - **Immediately conclude execution and exit.** Do not guess or leave the ticket in an untagged open state.
2. **Follow-up Subtasks & Triage**: If you identify distinct out-of-scope work or follow-up subtasks:
   - No work can be enqueued to the agent without human consent. Never tag newly created follow-up tasks as \`ready-for-agent\` unless explicitly instructed.
   - Always create follow-up issues with the \`needs-triage\` label: \`gh issue create${repoFlag} --title "<title>" --body "Parent: #${issue.number}\\nBlocked by: #${issue.number}\\n\\n<details>\\n\\n### Proposed Solution & Reasoning\\n<if confident, explain why and detail your concern/reasoning for human review>" --label "needs-triage"\`
3. **Review, PR, Rebase & Merge**:
   - Review both the task description and any discussion/comments above before implementing (comments may contain triage notes, agent briefs, or follow-up decisions).
   - ${reviewText} If review and tests were already completed in a prior turn, do not repeat them redundantly.
   - Push your branch and open a Pull Request: \`gh pr create --title "<title>" --body "Closes ${issueRef}\\n\\n<summary>"\`
   - Rebase onto \`${baseBranch}\` and resolve any conflicts if necessary.
   ${mergeGuideline}`;
}

/**
 * Builds the standard runner prompt.
 * In continuation mode, redundant task descriptions, guidelines, and extra prompts are omitted
 * because they already exist in the active session transcript.
 */
export function buildRunnerPrompt(
  context: TaskContext,
  options?: PromptBuilderOptions,
): string {
  const { issue, isContinuation, userFeedback, extraPrompt } = context;
  const issueRef = issue.url || `#${issue.number}`;
  const prefix = options?.taskPrefix
    ? options.taskPrefix(issueRef)
    : `Implement the requested task for ${issueRef}.`;

  if (isContinuation && userFeedback) {
    return `${prefix}

You are continuing work on this task following clarification/steering from the developer.

### Developer Clarification & Steering
<developer_feedback>
${userFeedback}
</developer_feedback>

Please resume implementation and address the feedback.
`;
  }

  if (isContinuation) {
    return `${prefix}

Resume work on this task after a session pause. Continue from your previous state and finish implementing the task.
`;
  }

  let commentsSection = "";
  if (issue.comments && issue.comments.length > 0) {
    const formattedComments = issue.comments
      .filter((c) => c.body && c.body.trim())
      .map((c) => {
        const author = c.author?.login ? `@${c.author.login}` : "User";
        const date = c.createdAt ? ` (${c.createdAt})` : "";
        return `**${author}**${date}:\n${c.body.trim()}`;
      })
      .join("\n\n---\n\n");

    if (formattedComments) {
      commentsSection = `\n### Issue Discussion & Comments\n${formattedComments}\n`;
    }
  }

  const extraSection = extraPrompt
    ? `\n### Repository Instructions\n${extraPrompt.trim()}\n`
    : "";

  const guidelines = buildGuidelines(context, options?.codeReviewHint);

  return `${prefix}

### Task Description
${issue.body || "No description provided."}
${commentsSection}${extraSection}
${guidelines}
`;
}
