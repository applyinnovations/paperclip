import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Eye, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import type { Agent, Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export type ExecutionStageDecisionAction = "approve" | "request_changes";

type ExecutionStageIssue = Pick<Issue, "id" | "companyId" | "executionState">;

export function canActOnPendingExecutionStage(
  issue: Pick<Issue, "executionState"> | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  const executionState = issue?.executionState;
  if (!executionState || executionState.status !== "pending") {
    return false;
  }
  if (
    executionState.currentStageType !== "approval" &&
    executionState.currentStageType !== "review"
  ) {
    return false;
  }
  if (executionState.currentParticipant?.type !== "user") {
    return false;
  }
  return Boolean(
    currentUserId &&
      executionState.currentParticipant.userId === currentUserId,
  );
}

export interface ExecutionStageDecisionCardProps {
  issue: ExecutionStageIssue;
  currentUserId: string | null | undefined;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
  userLabelMap?: ReadonlyMap<string, string> | Record<string, string> | null;
  onResolved?: (action: ExecutionStageDecisionAction) => void;
  className?: string;
}

export function ExecutionStageDecisionCard({
  issue,
  currentUserId,
  agentMap,
  userLabelMap,
  onResolved,
  className,
}: ExecutionStageDecisionCardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [note, setNote] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const executionState = issue.executionState;
  const canAct = canActOnPendingExecutionStage(issue, currentUserId);
  const stageType =
    executionState?.currentStageType === "review" ? "review" : "approval";

  const decide = useMutation({
    mutationFn: (action: ExecutionStageDecisionAction) => {
      const trimmedNote = note.trim();
      if (action === "request_changes") {
        return issuesApi.update(issue.id, {
          status: "in_progress",
          comment: trimmedNote,
        });
      }
      return issuesApi.update(issue.id, {
        status: "done",
        comment:
          trimmedNote ||
          (stageType === "approval" ? "Approved." : "Review approved."),
      });
    },
    onMutate: () => {
      setErrorMessage(null);
    },
    onSuccess: (_result, action) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.issues.detail(issue.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.issues.comments(issue.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.issues.activity(issue.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(issue.companyId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.attention(issue.companyId),
      });
      setNote("");
      setErrorMessage(null);
      pushToast({
        title:
          action === "approve"
            ? stageType === "approval"
              ? "Approval recorded."
              : "Review approved."
            : "Changes requested — returned to assignee.",
        tone: "success",
      });
      onResolved?.(action);
    },
    onError: (error) => {
      const message =
        error instanceof Error
          ? error.message
          : "Could not record decision. Please try again.";
      setErrorMessage(message);
      pushToast({
        title: "Could not record decision",
        body: message,
        tone: "error",
      });
    },
  });

  if (!canAct || !executionState) {
    return null;
  }

  const isApproval = stageType === "approval";
  const Icon = isApproval ? ShieldCheck : Eye;
  const returnAssignee = executionState.returnAssignee ?? null;
  const returnAssigneeLabel = returnAssignee
    ? returnAssignee.type === "agent"
      ? (returnAssignee.agentId
          ? (agentMap?.get(returnAssignee.agentId)?.name ?? null)
          : null)
      : formatAssigneeUserLabel(
          returnAssignee.userId,
          currentUserId,
          userLabelMap,
        )
    : null;

  const title = isApproval ? "Approval required" : "Review required";
  const subtitle = returnAssignee
    ? isApproval
      ? returnAssigneeLabel
        ? `Approve to advance this issue, or request changes to send it back to ${returnAssigneeLabel}.`
        : "Approve to advance this issue, or request changes to send it back to the assignee."
      : returnAssigneeLabel
        ? `Approve this review to advance the issue, or request changes to send it back to ${returnAssigneeLabel}.`
        : "Approve this review to advance the issue, or request changes to send it back to the assignee."
    : isApproval
      ? "Approve to advance this issue."
      : "Approve this review to advance this issue.";

  const pending = decide.isPending;
  const noteEmpty = note.trim().length === 0;
  const runningAction = pending ? decide.variables : null;

  return (
    <div
      data-testid="execution-stage-decision-card"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3.5",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className="mt-0.5 h-4 w-4 shrink-0 text-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <p className="text-xs leading-5 text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      <Textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Add a note — optional to approve, required to request changes…"
        className="min-h-16 text-sm"
        data-testid="execution-stage-decision-note"
        disabled={pending}
      />

      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {returnAssignee ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-amber-400/70 text-amber-900 hover:bg-amber-100 dark:border-amber-500/50 dark:text-amber-100 dark:hover:bg-amber-500/15"
            disabled={pending || noteEmpty}
            title={noteEmpty ? "Add a note to request changes" : undefined}
            onClick={() => decide.mutate("request_changes")}
            data-testid="execution-stage-request-changes"
          >
            {runningAction === "request_changes" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Request changes
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          className="bg-green-700 text-white hover:bg-green-600"
          disabled={pending}
          onClick={() => decide.mutate("approve")}
          data-testid="execution-stage-approve"
        >
          {runningAction === "approve" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Approve
        </Button>
      </div>
    </div>
  );
}
